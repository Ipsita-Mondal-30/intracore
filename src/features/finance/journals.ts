import { z } from "zod";
import { JournalStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { nextDocumentNumber } from "@/lib/numbering";
import { dec, Decimal, money, zDecimal } from "@/lib/money";
import { periodFor, reverseJournal, today } from "@/features/finance/ledger";

/**
 * Manual journals: DRAFT (editable, deletable) → POSTED (immutable) → REVERSED by an
 * equal and opposite journal. System journals (invoices, bills, stock...) are never
 * created or edited here.
 */

const lineSchema = z
  .object({
    accountId: z.string().min(1),
    debit: zDecimal().default("0"),
    credit: zDecimal().default("0"),
    description: z.string().trim().max(500).nullish(),
  })
  .refine((l) => l.debit.isZero() !== l.credit.isZero(), "Each line is either a debit or a credit");

const journalSchema = z.object({
  companyId: z.string().min(1),
  date: z.coerce.date(),
  memo: z.string().trim().min(1, "Describe the journal").max(500),
  lines: z.array(lineSchema).min(2, "A journal needs at least two lines").max(200),
});

function assertFullCompany(ctx: AccessContext, companyId: string) {
  if (ctx.companies.get(companyId) !== "all") throw new AppError("NOT_FOUND", "Company not found", 404);
}

async function checkAccounts(tx: Prisma.TransactionClient, companyId: string, ids: string[]) {
  const accounts = await tx.account.findMany({ where: { companyId, id: { in: [...new Set(ids)] }, isGroup: false, isActive: true } });
  if (accounts.length !== new Set(ids).size) throw new AppError("INVALID_ACCOUNT", "Use active posting accounts of this company", 422);
}

const totals = (lines: { debit: Decimal; credit: Decimal }[]) => ({
  totalDebit: lines.reduce((s, l) => s.add(l.debit), new Decimal(0)),
  totalCredit: lines.reduce((s, l) => s.add(l.credit), new Decimal(0)),
});

export async function createManualJournal(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "finance.post");
  const data = journalSchema.parse(input);
  assertFullCompany(ctx, data.companyId);
  return prisma.$transaction(async (tx) => {
    await checkAccounts(tx, data.companyId, data.lines.map((l) => l.accountId));
    const entry = await tx.journalEntry.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: data.companyId,
        date: data.date,
        sourceType: "MANUAL",
        memo: data.memo,
        createdById: ctx.userId,
        ...totals(data.lines),
        lines: { create: data.lines.map((l) => ({ companyId: data.companyId, accountId: l.accountId, debit: money(l.debit), credit: money(l.credit), description: l.description ?? null })) },
      },
      include: { lines: true },
    });
    await audit(tx, ctx, { action: "journal.drafted", entity: "journal_entry", entityId: entry.id, companyId: data.companyId, next: entry });
    return entry;
  });
}

async function lockDraft(tx: Prisma.TransactionClient, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "journal_entries" WHERE "id" = ${id} FOR UPDATE`;
  const entry = await tx.journalEntry.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { lines: true } });
  if (!entry) throw new AppError("NOT_FOUND", "Journal not found", 404);
  assertFullCompany(ctx, entry.companyId);
  return entry;
}

export async function updateManualJournal(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "finance.post");
  const data = journalSchema.omit({ companyId: true }).parse(input);
  return prisma.$transaction(async (tx) => {
    const entry = await lockDraft(tx, ctx, id);
    if (entry.status !== JournalStatus.DRAFT || entry.sourceType !== "MANUAL") throw new AppError("INVALID_STATE", "Only draft manual journals can be edited", 422);
    await checkAccounts(tx, entry.companyId, data.lines.map((l) => l.accountId));
    await tx.journalLine.deleteMany({ where: { entryId: id } });
    return tx.journalEntry.update({
      where: { id },
      data: {
        date: data.date,
        memo: data.memo,
        ...totals(data.lines),
        lines: { create: data.lines.map((l) => ({ companyId: entry.companyId, accountId: l.accountId, debit: money(l.debit), credit: money(l.credit), description: l.description ?? null })) },
      },
      include: { lines: true },
    });
  });
}

export async function deleteManualJournal(ctx: AccessContext, id: string) {
  assertCan(ctx, "finance.post");
  return prisma.$transaction(async (tx) => {
    const entry = await lockDraft(tx, ctx, id);
    if (entry.status !== JournalStatus.DRAFT) throw new AppError("INVALID_STATE", "Posted journals cannot be deleted; reverse them", 422);
    await tx.journalEntry.delete({ where: { id } });
    await audit(tx, ctx, { action: "journal.deleted", entity: "journal_entry", entityId: id, companyId: entry.companyId, previous: entry });
    return { id };
  });
}

/** Post a draft: balanced, dated in an open period, numbered. Retry-safe. */
export async function postManualJournal(ctx: AccessContext, id: string) {
  assertCan(ctx, "finance.post");
  return prisma.$transaction(async (tx) => {
    const entry = await lockDraft(tx, ctx, id);
    if (entry.status === JournalStatus.POSTED) return entry;
    if (entry.status !== JournalStatus.DRAFT) throw new AppError("INVALID_STATE", `A ${entry.status} journal cannot be posted`, 422);
    const debit = entry.lines.reduce((s, l) => s.add(l.debit), new Decimal(0));
    const credit = entry.lines.reduce((s, l) => s.add(l.credit), new Decimal(0));
    if (!debit.eq(credit) || debit.isZero()) throw new AppError("UNBALANCED", `Debits ${debit.toFixed(2)} do not equal credits ${credit.toFixed(2)}`, 422);
    await checkAccounts(tx, entry.companyId, entry.lines.map((l) => l.accountId));
    const period = await periodFor(tx, entry.companyId, entry.date);
    const posted = await tx.journalEntry.update({
      where: { id },
      data: {
        status: JournalStatus.POSTED,
        number: await nextDocumentNumber(tx, entry.organizationId, entry.companyId, "journal", entry.date),
        periodId: period.id,
        postedAt: new Date(),
        postedById: ctx.userId,
        sourceId: entry.id,
      },
    });
    await audit(tx, ctx, { action: "journal.posted", entity: "journal_entry", entityId: id, companyId: entry.companyId, next: { number: posted.number, total: debit } });
    return posted;
  });
}

/** Reverse any posted journal (manual or system) dated `date` (default today). */
export async function reversePostedJournal(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "finance.post");
  const { date, reason } = z.object({ date: z.coerce.date().optional(), reason: z.string().trim().min(1, "A reason is required").max(500) }).parse(input ?? {});
  return prisma.$transaction(async (tx) => {
    const entry = await tx.journalEntry.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!entry) throw new AppError("NOT_FOUND", "Journal not found", 404);
    assertFullCompany(ctx, entry.companyId);
    if (entry.sourceType !== "MANUAL") {
      throw new AppError("INVALID_STATE", "System journals are reversed by cancelling their source document", 422);
    }
    const reversal = await reverseJournal(tx, { organizationId: ctx.organizationId, companyId: entry.companyId, userId: ctx.userId }, id, date ?? today(), reason);
    await audit(tx, ctx, { action: "journal.reversed", entity: "journal_entry", entityId: id, companyId: entry.companyId, next: { reversalId: reversal.id, reason } });
    return reversal;
  });
}

export async function listJournals(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "finance.view");
  const q = listQuerySchema
    .extend({ companyId: z.string().optional(), status: z.nativeEnum(JournalStatus).optional(), sourceType: z.string().optional(), from: z.coerce.date().optional(), to: z.coerce.date().optional() })
    .parse(query);
  const where: Prisma.JournalEntryWhereInput = {
    organizationId: ctx.organizationId,
    companyId: q.companyId ?? { in: [...ctx.companies.keys()] },
    status: q.status,
    sourceType: q.sourceType,
    date: { gte: q.from, lte: q.to },
    ...searchWhere(q.q, ["number", "memo"]),
  };
  if (q.companyId && !ctx.companies.has(q.companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  return paginate(q, () =>
    prisma.$transaction([
      prisma.journalEntry.findMany({ where, ...listArgs(q, ["date", "createdAt", "totalDebit"], "date") }),
      prisma.journalEntry.count({ where }),
    ]),
  );
}

export async function getJournal(ctx: AccessContext, id: string) {
  assertCan(ctx, "finance.view");
  const entry = await prisma.journalEntry.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: { lines: { include: { account: { select: { code: true, name: true, type: true } } } }, reversalOf: { select: { id: true, number: true } }, reversedBy: { select: { id: true, number: true } }, period: true },
  });
  if (!entry || !ctx.companies.has(entry.companyId)) throw new AppError("NOT_FOUND", "Journal not found", 404);
  return { ...entry, balanced: dec(entry.totalDebit).eq(entry.totalCredit) };
}
