import { JournalStatus, PeriodStatus, type JournalEntry, type Prisma } from "@prisma/client";
import { AppError } from "@/lib/errors";
import { dec, Decimal, money } from "@/lib/money";
import { nextDocumentNumber } from "@/lib/numbering";
import { companySettings } from "@/lib/settings";

/**
 * The only writer of journal entries. Rules (also enforced by DB triggers):
 *  - an entry balances (Σ debit = Σ credit > 0), amounts rounded half-up to 2 dp
 *  - it is dated inside an OPEN accounting period of the company
 *  - accounts are resolved from mapping keys or explicit ids, must be active, non-group
 *    accounts of the same company (MAPPING_MISSING / INVALID_ACCOUNT otherwise)
 *  - one journal per business event: (company, sourceType, sourceId, sourceEvent) is
 *    unique, so retrying a posting returns the journal that already exists
 *  - posted journals are never edited; corrections are reversals (reverseJournal)
 */

type Db = Prisma.TransactionClient;

export const MAPPING_KEYS = {
  ACCOUNTS_RECEIVABLE: "ASSET",
  ACCOUNTS_PAYABLE: "LIABILITY",
  SALES_REVENUE: "INCOME",
  PURCHASE_EXPENSE: "EXPENSE",
  INVENTORY: "ASSET",
  COGS: "EXPENSE",
  GRNI: "LIABILITY",
  PRICE_VARIANCE: "EXPENSE",
  STOCK_ADJUSTMENT: "EXPENSE",
  OPENING_BALANCE: "EQUITY",
  RETAINED_EARNINGS: "EQUITY",
  OUTPUT_CGST: "LIABILITY",
  OUTPUT_SGST: "LIABILITY",
  OUTPUT_IGST: "LIABILITY",
  INPUT_CGST: "ASSET",
  INPUT_SGST: "ASSET",
  INPUT_IGST: "ASSET",
  EXPENSE_CLAIMS_PAYABLE: "LIABILITY",
} as const;
export type MappingKey = keyof typeof MAPPING_KEYS;

export type LedgerLine = {
  account: MappingKey | { id: string };
  debit?: Prisma.Decimal.Value;
  credit?: Prisma.Decimal.Value;
  description?: string | null;
  customerId?: string | null;
  vendorId?: string | null;
  bankAccountId?: string | null;
};

export type LedgerScope = { organizationId: string; companyId: string; userId: string | null };

export type JournalInput = {
  date: Date;
  sourceType: string;
  sourceId: string | null;
  sourceEvent?: string;
  memo?: string | null;
  lines: LedgerLine[];
};

export async function financeSettings(db: Db, companyId: string) {
  const company = await db.company.findUniqueOrThrow({ where: { id: companyId }, select: { settings: true } });
  return companySettings(company.settings).finance;
}

/**
 * Whether a document dated `date` produces journals: finance must be set up and the
 * date on/after the accounting start date. Earlier documents stay operational only.
 */
export async function isJournaled(db: Db, companyId: string, date: Date) {
  const finance = await financeSettings(db, companyId);
  if (!finance.enabled) return false;
  return !finance.accountingStartDate || date >= new Date(`${finance.accountingStartDate}T00:00:00.000Z`);
}

export async function periodFor(db: Db, companyId: string, date: Date) {
  const period = await db.accountingPeriod.findFirst({
    where: { companyId, startDate: { lte: date }, endDate: { gte: date } },
  });
  if (!period) {
    throw new AppError("NO_PERIOD", `No accounting period covers ${date.toISOString().slice(0, 10)}; create the fiscal year first`, 422);
  }
  if (period.status !== PeriodStatus.OPEN) {
    throw new AppError("PERIOD_CLOSED", `The accounting period ${period.name} is closed`, 422);
  }
  return period;
}

async function resolveAccounts(db: Db, companyId: string, lines: LedgerLine[]) {
  const keys = [...new Set(lines.flatMap((l) => (typeof l.account === "string" ? [l.account] : [])))];
  const mappings = await db.accountMapping.findMany({ where: { companyId, key: { in: keys } } });
  const missing = keys.filter((k) => !mappings.some((m) => m.key === k));
  if (missing.length > 0) {
    throw new AppError("MAPPING_MISSING", `Map these accounts in finance settings first: ${missing.join(", ")}`, 422, { missing });
  }
  const byKey = new Map(mappings.map((m) => [m.key, m.accountId]));
  const ids = lines.map((l) => (typeof l.account === "string" ? byKey.get(l.account)! : l.account.id));
  const accounts = await db.account.findMany({ where: { companyId, id: { in: [...new Set(ids)] } } });
  for (const id of ids) {
    const account = accounts.find((a) => a.id === id);
    if (!account) throw new AppError("INVALID_ACCOUNT", "Account not found in this company", 422);
    if (account.isGroup) throw new AppError("INVALID_ACCOUNT", `${account.code} ${account.name} is a group account`, 422);
    if (!account.isActive) throw new AppError("INVALID_ACCOUNT", `${account.code} ${account.name} is inactive`, 422);
  }
  return ids;
}

/** Normalise to one positive side per line, dropping zero lines. */
function normalise(lines: LedgerLine[]) {
  return lines
    .map((line) => {
      const net = money(dec(line.debit ?? 0).sub(dec(line.credit ?? 0)));
      return { line, debit: net.gt(0) ? net : new Decimal(0), credit: net.lt(0) ? net.neg() : new Decimal(0) };
    })
    .filter((l) => !l.debit.isZero() || !l.credit.isZero());
}

/**
 * Post a balanced journal for a business event (inside the caller's transaction).
 * Returns the existing journal when this event was already posted.
 */
export async function postJournal(tx: Db, scope: LedgerScope, input: JournalInput): Promise<JournalEntry> {
  const sourceEvent = input.sourceEvent ?? "post";
  if (input.sourceId) {
    const existing = await tx.journalEntry.findUnique({
      where: {
        companyId_sourceType_sourceId_sourceEvent: {
          companyId: scope.companyId,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          sourceEvent,
        },
      },
    });
    if (existing) return existing;
  }

  const period = await periodFor(tx, scope.companyId, input.date);
  const lines = normalise(input.lines);
  const totalDebit = lines.reduce((s, l) => s.add(l.debit), new Decimal(0));
  const totalCredit = lines.reduce((s, l) => s.add(l.credit), new Decimal(0));
  if (lines.length < 2 || totalDebit.isZero()) {
    throw new AppError("UNBALANCED", "A journal needs at least one debit and one credit", 422);
  }
  if (!totalDebit.eq(totalCredit)) {
    throw new AppError("UNBALANCED", `Debits ${totalDebit.toFixed(2)} do not equal credits ${totalCredit.toFixed(2)}`, 422);
  }
  const accountIds = await resolveAccounts(tx, scope.companyId, lines.map((l) => l.line));

  return tx.journalEntry.create({
    data: {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      number: await nextDocumentNumber(tx, scope.organizationId, scope.companyId, "journal", input.date),
      date: input.date,
      periodId: period.id,
      status: JournalStatus.POSTED,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      sourceEvent,
      memo: input.memo ?? null,
      totalDebit,
      totalCredit,
      postedAt: new Date(),
      postedById: scope.userId,
      createdById: scope.userId,
      lines: {
        create: lines.map((l, i) => ({
          companyId: scope.companyId,
          accountId: accountIds[i],
          debit: l.debit,
          credit: l.credit,
          description: l.line.description ?? null,
          customerId: l.line.customerId ?? null,
          vendorId: l.line.vendorId ?? null,
          bankAccountId: l.line.bankAccountId ?? null,
        })),
      },
    },
  });
}

/**
 * Reverse a posted journal with an equal and opposite entry dated `date` (which must
 * fall in an open period); the original is marked REVERSED. Idempotent per journal.
 */
export async function reverseJournal(tx: Db, scope: LedgerScope, journalId: string, date: Date, memo?: string) {
  const original = await tx.journalEntry.findFirst({
    where: { id: journalId, organizationId: scope.organizationId, companyId: scope.companyId },
    include: { lines: true, reversedBy: true },
  });
  if (!original) throw new AppError("NOT_FOUND", "Journal not found", 404);
  if (original.reversedBy) return original.reversedBy;
  if (original.status !== JournalStatus.POSTED) {
    throw new AppError("INVALID_STATE", `A ${original.status} journal cannot be reversed`, 422);
  }
  const period = await periodFor(tx, scope.companyId, date);
  const reversal = await tx.journalEntry.create({
    data: {
      organizationId: scope.organizationId,
      companyId: scope.companyId,
      number: await nextDocumentNumber(tx, scope.organizationId, scope.companyId, "journal", date),
      date,
      periodId: period.id,
      status: JournalStatus.POSTED,
      sourceType: original.sourceType,
      sourceId: original.sourceId,
      sourceEvent: `reverse:${original.sourceEvent}`,
      memo: memo ?? `Reversal of ${original.number}`,
      totalDebit: original.totalCredit,
      totalCredit: original.totalDebit,
      reversalOfId: original.id,
      postedAt: new Date(),
      postedById: scope.userId,
      createdById: scope.userId,
      lines: {
        create: original.lines.map((l) => ({
          companyId: l.companyId,
          accountId: l.accountId,
          debit: l.credit,
          credit: l.debit,
          description: l.description,
          customerId: l.customerId,
          vendorId: l.vendorId,
          bankAccountId: l.bankAccountId,
        })),
      },
    },
  });
  await tx.journalEntry.update({ where: { id: original.id }, data: { status: JournalStatus.REVERSED } });
  return reversal;
}

/** Today's date at 00:00 UTC (journal dates are calendar dates). */
export function today() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
