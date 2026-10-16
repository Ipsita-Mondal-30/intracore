import { z } from "zod";
import type { LoyaltyLedgerEntry, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, companyScopeWhere, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate } from "@/lib/api/list";
import { Decimal } from "@/lib/money";
import { orgSettings } from "@/lib/settings";

/**
 * Loyalty points ledger (append-only; entries are never updated or deleted).
 *   EARN      + floor(invoice grandTotal × pointsPerCurrencyUnit), once per POSTED sales invoice
 *   REVERSAL  − the invoice's earned points when it is CANCELLED, clamped to the current balance
 *              (points already redeemed are not clawed back; the shortfall is noted in `reason`)
 *   REDEEM    − points ≥ minRedeemPoints and ≤ balance; value = points × pointValue
 *   ADJUST    ± manual correction with a reason; can't take the balance below zero
 *   EXPIRE    − what is left of an EARN lot once its `expiresAt` passes
 * Every write holds a per-customer advisory lock, so `balanceAfter` (= running sum) is exact and
 * concurrent redemptions can't overspend. The balance never goes negative.
 *
 * Expiry uses FIFO consumption: debits (REDEEM, EXPIRE, REVERSAL, negative ADJUST) use the oldest
 * credits first, so lot i still holds clamp(cumulativeCredits_i − totalDebits, 0, lot_i). If
 * `expiryDays` changes, lots can expire out of creation order and this becomes an approximation.
 * Earn/redeem/adjust need the programme enabled (422 LOYALTY_DISABLED); reversal and expiry always run.
 */

type Tx = Prisma.TransactionClient;
const INVOICE = "SALES_INVOICE";

async function programme(db: Tx | typeof prisma, organizationId: string, require = true) {
  const org = await db.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { settings: true } });
  const settings = orgSettings(org.settings).loyalty;
  if (require && !settings.enabled) throw new AppError("LOYALTY_DISABLED", "The loyalty programme is not enabled", 422);
  return settings;
}

/** Lock the customer's ledger for this transaction and return the current balance. */
async function lockBalance(tx: Tx, organizationId: string, customerId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`loyalty:${organizationId}:${customerId}`}, 0))`;
  const sum = await tx.loyaltyLedgerEntry.aggregate({ where: { organizationId, customerId }, _sum: { points: true } });
  return sum._sum.points ?? 0;
}

async function append(tx: Tx, entry: Omit<Prisma.LoyaltyLedgerEntryUncheckedCreateInput, "balanceAfter">, balance: number) {
  return tx.loyaltyLedgerEntry.create({ data: { ...entry, balanceAfter: balance + entry.points } });
}

async function assertCustomer(db: Tx | typeof prisma, ctx: AccessContext, customerId: string) {
  if (!(await db.customer.count({ where: { id: customerId, organizationId: ctx.organizationId } }))) throw new AppError("NOT_FOUND", "Customer not found", 404);
}

async function findInvoice(tx: Tx, ctx: AccessContext, invoiceId: string) {
  const invoice = await tx.salesInvoice.findFirst({ where: { id: invoiceId, ...companyScopeWhere(ctx) } });
  if (!invoice) throw new AppError("NOT_FOUND", "Invoice not found", 404);
  return invoice;
}

/** Earn points for a POSTED sales invoice. Retry-safe: returns the existing entry; null when it earns 0 points. */
export async function earnForInvoice(ctx: AccessContext, invoiceId: string) {
  assertCan(ctx, "loyalty.manage");
  return prisma.$transaction(async (tx) => {
    const invoice = await findInvoice(tx, ctx, invoiceId);
    const settings = await programme(tx, ctx.organizationId);
    if (invoice.status !== "POSTED") throw new AppError("INVALID_STATE", "Points are earned only on posted invoices", 422);
    const balance = await lockBalance(tx, ctx.organizationId, invoice.customerId);
    const key = { organizationId: ctx.organizationId, sourceType: INVOICE, sourceId: invoice.id };
    const existing = await tx.loyaltyLedgerEntry.findUnique({ where: { organizationId_sourceType_sourceId_kind: { ...key, kind: "EARN" } } });
    if (existing) return existing;
    const points = new Decimal(invoice.grandTotal).mul(settings.pointsPerCurrencyUnit).floor().toNumber();
    if (points <= 0) return null;
    const expiresAt = settings.expiryDays ? new Date(Date.now() + settings.expiryDays * 86_400_000) : null;
    const entry = await append(tx, { ...key, customerId: invoice.customerId, kind: "EARN", points, expiresAt, reason: `Invoice ${invoice.number ?? invoice.id}`, createdById: ctx.userId }, balance);
    await audit(tx, ctx, { action: "loyalty.earned", entity: "customer", entityId: invoice.customerId, companyId: invoice.companyId, next: entry });
    return entry;
  });
}

/** Reverse an invoice's earned points once it is CANCELLED. Retry-safe; null when nothing was earned. */
export async function reverseForInvoice(ctx: AccessContext, invoiceId: string) {
  assertCan(ctx, "loyalty.manage");
  return prisma.$transaction(async (tx) => {
    const invoice = await findInvoice(tx, ctx, invoiceId);
    if (invoice.status !== "CANCELLED") throw new AppError("INVALID_STATE", "Only cancelled invoices are reversed", 422);
    const balance = await lockBalance(tx, ctx.organizationId, invoice.customerId);
    const key = { organizationId: ctx.organizationId, sourceType: INVOICE, sourceId: invoice.id };
    const unique = (kind: string) => ({ organizationId_sourceType_sourceId_kind: { ...key, kind } });
    const existing = await tx.loyaltyLedgerEntry.findUnique({ where: unique("REVERSAL") });
    if (existing) return existing;
    const earned = await tx.loyaltyLedgerEntry.findUnique({ where: unique("EARN") });
    if (!earned) return null;
    const points = Math.min(earned.points, balance);
    const reason = points < earned.points
      ? `Invoice ${invoice.number ?? invoice.id} cancelled: ${points} of ${earned.points} points reversed (${earned.points - points} already used)`
      : `Invoice ${invoice.number ?? invoice.id} cancelled`;
    const entry = await append(tx, { ...key, customerId: invoice.customerId, kind: "REVERSAL", points: -points, reason, createdById: ctx.userId }, balance);
    await audit(tx, ctx, { action: "loyalty.reversed", entity: "customer", entityId: invoice.customerId, companyId: invoice.companyId, next: entry });
    return entry;
  });
}

const redeemSchema = z.object({
  points: z.coerce.number().int("Points must be a whole number").positive(),
  /** e.g. the bill number the points were applied to; the same reference is never redeemed twice */
  reference: z.string().trim().min(1).max(120).optional(),
});

export async function redeemPoints(ctx: AccessContext, customerId: string, input: unknown) {
  assertCan(ctx, "loyalty.manage");
  const data = redeemSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await assertCustomer(tx, ctx, customerId);
    const settings = await programme(tx, ctx.organizationId);
    if (data.points < settings.minRedeemPoints) throw new AppError("BELOW_MINIMUM", `Redeem at least ${settings.minRedeemPoints} points`, 422);
    const balance = await lockBalance(tx, ctx.organizationId, customerId);
    if (data.reference) {
      const prior = await tx.loyaltyLedgerEntry.findUnique({ where: { organizationId_sourceType_sourceId_kind: { organizationId: ctx.organizationId, sourceType: "REDEMPTION", sourceId: data.reference, kind: "REDEEM" } } });
      if (prior) {
        if (prior.customerId === customerId && prior.points === -data.points) return withValue(prior, settings.pointValue);
        throw new AppError("CONFLICT", `Reference ${data.reference} was already redeemed`, 409);
      }
    }
    if (data.points > balance) throw new AppError("INSUFFICIENT_POINTS", `Only ${balance} points available`, 422, { balance });
    const entry = await append(tx, {
      organizationId: ctx.organizationId,
      customerId,
      kind: "REDEEM",
      points: -data.points,
      sourceType: data.reference ? "REDEMPTION" : null,
      sourceId: data.reference ?? null,
      reason: data.reference ? `Redeemed against ${data.reference}` : "Redeemed",
      createdById: ctx.userId,
    }, balance);
    await audit(tx, ctx, { action: "loyalty.redeemed", entity: "customer", entityId: customerId, next: entry });
    return withValue(entry, settings.pointValue);
  });
}

const withValue = (entry: LoyaltyLedgerEntry, pointValue: number) => ({ ...entry, value: new Decimal(-entry.points).mul(pointValue).toFixed(2) });

const adjustSchema = z.object({
  points: z.coerce.number().int("Points must be a whole number").refine((n) => n !== 0, "Points can't be zero"),
  reason: z.string({ required_error: "A reason is required" }).trim().min(1, "A reason is required").max(500),
});

export async function adjustPoints(ctx: AccessContext, customerId: string, input: unknown) {
  assertCan(ctx, "loyalty.manage");
  const data = adjustSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    await assertCustomer(tx, ctx, customerId);
    await programme(tx, ctx.organizationId);
    const balance = await lockBalance(tx, ctx.organizationId, customerId);
    if (balance + data.points < 0) throw new AppError("INSUFFICIENT_POINTS", `Only ${balance} points available`, 422, { balance });
    const entry = await append(tx, { organizationId: ctx.organizationId, customerId, kind: "ADJUST", points: data.points, reason: data.reason, createdById: ctx.userId }, balance);
    await audit(tx, ctx, { action: "loyalty.adjusted", entity: "customer", entityId: customerId, next: entry });
    return entry;
  });
}

/** Expiry job: expire the unused remainder of every EARN lot past `expiresAt`. Idempotent (one EXPIRE per lot). */
export async function expireLoyaltyPoints(now = new Date()) {
  const due = await prisma.loyaltyLedgerEntry.findMany({ where: { kind: "EARN", expiresAt: { lte: now } }, select: { id: true, organizationId: true, customerId: true } });
  const done = new Set(
    (await prisma.loyaltyLedgerEntry.findMany({ where: { kind: "EXPIRE", sourceType: "LOYALTY_EARN", sourceId: { in: due.map((d) => d.id) } }, select: { sourceId: true } })).map((e) => e.sourceId),
  );
  const customers = new Map<string, { organizationId: string; customerId: string }>();
  for (const d of due) if (!done.has(d.id)) customers.set(`${d.organizationId}:${d.customerId}`, d);

  let expiredPoints = 0;
  for (const { organizationId, customerId } of customers.values()) {
    expiredPoints += await prisma.$transaction(async (tx) => {
      let balance = await lockBalance(tx, organizationId, customerId);
      const entries = await tx.loyaltyLedgerEntry.findMany({ where: { organizationId, customerId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
      const expired = new Set(entries.filter((e) => e.kind === "EXPIRE").map((e) => e.sourceId));
      let debits = -entries.filter((e) => e.points < 0).reduce((s, e) => s + e.points, 0);
      let credits = 0;
      let total = 0;
      for (const lot of entries) {
        if (lot.points <= 0) continue;
        credits += lot.points;
        if (lot.kind !== "EARN" || !lot.expiresAt || lot.expiresAt > now || expired.has(lot.id)) continue;
        const remaining = Math.min(lot.points, Math.max(0, credits - debits));
        await tx.loyaltyLedgerEntry.create({
          data: {
            organizationId, customerId, kind: "EXPIRE", points: -remaining, balanceAfter: balance - remaining,
            sourceType: "LOYALTY_EARN", sourceId: lot.id, reason: remaining ? `${remaining} points expired` : "Lot fully used before expiry",
          },
        });
        balance -= remaining;
        debits += remaining;
        total += remaining;
      }
      return total;
    });
  }
  return { customers: customers.size, expiredPoints };
}

export async function loyaltyBalance(ctx: AccessContext, customerId: string) {
  assertCan(ctx, "loyalty.view");
  await assertCustomer(prisma, ctx, customerId);
  const settings = await programme(prisma, ctx.organizationId, false);
  const sum = await prisma.loyaltyLedgerEntry.aggregate({ where: { organizationId: ctx.organizationId, customerId }, _sum: { points: true } });
  const balance = sum._sum.points ?? 0;
  return {
    customerId,
    balance,
    value: new Decimal(balance).mul(settings.pointValue).toFixed(2),
    programme: { enabled: settings.enabled, minRedeemPoints: settings.minRedeemPoints, pointValue: settings.pointValue, pointsPerCurrencyUnit: settings.pointsPerCurrencyUnit, expiryDays: settings.expiryDays },
  };
}

export async function loyaltyStatement(ctx: AccessContext, customerId: string, query: unknown) {
  assertCan(ctx, "loyalty.view");
  await assertCustomer(prisma, ctx, customerId);
  const q = listQuerySchema.parse(query);
  const where = { organizationId: ctx.organizationId, customerId };
  return paginate(q, () =>
    prisma.$transaction([prisma.loyaltyLedgerEntry.findMany({ where, ...listArgs(q, ["createdAt"], "createdAt") }), prisma.loyaltyLedgerEntry.count({ where })]),
  );
}
