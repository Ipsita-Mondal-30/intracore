import { createHash } from "crypto";
import Papa from "papaparse";
import { z } from "zod";
import { BankTxnStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { nextDocumentNumber } from "@/lib/numbering";
import { dec, Decimal, zDecimal } from "@/lib/money";
import { postJournal, today } from "@/features/finance/ledger";

/**
 * Bank & cash. There is NO live bank connection: statement lines arrive only through
 * manual CSV imports (BankImport). Reconciliation matches a statement line to the
 * ledger line that moved the same bank account by the same amount.
 */

async function requireBank(ctx: AccessContext, bankAccountId: string) {
  const bank = await prisma.bankAccount.findFirst({ where: { id: bankAccountId, organizationId: ctx.organizationId }, include: { account: true } });
  if (!bank || !ctx.companies.has(bank.companyId)) throw new AppError("NOT_FOUND", "Bank account not found", 404);
  return bank;
}

const importSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  csv: z.string().min(1).max(5_000_000),
  /** Column names in the CSV header */
  columns: z.object({
    date: z.string().min(1),
    description: z.string().min(1),
    amount: z.string().optional(),
    debit: z.string().optional(),
    credit: z.string().optional(),
    reference: z.string().optional(),
  }),
  dateFormat: z.enum(["YYYY-MM-DD", "DD/MM/YYYY", "DD-MM-YYYY", "MM/DD/YYYY"]).default("DD/MM/YYYY"),
});

function parseDate(value: string, format: z.infer<typeof importSchema>["dateFormat"]) {
  const v = value.trim();
  let y: number, m: number, d: number;
  if (format === "YYYY-MM-DD") [y, m, d] = v.split("-").map(Number);
  else if (format === "MM/DD/YYYY") [m, d, y] = v.split("/").map(Number);
  else [d, m, y] = v.split(/[/-]/).map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return Number.isNaN(date.getTime()) || date.getUTCDate() !== d ? null : date;
}

const amountOf = (raw: string | undefined) => {
  if (!raw || !raw.trim()) return new Decimal(0);
  const cleaned = raw.replace(/[,\s₹]/g, "").replace(/^\((.*)\)$/, "-$1");
  return new Decimal(cleaned);
};

/**
 * Import a statement CSV. Either an `amount` column (+ in / − out) or `debit`/`credit`
 * columns. Rows already imported (same date, amount, reference, description) are
 * skipped, so re-importing an overlapping statement is safe.
 */
export async function importBankStatement(ctx: AccessContext, bankAccountId: string, input: unknown) {
  assertCan(ctx, "finance.post");
  const data = importSchema.parse(input);
  if (!data.columns.amount && !(data.columns.debit && data.columns.credit)) {
    throw new AppError("VALIDATION_ERROR", "Map an amount column, or both debit and credit columns", 422);
  }
  const bank = await requireBank(ctx, bankAccountId);
  const parsed = Papa.parse<Record<string, string>>(data.csv, { header: true, skipEmptyLines: true });
  const rows: { txnDate: Date; description: string; reference: string | null; amount: Decimal; dedupeKey: string }[] = [];
  const errors: { row: number; message: string }[] = [];
  parsed.data.forEach((row, i) => {
    try {
      const txnDate = parseDate(row[data.columns.date] ?? "", data.dateFormat);
      if (!txnDate) throw new Error("bad date");
      const amount = data.columns.amount
        ? amountOf(row[data.columns.amount])
        : amountOf(row[data.columns.credit!]).sub(amountOf(row[data.columns.debit!]));
      if (amount.isZero()) throw new Error("zero amount");
      const description = (row[data.columns.description] ?? "").trim().slice(0, 500) || "(no description)";
      const reference = data.columns.reference ? (row[data.columns.reference] ?? "").trim() || null : null;
      const dedupeKey = createHash("sha256").update([txnDate.toISOString(), amount.toFixed(2), reference ?? "", description].join("|")).digest("hex");
      rows.push({ txnDate, description, reference, amount: amount.toDecimalPlaces(2), dedupeKey });
    } catch (error) {
      errors.push({ row: i + 2, message: error instanceof Error ? error.message : "invalid row" });
    }
  });

  return prisma.$transaction(async (tx) => {
    const record = await tx.bankImport.create({
      data: { organizationId: ctx.organizationId, companyId: bank.companyId, bankAccountId, fileName: data.fileName, rowCount: rows.length, importedById: ctx.userId },
    });
    const created = await tx.bankTransaction.createMany({
      data: rows.map((r) => ({ ...r, organizationId: ctx.organizationId, companyId: bank.companyId, bankAccountId, importId: record.id })),
      skipDuplicates: true,
    });
    const result = await tx.bankImport.update({ where: { id: record.id }, data: { rowCount: created.count, skippedCount: rows.length - created.count } });
    await audit(tx, ctx, { action: "bank.statement_imported", entity: "bank_account", entityId: bankAccountId, companyId: bank.companyId, next: { importId: record.id, imported: created.count, duplicates: rows.length - created.count, errors: errors.length } });
    return { import: result, imported: created.count, duplicates: rows.length - created.count, errors, source: "manual-import" as const };
  });
}

export async function listBankTransactions(ctx: AccessContext, bankAccountId: string, query: unknown) {
  assertCan(ctx, "finance.view");
  await requireBank(ctx, bankAccountId);
  const q = z.object({ status: z.nativeEnum(BankTxnStatus).optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() }).parse(query);
  return prisma.bankTransaction.findMany({
    where: { bankAccountId, status: q.status, txnDate: { gte: q.from, lte: q.to } },
    include: { matchedLine: { include: { entry: { select: { id: true, number: true, sourceType: true, sourceId: true, memo: true } } } } },
    orderBy: [{ txnDate: "desc" }, { createdAt: "desc" }],
    take: 500,
  });
}

/** Unmatched ledger lines on this bank account with the same amount, ±10 days. */
export async function suggestMatches(ctx: AccessContext, transactionId: string) {
  assertCan(ctx, "finance.view");
  const txn = await prisma.bankTransaction.findFirst({ where: { id: transactionId, organizationId: ctx.organizationId }, include: { bankAccount: true } });
  if (!txn || !ctx.companies.has(txn.companyId)) throw new AppError("NOT_FOUND", "Bank transaction not found", 404);
  const amount = dec(txn.amount);
  const window = 10 * 86_400_000;
  return prisma.journalLine.findMany({
    where: {
      accountId: txn.bankAccount.accountId,
      bankMatch: null,
      ...(amount.gt(0) ? { debit: amount.abs() } : { credit: amount.abs() }),
      entry: { status: { in: ["POSTED", "REVERSED"] }, date: { gte: new Date(txn.txnDate.getTime() - window), lte: new Date(txn.txnDate.getTime() + window) } },
    },
    include: { entry: { select: { id: true, number: true, date: true, sourceType: true, sourceId: true, memo: true } } },
    take: 20,
  });
}

/** Match a statement line to a ledger line of the same bank account and amount. */
export async function reconcileBankTransaction(ctx: AccessContext, transactionId: string, input: unknown) {
  assertCan(ctx, "finance.post");
  const { journalLineId } = z.object({ journalLineId: z.string().min(1) }).parse(input);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "bank_transactions" WHERE "id" = ${transactionId} FOR UPDATE`;
    const txn = await tx.bankTransaction.findFirst({ where: { id: transactionId, organizationId: ctx.organizationId }, include: { bankAccount: true } });
    if (!txn || !ctx.companies.has(txn.companyId)) throw new AppError("NOT_FOUND", "Bank transaction not found", 404);
    if (txn.status === BankTxnStatus.RECONCILED) throw new AppError("INVALID_STATE", "Already reconciled", 422);
    const line = await tx.journalLine.findFirst({ where: { id: journalLineId, companyId: txn.companyId }, include: { entry: true } });
    if (!line || line.accountId !== txn.bankAccount.accountId) throw new AppError("INVALID_REFERENCE", "That ledger line does not move this bank account", 422);
    if (line.entry.status === "DRAFT") throw new AppError("INVALID_STATE", "Only posted journals can be reconciled", 422);
    const signed = dec(line.debit).sub(line.credit);
    if (!signed.eq(txn.amount)) throw new AppError("AMOUNT_MISMATCH", `Statement ${dec(txn.amount).toFixed(2)} vs ledger ${signed.toFixed(2)}`, 422);
    const updated = await tx.bankTransaction.update({
      where: { id: transactionId },
      data: { status: BankTxnStatus.RECONCILED, matchedJournalLineId: journalLineId, reconciledAt: new Date(), reconciledById: ctx.userId },
    });
    await audit(tx, ctx, { action: "bank.reconciled", entity: "bank_transaction", entityId: transactionId, companyId: txn.companyId, next: { journalLineId, entry: line.entry.number } });
    return updated;
  });
}

export async function unreconcileBankTransaction(ctx: AccessContext, transactionId: string) {
  assertCan(ctx, "finance.post");
  return prisma.$transaction(async (tx) => {
    const txn = await tx.bankTransaction.findFirst({ where: { id: transactionId, organizationId: ctx.organizationId } });
    if (!txn || !ctx.companies.has(txn.companyId)) throw new AppError("NOT_FOUND", "Bank transaction not found", 404);
    const updated = await tx.bankTransaction.update({
      where: { id: transactionId },
      data: { status: BankTxnStatus.UNRECONCILED, matchedJournalLineId: null, reconciledAt: null, reconciledById: null },
    });
    await audit(tx, ctx, { action: "bank.unreconciled", entity: "bank_transaction", entityId: transactionId, companyId: txn.companyId, previous: { journalLineId: txn.matchedJournalLineId } });
    return updated;
  });
}

/** Cashbook: ledger movements of the bank/cash account with running balance and reconciliation flag. */
export async function getCashbook(ctx: AccessContext, bankAccountId: string, query: unknown) {
  assertCan(ctx, "finance.view");
  const bank = await requireBank(ctx, bankAccountId);
  const q = z.object({ from: z.coerce.date().optional(), to: z.coerce.date().optional() }).parse(query);
  const posted = { status: { in: ["POSTED" as const, "REVERSED" as const] } };
  const opening = q.from
    ? await prisma.journalLine.aggregate({ where: { accountId: bank.accountId, entry: { ...posted, date: { lt: q.from } } }, _sum: { debit: true, credit: true } })
    : null;
  let balance = opening ? dec(opening._sum.debit).sub(dec(opening._sum.credit)) : new Decimal(0);
  const openingBalance = balance.toFixed(2);
  const lines = await prisma.journalLine.findMany({
    where: { accountId: bank.accountId, entry: { ...posted, date: { gte: q.from, lte: q.to } } },
    include: { entry: { select: { id: true, number: true, date: true, sourceType: true, sourceId: true, memo: true } }, bankMatch: { select: { id: true } } },
    orderBy: [{ entry: { date: "asc" } }, { entry: { createdAt: "asc" } }],
    take: 2000,
  });
  return {
    bankAccount: { id: bank.id, name: bank.name, kind: bank.kind, ledger: `${bank.account.code} ${bank.account.name}` },
    openingBalance,
    lines: lines.map((l) => {
      balance = balance.add(l.debit).sub(l.credit);
      return {
        id: l.id,
        date: l.entry.date,
        journal: l.entry.number,
        sourceType: l.entry.sourceType,
        sourceId: l.entry.sourceId,
        memo: l.entry.memo,
        moneyIn: dec(l.debit).toFixed(2),
        moneyOut: dec(l.credit).toFixed(2),
        balance: balance.toFixed(2),
        reconciled: Boolean(l.bankMatch),
      };
    }),
    closingBalance: balance.toFixed(2),
  };
}

const transferSchema = z
  .object({
    fromBankAccountId: z.string().min(1),
    toBankAccountId: z.string().min(1),
    transferDate: z.coerce.date().optional(),
    amount: zDecimal().refine((a) => a.gt(0), "Amount must be positive"),
    reference: z.string().trim().max(120).nullish(),
  })
  .refine((t) => t.fromBankAccountId !== t.toBankAccountId, { message: "Choose two different accounts", path: ["toBankAccountId"] });

/** Move money between two bank/cash accounts of one company (journal only). */
export async function createTransfer(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "finance.post");
  const data = transferSchema.parse(input);
  const [from, to] = await Promise.all([requireBank(ctx, data.fromBankAccountId), requireBank(ctx, data.toBankAccountId)]);
  if (from.companyId !== to.companyId) throw new AppError("VALIDATION_ERROR", "Transfers stay within one company", 422);
  return prisma.$transaction(async (tx) => {
    const date = data.transferDate ?? today();
    const number = await nextDocumentNumber(tx, ctx.organizationId, from.companyId, "transfer", date);
    const transfer = await tx.accountTransfer.create({
      data: { organizationId: ctx.organizationId, companyId: from.companyId, number, fromBankAccountId: from.id, toBankAccountId: to.id, transferDate: date, amount: data.amount, reference: data.reference ?? null, createdById: ctx.userId },
    });
    // A transfer is purely an accounting movement, so finance must be set up.
    const journal = await postJournal(tx, { organizationId: ctx.organizationId, companyId: from.companyId, userId: ctx.userId }, {
      date,
      sourceType: "TRANSFER",
      sourceId: transfer.id,
      memo: `Transfer ${number}: ${from.name} → ${to.name}`,
      lines: [
        { account: { id: to.accountId }, debit: data.amount, bankAccountId: to.id },
        { account: { id: from.accountId }, credit: data.amount, bankAccountId: from.id },
      ],
    });
    const result = await tx.accountTransfer.update({ where: { id: transfer.id }, data: { journalEntryId: journal.id } });
    await audit(tx, ctx, { action: "transfer.posted", entity: "account_transfer", entityId: transfer.id, companyId: from.companyId, next: result });
    return result;
  });
}
