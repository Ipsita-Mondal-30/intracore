import { z } from "zod";
import { FinanceDocStatus, PaymentMethod, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, assertCompanyAccess, companyScopeWhere, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { nextDocumentNumber } from "@/lib/numbering";
import { computeLine, dec, Decimal, isIntraState, sumTotals, zDecimal } from "@/lib/money";
import { purchaseLines } from "@/features/purchasing/bills";
import { isJournaled, postJournal, reverseJournal, today } from "@/features/finance/ledger";

/**
 * Payables: debit notes and vendor payments against posted vendor bills.
 *   debit note posted   mirror of the bill lines it reduces (Dr AP, Cr GRNI/expense, Cr input GST)
 *   payment posted      Dr Accounts payable, Cr Bank/cash ledger
 * Settlement is tracked with PayableAllocation; a bill can never be paid beyond its
 * outstanding balance (bill rows are locked while allocating).
 */

type Db = Prisma.TransactionClient;
const S = FinanceDocStatus;
const ZERO = new Decimal(0);

export const billOutstanding = (b: { grandTotal: Prisma.Decimal; paidAmount: Prisma.Decimal; debitedAmount: Prisma.Decimal }) =>
  dec(b.grandTotal).sub(b.paidAmount).sub(b.debitedAmount);

const reasonSchema = z.object({ reason: z.string({ required_error: "A reason is required" }).trim().min(1, "A reason is required").max(1000) });
const allocationSchema = z.array(z.object({ billId: z.string().min(1), amount: zDecimal().refine((a) => a.gt(0), "Amount must be positive") })).max(200);

async function allocate(
  tx: Db,
  source: { companyId: string; vendorId: string; available: Decimal; paymentId?: string; debitNoteId?: string },
  allocations: { billId: string; amount: Decimal }[],
) {
  const total = allocations.reduce((s, a) => s.add(a.amount), ZERO);
  if (total.gt(source.available)) throw new AppError("OVERALLOCATED", `Only ${source.available.toFixed(2)} is available to allocate`, 422);
  for (const id of [...new Set(allocations.map((a) => a.billId))].sort()) {
    await tx.$queryRaw`SELECT 1 FROM "vendor_bills" WHERE "id" = ${id} FOR UPDATE`;
  }
  for (const a of allocations) {
    const bill = await tx.vendorBill.findUnique({ where: { id: a.billId } });
    if (!bill || bill.companyId !== source.companyId || bill.vendorId !== source.vendorId) {
      throw new AppError("INVALID_REFERENCE", "Bill not found for this vendor and company", 422);
    }
    if (bill.status !== S.POSTED) throw new AppError("INVALID_STATE", `Bill ${bill.number} is not posted`, 422);
    const due = billOutstanding(bill);
    if (a.amount.gt(due)) throw new AppError("OVERPAYMENT", `Bill ${bill.number}: only ${due.toFixed(2)} is outstanding`, 422);
    await tx.payableAllocation.create({
      data: { organizationId: bill.organizationId, companyId: bill.companyId, billId: bill.id, paymentId: source.paymentId ?? null, debitNoteId: source.debitNoteId ?? null, amount: a.amount },
    });
    await tx.vendorBill.update({
      where: { id: bill.id },
      data: source.paymentId ? { paidAmount: { increment: a.amount } } : { debitedAmount: { increment: a.amount } },
    });
  }
  return total;
}

async function unallocate(tx: Db, where: { paymentId?: string; debitNoteId?: string }) {
  const active = await tx.payableAllocation.findMany({ where: { ...where, reversedAt: null } });
  for (const id of [...new Set(active.map((a) => a.billId))].sort()) await tx.$queryRaw`SELECT 1 FROM "vendor_bills" WHERE "id" = ${id} FOR UPDATE`;
  for (const a of active) {
    await tx.payableAllocation.update({ where: { id: a.id }, data: { reversedAt: new Date() } });
    await tx.vendorBill.update({
      where: { id: a.billId },
      data: a.paymentId ? { paidAmount: { decrement: a.amount } } : { debitedAmount: { decrement: a.amount } },
    });
  }
}

// ─── Vendor payments ─────────────────────────────────────────────────────────

const paymentSchema = z.object({
  companyId: z.string().min(1),
  vendorId: z.string().min(1),
  bankAccountId: z.string().min(1),
  paymentDate: z.coerce.date().optional(),
  amount: zDecimal().refine((a) => a.gt(0), "Amount must be positive"),
  method: z.nativeEnum(PaymentMethod).optional(),
  reference: z.string().trim().max(120).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  allocations: allocationSchema.default([]),
});

/** Record and post a payment; unallocated amount is an advance to the vendor. */
export async function createVendorPayment(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "payment.create");
  const data = paymentSchema.parse(input);
  if (!ctx.companies.has(data.companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  return prisma.$transaction(async (tx) => {
    const [vendor, bank] = await Promise.all([
      tx.vendor.findFirst({ where: { id: data.vendorId, organizationId: ctx.organizationId } }),
      tx.bankAccount.findFirst({ where: { id: data.bankAccountId, companyId: data.companyId, organizationId: ctx.organizationId } }),
    ]);
    if (!vendor) throw new AppError("NOT_FOUND", "Vendor not found", 404);
    if (!bank || !bank.isActive) throw new AppError("NOT_FOUND", "Bank/cash account not found in this company", 404);
    const paymentDate = data.paymentDate ?? today();
    const number = await nextDocumentNumber(tx, ctx.organizationId, data.companyId, "vendor_payment", paymentDate);
    const payment = await tx.vendorPayment.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: data.companyId,
        number,
        vendorId: vendor.id,
        bankAccountId: bank.id,
        paymentDate,
        amount: data.amount,
        method: data.method,
        reference: data.reference ?? null,
        notes: data.notes ?? null,
        status: S.POSTED,
        postedAt: new Date(),
        createdById: ctx.userId,
      },
    });
    const allocated = await allocate(tx, { companyId: data.companyId, vendorId: vendor.id, available: data.amount, paymentId: payment.id }, data.allocations);
    const journal = (await isJournaled(tx, data.companyId, paymentDate))
      ? await postJournal(tx, { organizationId: ctx.organizationId, companyId: data.companyId, userId: ctx.userId }, {
          date: paymentDate,
          sourceType: "VENDOR_PAYMENT",
          sourceId: payment.id,
          memo: `Payment ${number}`,
          lines: [
            { account: "ACCOUNTS_PAYABLE", debit: data.amount, vendorId: vendor.id },
            { account: { id: bank.accountId }, credit: data.amount, bankAccountId: bank.id },
          ],
        })
      : null;
    const posted = await tx.vendorPayment.update({ where: { id: payment.id }, data: { allocatedAmount: allocated, journalEntryId: journal?.id ?? null } });
    await audit(tx, ctx, { action: "vendor_payment.posted", entity: "vendor_payment", entityId: payment.id, companyId: data.companyId, next: { ...posted, allocations: data.allocations } });
    return posted;
  });
}

export async function cancelVendorPayment(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "payment.cancel");
  const { reason } = reasonSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "vendor_payments" WHERE "id" = ${id} FOR UPDATE`;
    const p = await tx.vendorPayment.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!p || !ctx.companies.has(p.companyId)) throw new AppError("NOT_FOUND", "Payment not found", 404);
    if (p.status === S.CANCELLED) return p;
    await unallocate(tx, { paymentId: id });
    if (p.journalEntryId) {
      await reverseJournal(tx, { organizationId: ctx.organizationId, companyId: p.companyId, userId: ctx.userId }, p.journalEntryId, today(), `Cancellation of ${p.number}`);
    }
    const cancelled = await tx.vendorPayment.update({ where: { id }, data: { status: S.CANCELLED, allocatedAmount: 0, cancelledAt: new Date(), cancelReason: reason } });
    await audit(tx, ctx, { action: "vendor_payment.cancelled", entity: "vendor_payment", entityId: id, companyId: p.companyId, previous: { status: p.status }, next: { status: S.CANCELLED, reason } });
    return cancelled;
  });
}

/** Apply the unallocated part of a payment or debit note to bills. */
export async function allocateDebit(ctx: AccessContext, input: unknown) {
  const data = z
    .object({ paymentId: z.string().optional(), debitNoteId: z.string().optional(), allocations: allocationSchema.min(1) })
    .refine((d) => Boolean(d.paymentId) !== Boolean(d.debitNoteId), "Give either paymentId or debitNoteId")
    .parse(input);
  assertCan(ctx, data.paymentId ? "payment.create" : "vendor_bill.post");
  return prisma.$transaction(async (tx) => {
    if (data.paymentId) {
      await tx.$queryRaw`SELECT 1 FROM "vendor_payments" WHERE "id" = ${data.paymentId} FOR UPDATE`;
      const p = await tx.vendorPayment.findFirst({ where: { id: data.paymentId, organizationId: ctx.organizationId } });
      if (!p || !ctx.companies.has(p.companyId)) throw new AppError("NOT_FOUND", "Payment not found", 404);
      if (p.status !== S.POSTED) throw new AppError("INVALID_STATE", "Payment is not posted", 422);
      const added = await allocate(tx, { companyId: p.companyId, vendorId: p.vendorId, available: dec(p.amount).sub(p.allocatedAmount), paymentId: p.id }, data.allocations);
      await audit(tx, ctx, { action: "vendor_payment.allocated", entity: "vendor_payment", entityId: p.id, companyId: p.companyId, next: data.allocations });
      return tx.vendorPayment.update({ where: { id: p.id }, data: { allocatedAmount: { increment: added } } });
    }
    await tx.$queryRaw`SELECT 1 FROM "debit_notes" WHERE "id" = ${data.debitNoteId} FOR UPDATE`;
    const dn = await tx.debitNote.findFirst({ where: { id: data.debitNoteId, organizationId: ctx.organizationId } });
    if (!dn) throw new AppError("NOT_FOUND", "Debit note not found", 404);
    assertCompanyAccess(ctx, dn.companyId, dn.branchId);
    if (dn.status !== S.POSTED) throw new AppError("INVALID_STATE", "Debit note is not posted", 422);
    const added = await allocate(tx, { companyId: dn.companyId, vendorId: dn.vendorId, available: dec(dn.grandTotal).sub(dn.appliedAmount), debitNoteId: dn.id }, data.allocations);
    await audit(tx, ctx, { action: "debit_note.allocated", entity: "debit_note", entityId: dn.id, companyId: dn.companyId, next: data.allocations });
    return tx.debitNote.update({ where: { id: dn.id }, data: { appliedAmount: { increment: added } } });
  });
}

export async function listVendorPayments(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "payment.view");
  const q = listQuerySchema.extend({ vendorId: z.string().optional(), status: z.nativeEnum(FinanceDocStatus).optional() }).parse(query);
  const where: Prisma.VendorPaymentWhereInput = {
    organizationId: ctx.organizationId,
    companyId: { in: [...ctx.companies.keys()] },
    vendorId: q.vendorId,
    status: q.status,
    ...searchWhere(q.q, ["number", "reference", "notes"]),
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.vendorPayment.findMany({ where, include: { vendor: { select: { id: true, name: true } }, bankAccount: { select: { name: true } } }, ...listArgs(q, ["createdAt", "paymentDate", "amount"], "createdAt") }),
      prisma.vendorPayment.count({ where }),
    ]),
  );
}

export async function getVendorPayment(ctx: AccessContext, id: string) {
  assertCan(ctx, "payment.view");
  const p = await prisma.vendorPayment.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: { vendor: true, bankAccount: true, allocations: { include: { bill: { select: { id: true, number: true, vendorInvoiceNumber: true } } } } },
  });
  if (!p || !ctx.companies.has(p.companyId)) throw new AppError("NOT_FOUND", "Payment not found", 404);
  const matched = p.journalEntryId ? await prisma.bankTransaction.count({ where: { matchedLine: { entryId: p.journalEntryId } } }) : 0;
  return { ...p, unallocated: dec(p.amount).sub(p.allocatedAmount).toFixed(2), reconciled: matched > 0 };
}

// ─── Debit notes ─────────────────────────────────────────────────────────────

const debitNoteSchema = z.object({
  billId: z.string().min(1),
  noteDate: z.coerce.date().optional(),
  reason: z.string().trim().min(1, "A reason is required").max(1000),
  lines: z
    .array(z.object({ billLineId: z.string().min(1), quantity: zDecimal({ places: 4 }).refine((q) => q.gt(0), "Quantity must be positive"), unitPrice: zDecimal().nullish() }))
    .min(1, "Debit at least one line"),
});

/** Draft debit note against a posted bill (price corrections, returns, short supply). */
export async function createDebitNote(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "vendor_bill.create");
  const data = debitNoteSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const bill = await tx.vendorBill.findFirst({ where: { id: data.billId, organizationId: ctx.organizationId }, include: { lines: true, branch: { include: { company: true } } } });
    if (!bill) throw new AppError("NOT_FOUND", "Bill not found", 404);
    assertCompanyAccess(ctx, bill.companyId, bill.branchId);
    if (bill.status !== S.POSTED) throw new AppError("INVALID_STATE", "Debit notes need a posted bill", 422);
    const intra = isIntraState(bill.branch.stateCode ?? bill.branch.company.stateCode, bill.supplierState);
    type NoteLine = ReturnType<typeof computeLine> & Omit<Prisma.DebitNoteLineUncheckedCreateWithoutDebitNoteInput, keyof ReturnType<typeof computeLine>>;
    const lines: NoteLine[] = [];
    for (const [i, l] of data.lines.entries()) {
      const billLine = bill.lines.find((x) => x.id === l.billLineId);
      if (!billLine) throw new AppError("INVALID_REFERENCE", "Line is not on this bill", 422);
      const debited = await tx.debitNoteLine.aggregate({ where: { billLineId: billLine.id, debitNote: { status: S.POSTED } }, _sum: { quantity: true } });
      const left = dec(billLine.quantity).sub(dec(debited._sum.quantity));
      if (l.quantity.gt(left)) throw new AppError("QUANTITY_EXCEEDED", `${billLine.description}: only ${left.toString()} can still be debited`, 422);
      const unitPrice = l.unitPrice ?? dec(billLine.unitPrice);
      lines.push({
        sortOrder: i,
        billLineId: billLine.id,
        productId: billLine.productId,
        description: billLine.description,
        quantity: l.quantity,
        unitPrice,
        discountPercent: billLine.discountPercent,
        taxRateId: billLine.taxRateId,
        taxRate: billLine.taxRate,
        ...computeLine({ quantity: l.quantity, unitPrice, discountPercent: dec(billLine.discountPercent), taxRate: dec(billLine.taxRate) }, intra),
      });
    }
    const note = await tx.debitNote.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: bill.companyId,
        branchId: bill.branchId,
        billId: bill.id,
        vendorId: bill.vendorId,
        noteDate: data.noteDate ?? today(),
        reason: data.reason,
        ...sumTotals(lines),
        createdById: ctx.userId,
        lines: { create: lines },
      },
      include: { lines: true },
    });
    await audit(tx, ctx, { action: "debit_note.created", entity: "debit_note", entityId: note.id, companyId: note.companyId, next: note });
    return note;
  });
}

export async function postDebitNote(ctx: AccessContext, id: string) {
  assertCan(ctx, "vendor_bill.post");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "debit_notes" WHERE "id" = ${id} FOR UPDATE`;
    const note = await tx.debitNote.findFirst({ where: { id, organizationId: ctx.organizationId }, include: { lines: true } });
    if (!note) throw new AppError("NOT_FOUND", "Debit note not found", 404);
    assertCompanyAccess(ctx, note.companyId, note.branchId);
    if (note.status === S.POSTED) return note;
    if (note.status !== S.DRAFT) throw new AppError("INVALID_STATE", `A ${note.status} debit note cannot be posted`, 422);
    await tx.$queryRaw`SELECT 1 FROM "vendor_bills" WHERE "id" = ${note.billId} FOR UPDATE`;
    for (const l of note.lines) {
      if (!l.billLineId) continue;
      const billLine = await tx.vendorBillLine.findUniqueOrThrow({ where: { id: l.billLineId } });
      const debited = await tx.debitNoteLine.aggregate({ where: { billLineId: l.billLineId, debitNote: { status: S.POSTED } }, _sum: { quantity: true } });
      if (dec(debited._sum.quantity).add(l.quantity).gt(billLine.quantity)) {
        throw new AppError("QUANTITY_EXCEEDED", `${l.description}: debited quantity would exceed the bill`, 422);
      }
    }
    const number = await nextDocumentNumber(tx, note.organizationId, note.companyId, "debit_note", note.noteDate);
    const journal = (await isJournaled(tx, note.companyId, note.noteDate))
      ? await postJournal(tx, { organizationId: ctx.organizationId, companyId: note.companyId, userId: ctx.userId }, {
          date: note.noteDate,
          sourceType: "DEBIT_NOTE",
          sourceId: note.id,
          memo: `Debit note ${number}`,
          lines: await purchaseLines(tx, note, "debit"),
        })
      : null;
    const bill = await tx.vendorBill.findUniqueOrThrow({ where: { id: note.billId } });
    const apply = Decimal.min(dec(note.grandTotal), Decimal.max(billOutstanding(bill), ZERO));
    if (apply.gt(0)) await allocate(tx, { companyId: note.companyId, vendorId: note.vendorId, available: apply, debitNoteId: note.id }, [{ billId: bill.id, amount: apply }]);
    const posted = await tx.debitNote.update({ where: { id }, data: { status: S.POSTED, number, postedAt: new Date(), journalEntryId: journal?.id ?? null, appliedAmount: apply } });
    await audit(tx, ctx, { action: "debit_note.posted", entity: "debit_note", entityId: id, companyId: note.companyId, previous: { status: note.status }, next: { status: S.POSTED, number, applied: apply } });
    return posted;
  });
}

export async function cancelDebitNote(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "vendor_bill.cancel");
  const { reason } = reasonSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "debit_notes" WHERE "id" = ${id} FOR UPDATE`;
    const note = await tx.debitNote.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!note) throw new AppError("NOT_FOUND", "Debit note not found", 404);
    assertCompanyAccess(ctx, note.companyId, note.branchId);
    if (note.status === S.CANCELLED) return note;
    if (note.status === S.POSTED) {
      await unallocate(tx, { debitNoteId: id });
      if (note.journalEntryId) {
        await reverseJournal(tx, { organizationId: ctx.organizationId, companyId: note.companyId, userId: ctx.userId }, note.journalEntryId, today(), `Cancellation of ${note.number}`);
      }
    }
    const cancelled = await tx.debitNote.update({ where: { id }, data: { status: S.CANCELLED, appliedAmount: 0, cancelledAt: new Date(), cancelReason: reason } });
    await audit(tx, ctx, { action: "debit_note.cancelled", entity: "debit_note", entityId: id, companyId: note.companyId, previous: { status: note.status }, next: { status: S.CANCELLED, reason } });
    return cancelled;
  });
}

export async function getDebitNote(ctx: AccessContext, id: string) {
  assertCan(ctx, "vendor_bill.view");
  const note = await prisma.debitNote.findFirst({
    where: { id, organizationId: ctx.organizationId },
    include: { lines: { orderBy: { sortOrder: "asc" } }, bill: { select: { id: true, number: true, vendorInvoiceNumber: true } }, vendor: true },
  });
  if (!note) throw new AppError("NOT_FOUND", "Debit note not found", 404);
  assertCompanyAccess(ctx, note.companyId, note.branchId);
  return note;
}

export async function listDebitNotes(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "vendor_bill.view");
  const q = listQuerySchema.extend({ status: z.nativeEnum(FinanceDocStatus).optional(), vendorId: z.string().optional(), billId: z.string().optional() }).parse(query);
  const where: Prisma.DebitNoteWhereInput = { AND: [companyScopeWhere(ctx), { status: q.status, vendorId: q.vendorId, billId: q.billId }, searchWhere(q.q, ["number", "reason"])] };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.debitNote.findMany({ where, include: { vendor: { select: { id: true, name: true } }, bill: { select: { id: true, number: true } } }, ...listArgs(q, ["createdAt", "noteDate", "grandTotal"], "createdAt") }),
      prisma.debitNote.count({ where }),
    ]),
  );
}
