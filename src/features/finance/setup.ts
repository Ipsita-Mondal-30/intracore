import { z } from "zod";
import { AccountType, BankAccountKind, PeriodStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { companySettings } from "@/lib/settings";
import { MAPPING_KEYS, type MappingKey } from "@/features/finance/ledger";

type Db = Prisma.TransactionClient;

/**
 * Starter chart of accounts (Indian layout). Review with your accountant; accounts can
 * be renamed, added or deactivated, and mappings changed, after setup.
 */
const CHART: { code: string; name: string; type: AccountType; group?: boolean; parent?: string }[] = [
  { code: "1000", name: "Current Assets", type: "ASSET", group: true },
  { code: "1100", name: "Cash in Hand", type: "ASSET", parent: "1000" },
  { code: "1200", name: "Bank Accounts", type: "ASSET", group: true, parent: "1000" },
  { code: "1210", name: "Primary Bank", type: "ASSET", parent: "1200" },
  { code: "1300", name: "Accounts Receivable", type: "ASSET", parent: "1000" },
  { code: "1400", name: "Inventory", type: "ASSET", parent: "1000" },
  { code: "1450", name: "Work in Progress", type: "ASSET", parent: "1000" },
  { code: "1500", name: "Input CGST", type: "ASSET", parent: "1000" },
  { code: "1510", name: "Input SGST", type: "ASSET", parent: "1000" },
  { code: "1520", name: "Input IGST", type: "ASSET", parent: "1000" },
  { code: "1600", name: "Advances and Deposits", type: "ASSET", parent: "1000" },
  { code: "1700", name: "Fixed Assets", type: "ASSET", group: true },
  { code: "1710", name: "Plant and Equipment", type: "ASSET", parent: "1700" },
  { code: "2000", name: "Current Liabilities", type: "LIABILITY", group: true },
  { code: "2100", name: "Accounts Payable", type: "LIABILITY", parent: "2000" },
  { code: "2200", name: "Goods Received Not Invoiced", type: "LIABILITY", parent: "2000" },
  { code: "2300", name: "Output CGST", type: "LIABILITY", parent: "2000" },
  { code: "2310", name: "Output SGST", type: "LIABILITY", parent: "2000" },
  { code: "2320", name: "Output IGST", type: "LIABILITY", parent: "2000" },
  { code: "2400", name: "Employee Reimbursements Payable", type: "LIABILITY", parent: "2000" },
  { code: "2500", name: "Salaries Payable", type: "LIABILITY", parent: "2000" },
  { code: "3000", name: "Owner's Capital", type: "EQUITY" },
  { code: "3100", name: "Retained Earnings", type: "EQUITY" },
  { code: "3200", name: "Opening Balance Equity", type: "EQUITY" },
  { code: "4000", name: "Sales Revenue", type: "INCOME" },
  { code: "4900", name: "Other Income", type: "INCOME" },
  { code: "5000", name: "Cost of Goods Sold", type: "EXPENSE" },
  { code: "5100", name: "Purchases and Direct Expenses", type: "EXPENSE" },
  { code: "5200", name: "Purchase Price Variance", type: "EXPENSE" },
  { code: "5300", name: "Stock Adjustments", type: "EXPENSE" },
  { code: "5400", name: "Salaries and Wages", type: "EXPENSE" },
  { code: "5500", name: "Travel", type: "EXPENSE" },
  { code: "5510", name: "Meals and Entertainment", type: "EXPENSE" },
  { code: "5520", name: "Office Supplies", type: "EXPENSE" },
  { code: "5530", name: "Rent", type: "EXPENSE" },
  { code: "5900", name: "Bank Charges", type: "EXPENSE" },
];

const DEFAULT_MAPPINGS: Record<MappingKey, string> = {
  ACCOUNTS_RECEIVABLE: "1300",
  ACCOUNTS_PAYABLE: "2100",
  SALES_REVENUE: "4000",
  PURCHASE_EXPENSE: "5100",
  INVENTORY: "1400",
  WORK_IN_PROGRESS: "1450",
  SALARIES_PAYABLE: "2500",
  SALARY_EXPENSE: "5400",
  COGS: "5000",
  GRNI: "2200",
  PRICE_VARIANCE: "5200",
  STOCK_ADJUSTMENT: "5300",
  OPENING_BALANCE: "3200",
  RETAINED_EARNINGS: "3100",
  OUTPUT_CGST: "2300",
  OUTPUT_SGST: "2310",
  OUTPUT_IGST: "2320",
  INPUT_CGST: "1500",
  INPUT_SGST: "1510",
  INPUT_IGST: "1520",
  EXPENSE_CLAIMS_PAYABLE: "2400",
};

const DEFAULT_EXPENSE_CATEGORIES: [string, string][] = [
  ["Travel", "5500"],
  ["Meals", "5510"],
  ["Office supplies", "5520"],
  ["Other", "5100"],
];

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use yyyy-mm-dd");
const date = (s: string) => new Date(`${s}T00:00:00.000Z`);

function assertFullCompany(ctx: AccessContext, companyId: string) {
  if (ctx.companies.get(companyId) !== "all") throw new AppError("NOT_FOUND", "Company not found", 404);
}

const setupSchema = z.object({
  accountingStartDate: ymd,
  fiscalYearStartMonth: z.number().int().min(1).max(12).default(4),
  seedChartOfAccounts: z.boolean().default(true),
});

/**
 * Turn on accounting for a company: chart of accounts + mappings (optional template),
 * the fiscal year containing the start date with monthly periods, default bank/cash
 * accounts and expense categories. Documents dated before the start date never journal.
 */
export async function setupFinance(ctx: AccessContext, companyId: string, input: unknown) {
  assertCan(ctx, "finance.administer");
  assertFullCompany(ctx, companyId);
  const data = setupSchema.parse(input);

  return prisma.$transaction(
    async (tx) => {
      const company = await tx.company.findFirstOrThrow({ where: { id: companyId, organizationId: ctx.organizationId } });
      const settings = companySettings(company.settings);
      if (settings.finance.enabled) throw new AppError("INVALID_STATE", "Finance is already set up for this company", 422);

      if (data.seedChartOfAccounts && (await tx.account.count({ where: { companyId } })) === 0) {
        const ids = new Map<string, string>();
        for (const a of CHART) {
          const account = await tx.account.create({
            data: {
              organizationId: ctx.organizationId,
              companyId,
              code: a.code,
              name: a.name,
              type: a.type,
              isGroup: a.group ?? false,
              isSystem: true,
              parentId: a.parent ? ids.get(a.parent) : null,
            },
          });
          ids.set(a.code, account.id);
        }
        await tx.accountMapping.createMany({
          data: Object.entries(DEFAULT_MAPPINGS).map(([key, code]) => ({
            organizationId: ctx.organizationId,
            companyId,
            key,
            accountId: ids.get(code)!,
          })),
        });
        await tx.bankAccount.createMany({
          data: [
            { organizationId: ctx.organizationId, companyId, name: "Cash", kind: BankAccountKind.CASH, accountId: ids.get("1100")! },
            { organizationId: ctx.organizationId, companyId, name: "Primary bank", kind: BankAccountKind.BANK, accountId: ids.get("1210")! },
          ],
        });
        await tx.expenseCategory.createMany({
          data: DEFAULT_EXPENSE_CATEGORIES.map(([name, code]) => ({
            organizationId: ctx.organizationId,
            companyId,
            name,
            accountId: ids.get(code)!,
          })),
        });
      }

      await createFiscalYearInTx(tx, ctx, companyId, data.fiscalYearStartMonth, date(data.accountingStartDate));
      const next = {
        ...settings,
        finance: { enabled: true, accountingStartDate: data.accountingStartDate, fiscalYearStartMonth: data.fiscalYearStartMonth },
      };
      await tx.company.update({ where: { id: companyId }, data: { settings: next } });
      await audit(tx, ctx, { action: "finance.setup", entity: "company", entityId: companyId, companyId, previous: settings.finance, next: next.finance });
      return next.finance;
    },
    { timeout: 30_000 },
  );
}

/** Fiscal year containing `containing`, split into calendar-month periods. */
async function createFiscalYearInTx(tx: Db, ctx: AccessContext, companyId: string, startMonth: number, containing: Date) {
  const year = containing.getUTCMonth() + 1 >= startMonth ? containing.getUTCFullYear() : containing.getUTCFullYear() - 1;
  const start = new Date(Date.UTC(year, startMonth - 1, 1));
  const end = new Date(Date.UTC(year + 1, startMonth - 1, 0));
  const existing = await tx.fiscalYear.findUnique({ where: { companyId_startDate: { companyId, startDate: start } } });
  if (existing) return existing;
  const overlap = await tx.fiscalYear.findFirst({ where: { companyId, startDate: { lte: end }, endDate: { gte: start } } });
  if (overlap) throw new AppError("CONFLICT", `Overlaps fiscal year ${overlap.name}`, 409);

  const name = startMonth === 1 ? `FY ${year}` : `FY ${year}-${String((year + 1) % 100).padStart(2, "0")}`;
  const fy = await tx.fiscalYear.create({ data: { organizationId: ctx.organizationId, companyId, name, startDate: start, endDate: end } });
  await tx.accountingPeriod.createMany({
    data: Array.from({ length: 12 }, (_, i) => {
      const s = new Date(Date.UTC(year, startMonth - 1 + i, 1));
      const e = new Date(Date.UTC(year, startMonth + i, 0));
      return {
        organizationId: ctx.organizationId,
        companyId,
        fiscalYearId: fy.id,
        name: s.toLocaleString("en-US", { month: "short", year: "numeric", timeZone: "UTC" }),
        startDate: s,
        endDate: e,
      };
    }),
  });
  await audit(tx, ctx, { action: "fiscal_year.created", entity: "fiscal_year", entityId: fy.id, companyId, next: fy });
  return fy;
}

/** Next (or any) fiscal year: `{ containingDate }`. */
export async function createFiscalYear(ctx: AccessContext, companyId: string, input: unknown) {
  assertCan(ctx, "finance.administer");
  assertFullCompany(ctx, companyId);
  const { containingDate } = z.object({ containingDate: ymd }).parse(input);
  return prisma.$transaction(async (tx) => {
    const finance = companySettings((await tx.company.findUniqueOrThrow({ where: { id: companyId } })).settings).finance;
    if (!finance.enabled) throw new AppError("INVALID_STATE", "Set up finance first", 422);
    return createFiscalYearInTx(tx, ctx, companyId, finance.fiscalYearStartMonth, date(containingDate));
  });
}

export async function listFiscalYears(ctx: AccessContext, companyId: string) {
  assertCan(ctx, "finance.view");
  if (!ctx.companies.has(companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  return prisma.fiscalYear.findMany({
    where: { companyId, organizationId: ctx.organizationId },
    include: { periods: { orderBy: { startDate: "asc" } } },
    orderBy: { startDate: "desc" },
  });
}

/**
 * Close or reopen a period. Closed periods reject every posting (including reversals).
 * Periods close in order: an earlier open period blocks closing a later one.
 */
export async function setPeriodStatus(ctx: AccessContext, periodId: string, input: unknown) {
  assertCan(ctx, "finance.administer");
  const { status, reason } = z.object({ status: z.nativeEnum(PeriodStatus), reason: z.string().trim().max(500).optional() }).parse(input);
  return prisma.$transaction(async (tx) => {
    const period = await tx.accountingPeriod.findFirst({ where: { id: periodId, organizationId: ctx.organizationId } });
    if (!period) throw new AppError("NOT_FOUND", "Period not found", 404);
    assertFullCompany(ctx, period.companyId);
    if (period.status === status) return period;
    if (status === PeriodStatus.CLOSED) {
      const earlierOpen = await tx.accountingPeriod.count({ where: { companyId: period.companyId, startDate: { lt: period.startDate }, status: PeriodStatus.OPEN } });
      if (earlierOpen > 0) throw new AppError("INVALID_STATE", "Close earlier periods first", 422);
      const drafts = await tx.journalEntry.count({ where: { companyId: period.companyId, status: "DRAFT", date: { gte: period.startDate, lte: period.endDate } } });
      if (drafts > 0) throw new AppError("INVALID_STATE", "Post or delete the draft journals in this period first", 422);
    } else if (!reason) {
      throw new AppError("VALIDATION_ERROR", "Give a reason for reopening a closed period", 422);
    }
    const updated = await tx.accountingPeriod.update({
      where: { id: periodId },
      data: { status, closedAt: status === PeriodStatus.CLOSED ? new Date() : null, closedById: status === PeriodStatus.CLOSED ? ctx.userId : null },
    });
    await audit(tx, ctx, {
      action: status === PeriodStatus.CLOSED ? "period.closed" : "period.reopened",
      entity: "accounting_period",
      entityId: periodId,
      companyId: period.companyId,
      previous: { status: period.status },
      next: { status, reason },
    });
    return updated;
  });
}

// ─── Chart of accounts and mappings ──────────────────────────────────────────

export async function listAccounts(ctx: AccessContext, companyId: string) {
  assertCan(ctx, "finance.view");
  if (!ctx.companies.has(companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  const [accounts, mappings] = await Promise.all([
    prisma.account.findMany({ where: { companyId, organizationId: ctx.organizationId }, orderBy: { code: "asc" } }),
    prisma.accountMapping.findMany({ where: { companyId } }),
  ]);
  return { accounts, mappings, keys: Object.keys(MAPPING_KEYS) };
}

const accountSchema = z.object({
  code: z.string().trim().min(1).max(20),
  name: z.string().trim().min(1).max(120),
  type: z.nativeEnum(AccountType),
  parentId: z.string().min(1).nullish(),
  isGroup: z.boolean().optional(),
  description: z.string().trim().max(500).nullish(),
});

export async function createAccount(ctx: AccessContext, companyId: string, input: unknown) {
  assertCan(ctx, "finance.administer");
  assertFullCompany(ctx, companyId);
  const data = accountSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    if (data.parentId) {
      const parent = await tx.account.findFirst({ where: { id: data.parentId, companyId } });
      if (!parent?.isGroup) throw new AppError("INVALID_REFERENCE", "Parent must be a group account of this company", 422);
      if (parent.type !== data.type) throw new AppError("VALIDATION_ERROR", "Child accounts share the parent's type", 422);
    }
    const account = await tx.account.create({ data: { ...data, organizationId: ctx.organizationId, companyId } });
    await audit(tx, ctx, { action: "account.created", entity: "account", entityId: account.id, companyId, next: account });
    return account;
  });
}

/** Name/description/active only once used: type and code are part of history. */
export async function updateAccount(ctx: AccessContext, accountId: string, input: unknown) {
  assertCan(ctx, "finance.administer");
  const data = accountSchema.partial().extend({ isActive: z.boolean().optional() }).parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await tx.account.findFirst({ where: { id: accountId, organizationId: ctx.organizationId } });
    if (!before) throw new AppError("NOT_FOUND", "Account not found", 404);
    assertFullCompany(ctx, before.companyId);
    const used = (await tx.journalLine.count({ where: { accountId } })) > 0;
    if (used && ((data.type && data.type !== before.type) || (data.code && data.code !== before.code) || data.isGroup)) {
      throw new AppError("INVALID_STATE", "Code, type and group flag cannot change once the account has postings", 422);
    }
    if (data.isActive === false && (await tx.accountMapping.count({ where: { accountId } })) > 0) {
      throw new AppError("INVALID_STATE", "Remap this account before deactivating it", 422);
    }
    const diff = changes(before as Record<string, unknown>, data);
    if (!diff.changed) return before;
    const account = await tx.account.update({ where: { id: accountId }, data });
    await audit(tx, ctx, { action: "account.updated", entity: "account", entityId: accountId, companyId: before.companyId, previous: diff.previous, next: diff.next });
    return account;
  });
}

const mappingSchema = z.object({ mappings: z.record(z.string(), z.string().min(1)) });

/** Set mapping keys; each account must be an active posting account of the expected type. */
export async function setAccountMappings(ctx: AccessContext, companyId: string, input: unknown) {
  assertCan(ctx, "finance.administer");
  assertFullCompany(ctx, companyId);
  const { mappings } = mappingSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    for (const [key, accountId] of Object.entries(mappings)) {
      const expected = MAPPING_KEYS[key as MappingKey];
      if (!expected) throw new AppError("VALIDATION_ERROR", `Unknown mapping key ${key}`, 422);
      const account = await tx.account.findFirst({ where: { id: accountId, companyId } });
      if (!account || account.isGroup || !account.isActive) throw new AppError("INVALID_ACCOUNT", `${key}: choose an active posting account`, 422);
      if (account.type !== expected) throw new AppError("INVALID_ACCOUNT", `${key} must map to a ${expected} account`, 422);
      const before = await tx.accountMapping.findUnique({ where: { companyId_key: { companyId, key } } });
      await tx.accountMapping.upsert({
        where: { companyId_key: { companyId, key } },
        create: { organizationId: ctx.organizationId, companyId, key, accountId },
        update: { accountId },
      });
      await audit(tx, ctx, { action: "account_mapping.set", entity: "company", entityId: companyId, companyId, previous: { key, accountId: before?.accountId }, next: { key, accountId } });
    }
    return tx.accountMapping.findMany({ where: { companyId } });
  });
}

// ─── Bank and cash accounts ──────────────────────────────────────────────────

const bankSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.nativeEnum(BankAccountKind).default(BankAccountKind.BANK),
  bankName: z.string().trim().max(80).nullish(),
  accountNumberLast4: z.string().trim().regex(/^\d{4}$/, "Last 4 digits only").nullish(),
  ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, "Enter a valid IFSC").nullish(),
  accountId: z.string().min(1),
});

export async function listBankAccounts(ctx: AccessContext, companyId: string) {
  assertCan(ctx, "finance.view");
  if (!ctx.companies.has(companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  return prisma.bankAccount.findMany({ where: { companyId, organizationId: ctx.organizationId }, include: { account: { select: { code: true, name: true } } }, orderBy: { name: "asc" } });
}

export async function createBankAccount(ctx: AccessContext, companyId: string, input: unknown) {
  assertCan(ctx, "finance.administer");
  assertFullCompany(ctx, companyId);
  const data = bankSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const ledger = await tx.account.findFirst({ where: { id: data.accountId, companyId } });
    if (!ledger || ledger.type !== "ASSET" || ledger.isGroup) throw new AppError("INVALID_ACCOUNT", "Link an asset posting account", 422);
    const bank = await tx.bankAccount.create({ data: { ...data, organizationId: ctx.organizationId, companyId } });
    await audit(tx, ctx, { action: "bank_account.created", entity: "bank_account", entityId: bank.id, companyId, next: bank });
    return bank;
  });
}

// ─── Effective-dated tax rates ───────────────────────────────────────────────

const versionSchema = z.object({
  rate: z.union([z.string(), z.number()]).transform((v) => String(v)).refine((v) => /^\d{1,3}(\.\d{1,3})?$/.test(v) && Number(v) <= 100, "Rate is 0-100 with up to 3 decimals"),
  effectiveFrom: ymd,
});

/**
 * Schedule a new rate for a tax code from a date. Documents use the version effective
 * on their own date, so history is never rewritten.
 */
export async function addTaxRateVersion(ctx: AccessContext, taxRateId: string, input: unknown) {
  assertCan(ctx, "catalog.administer");
  const data = versionSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const tax = await tx.taxRate.findFirst({ where: { id: taxRateId, organizationId: ctx.organizationId } });
    if (!tax) throw new AppError("NOT_FOUND", "Tax rate not found", 404);
    const from = date(data.effectiveFrom);
    const version = await tx.taxRateVersion.create({
      data: { organizationId: ctx.organizationId, taxRateId, rate: data.rate, effectiveFrom: from },
    });
    // Keep the current-rate mirror in sync when the new version is already in force.
    const current = await tx.taxRateVersion.findFirst({ where: { taxRateId, effectiveFrom: { lte: new Date() } }, orderBy: { effectiveFrom: "desc" } });
    if (current) await tx.taxRate.update({ where: { id: taxRateId }, data: { rate: current.rate } });
    await audit(tx, ctx, { action: "tax_rate.version_added", entity: "tax_rate", entityId: taxRateId, previous: { rate: tax.rate }, next: { rate: data.rate, effectiveFrom: data.effectiveFrom } });
    return version;
  });
}

/** Rate of each tax code on `on` (falls back to TaxRate.rate when no version exists). */
export async function ratesOn(db: Db, organizationId: string, taxRateIds: string[], on: Date) {
  const versions = await db.taxRateVersion.findMany({
    where: { organizationId, taxRateId: { in: taxRateIds }, effectiveFrom: { lte: on }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: on } }] },
    orderBy: { effectiveFrom: "desc" },
  });
  const map = new Map<string, Prisma.Decimal>();
  for (const v of versions) if (!map.has(v.taxRateId)) map.set(v.taxRateId, v.rate);
  return map;
}
