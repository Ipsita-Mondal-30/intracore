import { z } from "zod";
import { ExpenseClaimStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, can, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate } from "@/lib/api/list";
import { nextDocumentNumber } from "@/lib/numbering";
import { Decimal, zDecimal } from "@/lib/money";
import { isJournaled, postJournal, today } from "@/features/finance/ledger";

/**
 * Expense claims: DRAFT → SUBMITTED → APPROVED | REJECTED → PAID (CANCELLED from
 * DRAFT/SUBMITTED). Receipts are attached as documents (entityType "expense_claim").
 *   approved  Dr each category's expense account, Cr Employee reimbursements payable
 *   paid      Dr Employee reimbursements payable, Cr Bank/cash ledger
 * GST on employee claims is not claimed as input credit here (the bill is usually not
 * in the company's GSTIN); `taxAmount` is informational. Review with your accountant.
 */

const S = ExpenseClaimStatus;

const claimSchema = z.object({
  companyId: z.string().min(1),
  title: z.string().trim().min(1).max(200),
  lines: z
    .array(
      z.object({
        categoryId: z.string().min(1),
        expenseDate: z.coerce.date(),
        description: z.string().trim().min(1).max(500),
        amount: zDecimal().refine((a) => a.gt(0), "Amount must be positive"),
        taxAmount: zDecimal().default("0"),
      }),
    )
    .min(1, "Add at least one expense")
    .max(100),
});

const include = {
  lines: { include: { category: { select: { id: true, name: true } } }, orderBy: { expenseDate: "asc" } },
  claimant: { select: { id: true, name: true, email: true } },
  bankAccount: { select: { id: true, name: true } },
} satisfies Prisma.ExpenseClaimInclude;

/** Claimants see their own claims; expense.approve / expense.pay holders see all in scope. */
function visible(ctx: AccessContext): Prisma.ExpenseClaimWhereInput {
  const base = { organizationId: ctx.organizationId, companyId: { in: [...ctx.companies.keys()] } };
  return can(ctx, "expense.approve") || can(ctx, "expense.pay") ? base : { ...base, claimantId: ctx.userId };
}

async function lockClaim(tx: Prisma.TransactionClient, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "expense_claims" WHERE "id" = ${id} FOR UPDATE`;
  const claim = await tx.expenseClaim.findFirst({ where: { id, ...visible(ctx) }, include: { lines: { include: { category: true } } } });
  if (!claim) throw new AppError("NOT_FOUND", "Expense claim not found", 404);
  return claim;
}

async function validateCategories(tx: Prisma.TransactionClient, companyId: string, ids: string[]) {
  const found = await tx.expenseCategory.findMany({ where: { companyId, id: { in: [...new Set(ids)] }, isActive: true } });
  if (found.length !== new Set(ids).size) throw new AppError("INVALID_REFERENCE", "Unknown or inactive expense category", 422);
}

export async function createExpenseClaim(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "expense.create");
  const data = claimSchema.parse(input);
  if (!ctx.companies.has(data.companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  return prisma.$transaction(async (tx) => {
    await validateCategories(tx, data.companyId, data.lines.map((l) => l.categoryId));
    for (const l of data.lines) if (l.taxAmount.gt(l.amount)) throw new AppError("VALIDATION_ERROR", "Tax cannot exceed the amount", 422);
    const claim = await tx.expenseClaim.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: data.companyId,
        number: await nextDocumentNumber(tx, ctx.organizationId, data.companyId, "expense_claim"),
        claimantId: ctx.userId,
        title: data.title,
        totalAmount: data.lines.reduce((s, l) => s.add(l.amount), new Decimal(0)),
        lines: { create: data.lines },
      },
      include,
    });
    await audit(tx, ctx, { action: "expense_claim.created", entity: "expense_claim", entityId: claim.id, companyId: claim.companyId, next: claim });
    return claim;
  });
}

export async function updateExpenseClaim(ctx: AccessContext, id: string, input: unknown) {
  const data = claimSchema.omit({ companyId: true }).parse(input);
  return prisma.$transaction(async (tx) => {
    const claim = await lockClaim(tx, ctx, id);
    if (claim.claimantId !== ctx.userId) throw new AppError("FORBIDDEN", "Only the claimant can edit a claim", 403);
    if (claim.status !== S.DRAFT && claim.status !== S.REJECTED) throw new AppError("INVALID_STATE", "Only draft or rejected claims can be edited", 422);
    await validateCategories(tx, claim.companyId, data.lines.map((l) => l.categoryId));
    await tx.expenseClaimLine.deleteMany({ where: { claimId: id } });
    const updated = await tx.expenseClaim.update({
      where: { id },
      data: { title: data.title, status: S.DRAFT, rejectionReason: null, totalAmount: data.lines.reduce((s, l) => s.add(l.amount), new Decimal(0)), lines: { create: data.lines } },
      include,
    });
    await audit(tx, ctx, { action: "expense_claim.updated", entity: "expense_claim", entityId: id, companyId: claim.companyId, previous: { total: claim.totalAmount }, next: { total: updated.totalAmount } });
    return updated;
  });
}

const actionSchemas = {
  submit: z.object({}),
  approve: z.object({}),
  reject: z.object({ reason: z.string({ required_error: "A reason is required" }).trim().min(1, "A reason is required").max(1000) }),
  cancel: z.object({}),
  pay: z.object({ bankAccountId: z.string().min(1), paidOn: z.coerce.date().optional(), reference: z.string().trim().max(120).optional() }),
};
export type ExpenseAction = keyof typeof actionSchemas;
export const EXPENSE_ACTIONS = Object.keys(actionSchemas) as ExpenseAction[];

export async function transitionExpenseClaim(ctx: AccessContext, id: string, action: ExpenseAction, input: unknown) {
  const schema = actionSchemas[action];
  if (!schema) throw new AppError("NOT_FOUND", "Unknown action", 404);
  const body = schema.parse(input ?? {}) as { reason?: string; bankAccountId?: string; paidOn?: Date; reference?: string };
  if (action === "approve" || action === "reject") assertCan(ctx, "expense.approve");
  if (action === "pay") assertCan(ctx, "expense.pay");

  return prisma.$transaction(async (tx) => {
    const claim = await lockClaim(tx, ctx, id);
    const expect = (...allowed: ExpenseClaimStatus[]) => {
      if (!allowed.includes(claim.status)) throw new AppError("INVALID_STATE", `Cannot ${action} a claim that is ${claim.status}`, 422);
    };
    const scope = { organizationId: ctx.organizationId, companyId: claim.companyId, userId: ctx.userId };
    let data: Prisma.ExpenseClaimUncheckedUpdateInput;
    switch (action) {
      case "submit":
        expect(S.DRAFT);
        if (claim.claimantId !== ctx.userId) throw new AppError("FORBIDDEN", "Only the claimant can submit", 403);
        data = { status: S.SUBMITTED, submittedAt: new Date() };
        break;
      case "cancel":
        expect(S.DRAFT, S.SUBMITTED);
        if (claim.claimantId !== ctx.userId) throw new AppError("FORBIDDEN", "Only the claimant can withdraw a claim", 403);
        data = { status: S.CANCELLED };
        break;
      case "reject":
        expect(S.SUBMITTED);
        data = { status: S.REJECTED, rejectionReason: body.reason };
        break;
      case "approve": {
        expect(S.SUBMITTED);
        if (claim.claimantId === ctx.userId && !ctx.isOwner) throw new AppError("FORBIDDEN", "You cannot approve your own claim", 403);
        const date = today();
        const journal = (await isJournaled(tx, claim.companyId, date))
          ? await postJournal(tx, scope, {
              date,
              sourceType: "EXPENSE_CLAIM",
              sourceId: claim.id,
              sourceEvent: "approve",
              memo: `Expense claim ${claim.number}`,
              lines: [
                ...claim.lines.map((l) => ({ account: { id: l.category.accountId }, debit: l.amount, description: l.description })),
                { account: "EXPENSE_CLAIMS_PAYABLE" as const, credit: claim.totalAmount },
              ],
            })
          : null;
        data = { status: S.APPROVED, approvedAt: new Date(), approvedById: ctx.userId, approvalJournalId: journal?.id ?? null };
        break;
      }
      case "pay": {
        expect(S.APPROVED);
        const bank = await tx.bankAccount.findFirst({ where: { id: body.bankAccountId, companyId: claim.companyId, isActive: true } });
        if (!bank) throw new AppError("NOT_FOUND", "Bank/cash account not found in this company", 404);
        const date = body.paidOn ?? today();
        const journal = claim.approvalJournalId
          ? await postJournal(tx, scope, {
              date,
              sourceType: "EXPENSE_CLAIM",
              sourceId: claim.id,
              sourceEvent: "pay",
              memo: `Reimbursement ${claim.number}`,
              lines: [
                { account: "EXPENSE_CLAIMS_PAYABLE", debit: claim.totalAmount },
                { account: { id: bank.accountId }, credit: claim.totalAmount, bankAccountId: bank.id },
              ],
            })
          : null;
        data = { status: S.PAID, paidAt: date, bankAccountId: bank.id, paymentReference: body.reference ?? null, paymentJournalId: journal?.id ?? null };
        break;
      }
    }
    const updated = await tx.expenseClaim.update({ where: { id }, data: data!, include });
    await audit(tx, ctx, { action: `expense_claim.${action}`, entity: "expense_claim", entityId: id, companyId: claim.companyId, previous: { status: claim.status }, next: { status: updated.status, reason: body.reason } });
    return updated;
  });
}

export async function listExpenseClaims(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "expense.view");
  const q = listQuerySchema.extend({ status: z.nativeEnum(ExpenseClaimStatus).optional(), mine: z.enum(["true", "false"]).optional() }).parse(query);
  const where: Prisma.ExpenseClaimWhereInput = { ...visible(ctx), status: q.status, claimantId: q.mine === "true" ? ctx.userId : undefined };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.expenseClaim.findMany({ where, include: { claimant: { select: { id: true, name: true, email: true } } }, ...listArgs(q, ["createdAt", "totalAmount"], "createdAt") }),
      prisma.expenseClaim.count({ where }),
    ]),
  );
}

export async function getExpenseClaim(ctx: AccessContext, id: string) {
  assertCan(ctx, "expense.view");
  const claim = await prisma.expenseClaim.findFirst({ where: { id, ...visible(ctx) }, include });
  if (!claim) throw new AppError("NOT_FOUND", "Expense claim not found", 404);
  return claim;
}

export async function listExpenseCategories(ctx: AccessContext, companyId: string) {
  assertCan(ctx, "expense.view");
  if (!ctx.companies.has(companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  return prisma.expenseCategory.findMany({ where: { companyId }, include: { account: { select: { code: true, name: true } } }, orderBy: { name: "asc" } });
}

export async function createExpenseCategory(ctx: AccessContext, companyId: string, input: unknown) {
  assertCan(ctx, "finance.administer");
  if (ctx.companies.get(companyId) !== "all") throw new AppError("NOT_FOUND", "Company not found", 404);
  const data = z.object({ name: z.string().trim().min(1).max(80), accountId: z.string().min(1) }).parse(input);
  return prisma.$transaction(async (tx) => {
    const account = await tx.account.findFirst({ where: { id: data.accountId, companyId } });
    if (!account || account.type !== "EXPENSE" || account.isGroup) throw new AppError("INVALID_ACCOUNT", "Choose an expense posting account", 422);
    const category = await tx.expenseCategory.create({ data: { ...data, organizationId: ctx.organizationId, companyId } });
    await audit(tx, ctx, { action: "expense_category.created", entity: "expense_category", entityId: category.id, companyId, next: category });
    return category;
  });
}

