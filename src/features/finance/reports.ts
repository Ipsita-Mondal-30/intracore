import { z } from "zod";
import { AccountType, FinanceDocStatus, JournalStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { dec, Decimal } from "@/lib/money";
import { outstanding } from "@/features/finance/receivables";
import { billOutstanding } from "@/features/finance/payables";

/**
 * Financial reports, computed in the database from POSTED and REVERSED journals (a
 * reversed journal and its reversal both count, so together they net to zero). Draft
 * journals never count. Amounts are decimal strings with 2 dp.
 */

const ZERO = new Decimal(0);
const ledgerStatuses = { in: [JournalStatus.POSTED, JournalStatus.REVERSED] };
const asDate = z.coerce.date();

function scope(ctx: AccessContext, companyId: string) {
  assertCan(ctx, "finance.report");
  if (!ctx.companies.has(companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
}

async function balancesByAccount(companyId: string, date: { gte?: Date; lte?: Date }) {
  const sums = await prisma.journalLine.groupBy({
    by: ["accountId"],
    where: { companyId, entry: { status: ledgerStatuses, date } },
    _sum: { debit: true, credit: true },
  });
  return new Map(sums.map((s) => [s.accountId, { debit: dec(s._sum.debit), credit: dec(s._sum.credit) }]));
}

/** Debit-normal for assets and expenses, credit-normal otherwise. */
const natural = (type: AccountType, debit: Decimal, credit: Decimal) =>
  type === "ASSET" || type === "EXPENSE" ? debit.sub(credit) : credit.sub(debit);

export async function trialBalance(ctx: AccessContext, companyId: string, query: unknown) {
  scope(ctx, companyId);
  const { asOf } = z.object({ asOf: asDate.optional() }).parse(query);
  const [accounts, sums] = await Promise.all([
    prisma.account.findMany({ where: { companyId, isGroup: false }, orderBy: { code: "asc" } }),
    balancesByAccount(companyId, { lte: asOf }),
  ]);
  let totalDebit = ZERO;
  let totalCredit = ZERO;
  const rows = accounts
    .map((a) => {
      const s = sums.get(a.id) ?? { debit: ZERO, credit: ZERO };
      const net = s.debit.sub(s.credit);
      const debit = net.gt(0) ? net : ZERO;
      const credit = net.lt(0) ? net.neg() : ZERO;
      totalDebit = totalDebit.add(debit);
      totalCredit = totalCredit.add(credit);
      return { accountId: a.id, code: a.code, name: a.name, type: a.type, debit: debit.toFixed(2), credit: credit.toFixed(2) };
    })
    .filter((r) => r.debit !== "0.00" || r.credit !== "0.00");
  return { asOf: asOf ?? null, rows, totalDebit: totalDebit.toFixed(2), totalCredit: totalCredit.toFixed(2), balanced: totalDebit.eq(totalCredit) };
}

export async function generalLedger(ctx: AccessContext, companyId: string, query: unknown) {
  scope(ctx, companyId);
  const q = z.object({ accountId: z.string().min(1), from: asDate.optional(), to: asDate.optional() }).parse(query);
  const account = await prisma.account.findFirst({ where: { id: q.accountId, companyId } });
  if (!account) throw new AppError("NOT_FOUND", "Account not found", 404);
  const opening = q.from
    ? await prisma.journalLine.aggregate({ where: { accountId: account.id, entry: { status: ledgerStatuses, date: { lt: q.from } } }, _sum: { debit: true, credit: true } })
    : null;
  let balance = opening ? natural(account.type, dec(opening._sum.debit), dec(opening._sum.credit)) : ZERO;
  const openingBalance = balance.toFixed(2);
  const lines = await prisma.journalLine.findMany({
    where: { accountId: account.id, entry: { status: ledgerStatuses, date: { gte: q.from, lte: q.to } } },
    include: { entry: { select: { id: true, number: true, date: true, sourceType: true, sourceId: true, memo: true } } },
    orderBy: [{ entry: { date: "asc" } }, { entry: { createdAt: "asc" } }],
    take: 5000,
  });
  return {
    account: { id: account.id, code: account.code, name: account.name, type: account.type },
    openingBalance,
    lines: lines.map((l) => {
      balance = balance.add(natural(account.type, dec(l.debit), dec(l.credit)));
      return { ...l.entry, lineId: l.id, description: l.description, debit: dec(l.debit).toFixed(2), credit: dec(l.credit).toFixed(2), balance: balance.toFixed(2) };
    }),
    closingBalance: balance.toFixed(2),
  };
}

export async function profitAndLoss(ctx: AccessContext, companyId: string, query: unknown) {
  scope(ctx, companyId);
  const q = z.object({ from: asDate, to: asDate }).parse(query);
  const [accounts, sums] = await Promise.all([
    prisma.account.findMany({ where: { companyId, type: { in: ["INCOME", "EXPENSE"] }, isGroup: false }, orderBy: { code: "asc" } }),
    balancesByAccount(companyId, { gte: q.from, lte: q.to }),
  ]);
  const section = (type: AccountType) => {
    const rows = accounts
      .filter((a) => a.type === type)
      .map((a) => {
        const s = sums.get(a.id) ?? { debit: ZERO, credit: ZERO };
        return { accountId: a.id, code: a.code, name: a.name, amount: natural(type, s.debit, s.credit) };
      })
      .filter((r) => !r.amount.isZero());
    const total = rows.reduce((t, r) => t.add(r.amount), ZERO);
    return { rows: rows.map((r) => ({ ...r, amount: r.amount.toFixed(2) })), total };
  };
  const income = section("INCOME");
  const expenses = section("EXPENSE");
  return {
    from: q.from,
    to: q.to,
    income: { rows: income.rows, total: income.total.toFixed(2) },
    expenses: { rows: expenses.rows, total: expenses.total.toFixed(2) },
    netProfit: income.total.sub(expenses.total).toFixed(2),
  };
}

/**
 * Balance sheet as of a date. No year-end closing entries are posted, so the
 * accumulated profit (all income − expense to date) is shown as a separate equity line.
 */
export async function balanceSheet(ctx: AccessContext, companyId: string, query: unknown) {
  scope(ctx, companyId);
  const { asOf } = z.object({ asOf: asDate }).parse(query);
  const [accounts, sums] = await Promise.all([
    prisma.account.findMany({ where: { companyId, isGroup: false }, orderBy: { code: "asc" } }),
    balancesByAccount(companyId, { lte: asOf }),
  ]);
  const totals: Record<AccountType, Decimal> = { ASSET: ZERO, LIABILITY: ZERO, EQUITY: ZERO, INCOME: ZERO, EXPENSE: ZERO };
  const rows: Record<"ASSET" | "LIABILITY" | "EQUITY", { code: string; name: string; amount: string }[]> = { ASSET: [], LIABILITY: [], EQUITY: [] };
  for (const a of accounts) {
    const s = sums.get(a.id) ?? { debit: ZERO, credit: ZERO };
    const amount = natural(a.type, s.debit, s.credit);
    totals[a.type] = totals[a.type].add(amount);
    if ((a.type === "ASSET" || a.type === "LIABILITY" || a.type === "EQUITY") && !amount.isZero()) {
      rows[a.type].push({ code: a.code, name: a.name, amount: amount.toFixed(2) });
    }
  }
  const earnings = totals.INCOME.sub(totals.EXPENSE);
  const liabilitiesAndEquity = totals.LIABILITY.add(totals.EQUITY).add(earnings);
  return {
    asOf,
    assets: { rows: rows.ASSET, total: totals.ASSET.toFixed(2) },
    liabilities: { rows: rows.LIABILITY, total: totals.LIABILITY.toFixed(2) },
    equity: { rows: rows.EQUITY, accumulatedProfit: earnings.toFixed(2), total: totals.EQUITY.add(earnings).toFixed(2) },
    totalLiabilitiesAndEquity: liabilitiesAndEquity.toFixed(2),
    balanced: totals.ASSET.eq(liabilitiesAndEquity),
  };
}

// ─── Aging and statements (from documents) ───────────────────────────────────

const BUCKETS = [
  { key: "current", max: 0 },
  { key: "1_30", max: 30 },
  { key: "31_60", max: 60 },
  { key: "61_90", max: 90 },
  { key: "over_90", max: Infinity },
] as const;
type Bucket = (typeof BUCKETS)[number]["key"];

function bucketOf(dueDate: Date, asOf: Date): Bucket {
  const days = Math.floor((asOf.getTime() - dueDate.getTime()) / 86_400_000);
  return BUCKETS.find((b) => days <= b.max)!.key;
}

function emptyBuckets() {
  return Object.fromEntries(BUCKETS.map((b) => [b.key, ZERO])) as Record<Bucket, Decimal>;
}

/** Outstanding posted invoices by days past due (as of today's balances). */
export async function receivablesAging(ctx: AccessContext, companyId: string, query: unknown) {
  scope(ctx, companyId);
  const { asOf = new Date() } = z.object({ asOf: asDate.optional() }).parse(query);
  const invoices = await prisma.salesInvoice.findMany({
    where: { companyId, status: FinanceDocStatus.POSTED },
    include: { customer: { select: { id: true, name: true } } },
  });
  const unapplied = await unappliedCustomerCredits(companyId);
  return aging(
    invoices.map((i) => ({ partyId: i.customer.id, partyName: i.customer.name, dueDate: i.dueDate, amount: outstanding(i) })),
    asOf,
    unapplied,
  );
}

export async function payablesAging(ctx: AccessContext, companyId: string, query: unknown) {
  scope(ctx, companyId);
  const { asOf = new Date() } = z.object({ asOf: asDate.optional() }).parse(query);
  const bills = await prisma.vendorBill.findMany({ where: { companyId, status: FinanceDocStatus.POSTED }, include: { vendor: { select: { id: true, name: true } } } });
  const unapplied = await unappliedVendorDebits(companyId);
  return aging(
    bills.map((b) => ({ partyId: b.vendor.id, partyName: b.vendor.name, dueDate: b.dueDate ?? b.billDate, amount: billOutstanding(b) })),
    asOf,
    unapplied,
  );
}

function aging(items: { partyId: string; partyName: string; dueDate: Date; amount: Decimal }[], asOf: Date, unapplied: Map<string, Decimal>) {
  const parties = new Map<string, { partyId: string; partyName: string; buckets: Record<Bucket, Decimal>; total: Decimal }>();
  const grand = emptyBuckets();
  for (const item of items) {
    if (!item.amount.gt(0)) continue;
    const p = parties.get(item.partyId) ?? { partyId: item.partyId, partyName: item.partyName, buckets: emptyBuckets(), total: ZERO };
    const b = bucketOf(item.dueDate, asOf);
    p.buckets[b] = p.buckets[b].add(item.amount);
    p.total = p.total.add(item.amount);
    grand[b] = grand[b].add(item.amount);
    parties.set(item.partyId, p);
  }
  const fmt = (b: Record<Bucket, Decimal>) => Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.toFixed(2)])) as Record<Bucket, string>;
  return {
    asOf,
    buckets: BUCKETS.map((b) => b.key),
    rows: [...parties.values()]
      .sort((a, b) => b.total.cmp(a.total))
      .map((p) => ({ partyId: p.partyId, partyName: p.partyName, ...fmt(p.buckets), total: p.total.toFixed(2), unappliedCredit: (unapplied.get(p.partyId) ?? ZERO).toFixed(2) })),
    totals: { ...fmt(grand), total: Object.values(grand).reduce((s, v) => s.add(v), ZERO).toFixed(2) },
  };
}

async function unappliedCustomerCredits(companyId: string) {
  const [receipts, notes] = await Promise.all([
    prisma.paymentReceipt.findMany({ where: { companyId, status: FinanceDocStatus.POSTED }, select: { customerId: true, amount: true, allocatedAmount: true } }),
    prisma.creditNote.findMany({ where: { companyId, status: FinanceDocStatus.POSTED }, select: { customerId: true, grandTotal: true, appliedAmount: true } }),
  ]);
  const map = new Map<string, Decimal>();
  for (const r of receipts) map.set(r.customerId, (map.get(r.customerId) ?? ZERO).add(dec(r.amount).sub(r.allocatedAmount)));
  for (const n of notes) map.set(n.customerId, (map.get(n.customerId) ?? ZERO).add(dec(n.grandTotal).sub(n.appliedAmount)));
  return map;
}

async function unappliedVendorDebits(companyId: string) {
  const [payments, notes] = await Promise.all([
    prisma.vendorPayment.findMany({ where: { companyId, status: FinanceDocStatus.POSTED }, select: { vendorId: true, amount: true, allocatedAmount: true } }),
    prisma.debitNote.findMany({ where: { companyId, status: FinanceDocStatus.POSTED }, select: { vendorId: true, grandTotal: true, appliedAmount: true } }),
  ]);
  const map = new Map<string, Decimal>();
  for (const p of payments) map.set(p.vendorId, (map.get(p.vendorId) ?? ZERO).add(dec(p.amount).sub(p.allocatedAmount)));
  for (const n of notes) map.set(n.vendorId, (map.get(n.vendorId) ?? ZERO).add(dec(n.grandTotal).sub(n.appliedAmount)));
  return map;
}

type StatementLine = { date: Date; type: string; number: string | null; documentId: string; debit: Decimal; credit: Decimal };

function runStatement(lines: StatementLine[], from: Date | undefined) {
  lines.sort((a, b) => a.date.getTime() - b.date.getTime());
  let balance = ZERO;
  const before = from ? lines.filter((l) => l.date < from) : [];
  for (const l of before) balance = balance.add(l.debit).sub(l.credit);
  const openingBalance = balance.toFixed(2);
  const rows = lines
    .filter((l) => !from || l.date >= from)
    .map((l) => {
      balance = balance.add(l.debit).sub(l.credit);
      return { ...l, debit: l.debit.toFixed(2), credit: l.credit.toFixed(2), balance: balance.toFixed(2) };
    });
  return { openingBalance, rows, closingBalance: balance.toFixed(2) };
}

/**
 * Customer statement: posted invoices (debit), credit notes and receipts (credit).
 * Cancelled documents and their reversals are left out entirely (they net to zero).
 */
export async function customerStatement(ctx: AccessContext, companyId: string, customerId: string, query: unknown) {
  scope(ctx, companyId);
  const q = z.object({ from: asDate.optional(), to: asDate.optional() }).parse(query);
  const customer = await prisma.customer.findFirst({ where: { id: customerId, organizationId: ctx.organizationId } });
  if (!customer) throw new AppError("NOT_FOUND", "Customer not found", 404);
  const date = { lte: q.to };
  const [invoices, notes, receipts] = await Promise.all([
    prisma.salesInvoice.findMany({ where: { companyId, customerId, status: FinanceDocStatus.POSTED, invoiceDate: date } }),
    prisma.creditNote.findMany({ where: { companyId, customerId, status: FinanceDocStatus.POSTED, noteDate: date } }),
    prisma.paymentReceipt.findMany({ where: { companyId, customerId, status: FinanceDocStatus.POSTED, receiptDate: date } }),
  ]);
  const lines: StatementLine[] = [
    ...invoices.map((i) => ({ date: i.invoiceDate, type: "INVOICE", number: i.number, documentId: i.id, debit: dec(i.grandTotal), credit: ZERO })),
    ...notes.map((n) => ({ date: n.noteDate, type: "CREDIT_NOTE", number: n.number, documentId: n.id, debit: ZERO, credit: dec(n.grandTotal) })),
    ...receipts.map((r) => ({ date: r.receiptDate, type: "RECEIPT", number: r.number, documentId: r.id, debit: ZERO, credit: dec(r.amount) })),
  ];
  return { party: { id: customer.id, name: customer.name, gstin: customer.gstin }, ...runStatement(lines, q.from) };
}

export async function vendorStatement(ctx: AccessContext, companyId: string, vendorId: string, query: unknown) {
  scope(ctx, companyId);
  const q = z.object({ from: asDate.optional(), to: asDate.optional() }).parse(query);
  const vendor = await prisma.vendor.findFirst({ where: { id: vendorId, organizationId: ctx.organizationId } });
  if (!vendor) throw new AppError("NOT_FOUND", "Vendor not found", 404);
  const date = { lte: q.to };
  const [bills, notes, payments] = await Promise.all([
    prisma.vendorBill.findMany({ where: { companyId, vendorId, status: FinanceDocStatus.POSTED, billDate: date } }),
    prisma.debitNote.findMany({ where: { companyId, vendorId, status: FinanceDocStatus.POSTED, noteDate: date } }),
    prisma.vendorPayment.findMany({ where: { companyId, vendorId, status: FinanceDocStatus.POSTED, paymentDate: date } }),
  ]);
  // Credit-positive from our side: bills raise what we owe; notes and payments reduce it.
  const lines: StatementLine[] = [
    ...bills.map((b) => ({ date: b.billDate, type: "BILL", number: `${b.number} (${b.vendorInvoiceNumber})`, documentId: b.id, debit: dec(b.grandTotal), credit: ZERO })),
    ...notes.map((n) => ({ date: n.noteDate, type: "DEBIT_NOTE", number: n.number, documentId: n.id, debit: ZERO, credit: dec(n.grandTotal) })),
    ...payments.map((p) => ({ date: p.paymentDate, type: "PAYMENT", number: p.number, documentId: p.id, debit: ZERO, credit: dec(p.amount) })),
  ];
  return { party: { id: vendor.id, name: vendor.name, gstin: vendor.gstin }, ...runStatement(lines, q.from) };
}

// ─── Operational ↔ accounting reconciliation ─────────────────────────────────

/**
 * Checks that every posted document dated on/after the accounting start date has a
 * journal with matching amounts, and that control accounts agree with the documents.
 */
export async function financeReconciliation(ctx: AccessContext, companyId: string) {
  scope(ctx, companyId);
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId }, select: { settings: true } });
  const { companySettings } = await import("@/lib/settings");
  const finance = companySettings(company.settings).finance;
  if (!finance.enabled) return { enabled: false, issues: [], controls: [] };
  const start = finance.accountingStartDate ? new Date(`${finance.accountingStartDate}T00:00:00.000Z`) : new Date(0);

  const issues: { documentType: string; documentId: string; number: string | null; problem: string }[] = [];
  const check = async (
    documentType: string,
    docs: { id: string; number: string | null; journalEntryId: string | null; amount: Prisma.Decimal }[],
  ) => {
    const journals = await prisma.journalEntry.findMany({ where: { id: { in: docs.map((d) => d.journalEntryId).filter((id): id is string => Boolean(id)) } } });
    for (const d of docs) {
      const j = journals.find((x) => x.id === d.journalEntryId);
      if (!j) issues.push({ documentType, documentId: d.id, number: d.number, problem: "no journal" });
      else if (!dec(j.totalDebit).eq(d.amount)) issues.push({ documentType, documentId: d.id, number: d.number, problem: `journal ${j.totalDebit} ≠ document ${d.amount}` });
    }
  };
  const posted = { companyId, status: FinanceDocStatus.POSTED };
  await check("SALES_INVOICE", (await prisma.salesInvoice.findMany({ where: { ...posted, invoiceDate: { gte: start } } })).map((d) => ({ ...d, amount: d.grandTotal })));
  await check("CREDIT_NOTE", (await prisma.creditNote.findMany({ where: { ...posted, noteDate: { gte: start } } })).map((d) => ({ ...d, amount: d.grandTotal })));
  await check("RECEIPT", (await prisma.paymentReceipt.findMany({ where: { ...posted, receiptDate: { gte: start } } })).map((d) => ({ ...d, amount: d.amount })));
  await check("VENDOR_PAYMENT", (await prisma.vendorPayment.findMany({ where: { ...posted, paymentDate: { gte: start } } })).map((d) => ({ ...d, amount: d.amount })));
  await check("DEBIT_NOTE", (await prisma.debitNote.findMany({ where: { ...posted, noteDate: { gte: start } } })).map((d) => ({ ...d, amount: d.grandTotal })));

  const mapped = async (key: string) => (await prisma.accountMapping.findUnique({ where: { companyId_key: { companyId, key } } }))?.accountId;
  const glBalance = async (accountId: string | undefined, sign: 1 | -1) => {
    if (!accountId) return null;
    const s = await prisma.journalLine.aggregate({ where: { accountId, entry: { status: ledgerStatuses } }, _sum: { debit: true, credit: true } });
    return dec(s._sum.debit).sub(dec(s._sum.credit)).mul(sign);
  };
  const [invoices, bills, valuations] = await Promise.all([
    prisma.salesInvoice.findMany({ where: { ...posted, invoiceDate: { gte: start } } }),
    prisma.vendorBill.findMany({ where: { ...posted, billDate: { gte: start } } }),
    prisma.stockValuation.aggregate({ where: { companyId }, _sum: { value: true } }),
  ]);
  const unappliedAr = [...(await unappliedCustomerCredits(companyId)).values()].reduce((s, v) => s.add(v), ZERO);
  const unappliedAp = [...(await unappliedVendorDebits(companyId)).values()].reduce((s, v) => s.add(v), ZERO);
  const controls = [
    {
      control: "Accounts receivable",
      ledger: (await glBalance(await mapped("ACCOUNTS_RECEIVABLE"), 1))?.toFixed(2) ?? null,
      documents: invoices.reduce((s, i) => s.add(outstanding(i)), ZERO).sub(unappliedAr).toFixed(2),
    },
    {
      control: "Accounts payable",
      ledger: (await glBalance(await mapped("ACCOUNTS_PAYABLE"), -1))?.toFixed(2) ?? null,
      documents: bills.reduce((s, b) => s.add(billOutstanding(b)), ZERO).sub(unappliedAp).toFixed(2),
    },
    {
      control: "Inventory (stock valuation)",
      ledger: (await glBalance(await mapped("INVENTORY"), 1))?.toFixed(2) ?? null,
      documents: dec(valuations._sum.value).toFixed(2),
    },
  ].map((c) => ({ ...c, matches: c.ledger === c.documents }));
  return { enabled: true, accountingStartDate: finance.accountingStartDate, issues, controls };
}
