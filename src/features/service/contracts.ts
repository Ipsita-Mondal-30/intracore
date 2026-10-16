import { z } from "zod";
import { MemberStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { nextDocumentNumber } from "@/lib/numbering";
import { companySettings } from "@/lib/settings";
import { Decimal, zDecimal } from "@/lib/money";
import { createSystemNotification } from "@/lib/notifications/create";
import { today } from "@/features/finance/ledger";
import { lineFieldsSchema, priceLines, resolveSalesParty } from "@/features/sales/pricing";

/**
 * Annual maintenance contracts: DRAFT → ACTIVE → EXPIRED | CANCELLED | RENEWED.
 * Covered assets and entitlements (service type × included quantity, null = unlimited)
 * are editable only while DRAFT; claims consume entitlements (see claims.ts).
 */

const entitlementSchema = z.object({
  serviceType: z.string().trim().toUpperCase().min(1).max(60),
  quantity: z.number().int().min(1).max(100000).nullish(),
});

const body = z.object({
  startDate: z.coerce.date(),
  endDate: z.coerce.date(),
  value: zDecimal(),
  terms: z.string().trim().max(10000).nullish(),
  assetIds: z.array(z.string().min(1)).max(500).default([]),
  entitlements: z
    .array(entitlementSchema)
    .max(50)
    .default([])
    .refine((e) => new Set(e.map((x) => x.serviceType)).size === e.length, "Each service type can appear once"),
});
const createSchema = body
  .extend({ companyId: z.string().min(1), customerId: z.string().min(1), renewalOfId: z.string().min(1).nullish() })
  .refine((c) => c.endDate >= c.startDate, { message: "End date must be on or after the start date", path: ["endDate"] });
const updateSchema = body.partial();

const include = {
  customer: { select: { id: true, name: true } },
  assets: { include: { asset: { select: { id: true, tag: true, name: true, serialNumber: true, status: true } } } },
  entitlements: { orderBy: { serviceType: "asc" } },
  renewalOf: { select: { id: true, number: true } },
  renewals: { select: { id: true, number: true, status: true } },
} satisfies Prisma.ServiceContractInclude;

export const contractScope = (ctx: AccessContext) => ({
  organizationId: ctx.organizationId,
  companyId: { in: [...ctx.companies.keys()] },
});

async function lockContract(tx: Prisma.TransactionClient, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "service_contracts" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
  const c = await tx.serviceContract.findFirst({ where: { id, ...contractScope(ctx) }, include: { assets: true, entitlements: true } });
  if (!c) throw new AppError("NOT_FOUND", "Contract not found", 404);
  return c;
}

/** Covered assets must be this customer's installed base in the tenant. */
async function validateAssets(tx: Prisma.TransactionClient, ctx: AccessContext, customerId: string, assetIds: string[]) {
  const ids = [...new Set(assetIds)];
  const found = await tx.asset.count({ where: { organizationId: ctx.organizationId, id: { in: ids }, customerId } });
  if (found !== ids.length) throw new AppError("INVALID_REFERENCE", "Every covered asset must belong to the contract's customer", 422);
  return ids;
}

export async function createContract(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "contract.create");
  const data = createSchema.parse(input);
  if (!ctx.companies.has(data.companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  return prisma.$transaction(async (tx) => {
    if (!(await tx.customer.findFirst({ where: { id: data.customerId, organizationId: ctx.organizationId }, select: { id: true } }))) {
      throw new AppError("INVALID_REFERENCE", "Customer not found", 422);
    }
    if (data.renewalOfId) {
      const prev = await tx.serviceContract.findFirst({ where: { id: data.renewalOfId, ...contractScope(ctx) } });
      if (!prev || prev.customerId !== data.customerId) throw new AppError("INVALID_REFERENCE", "The renewed contract must be this customer's", 422);
    }
    const assetIds = await validateAssets(tx, ctx, data.customerId, data.assetIds);
    const contract = await tx.serviceContract.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: data.companyId,
        number: await nextDocumentNumber(tx, ctx.organizationId, data.companyId, "service_contract"),
        customerId: data.customerId,
        startDate: data.startDate,
        endDate: data.endDate,
        value: data.value,
        terms: data.terms ?? null,
        renewalOfId: data.renewalOfId ?? null,
        createdById: ctx.userId,
        assets: { create: assetIds.map((assetId) => ({ assetId })) },
        entitlements: { create: data.entitlements.map((e) => ({ serviceType: e.serviceType, quantity: e.quantity ?? null })) },
      },
      include,
    });
    await audit(tx, ctx, { action: "service_contract.created", entity: "service_contract", entityId: contract.id, companyId: contract.companyId, next: contract });
    return contract;
  });
}

export async function updateContract(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "contract.update");
  const data = updateSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await lockContract(tx, ctx, id);
    if (before.status !== "DRAFT") throw new AppError("INVALID_STATE", "Only draft contracts can be edited", 422);
    if ((data.endDate ?? before.endDate) < (data.startDate ?? before.startDate)) throw new AppError("VALIDATION_ERROR", "End date must be on or after the start date", 422);
    if (data.assetIds) {
      const ids = await validateAssets(tx, ctx, before.customerId, data.assetIds);
      await tx.contractAsset.deleteMany({ where: { contractId: id } });
      await tx.contractAsset.createMany({ data: ids.map((assetId) => ({ organizationId: ctx.organizationId, contractId: id, assetId })) });
    }
    if (data.entitlements) {
      await tx.contractEntitlement.deleteMany({ where: { contractId: id } });
      await tx.contractEntitlement.createMany({ data: data.entitlements.map((e) => ({ organizationId: ctx.organizationId, contractId: id, serviceType: e.serviceType, quantity: e.quantity ?? null })) });
    }
    const updated = await tx.serviceContract.update({
      where: { id },
      data: { startDate: data.startDate, endDate: data.endDate, value: data.value, terms: data.terms },
      include,
    });
    await audit(tx, ctx, {
      action: "service_contract.updated",
      entity: "service_contract",
      entityId: id,
      companyId: before.companyId,
      previous: { startDate: before.startDate, endDate: before.endDate, value: before.value, assets: before.assets.map((a) => a.assetId), entitlements: before.entitlements },
      next: { startDate: updated.startDate, endDate: updated.endDate, value: updated.value, assets: updated.assets.map((a) => a.assetId), entitlements: updated.entitlements },
    });
    return updated;
  });
}

const actionSchemas = {
  activate: z.object({}),
  cancel: z.object({ reason: z.string().trim().min(1, "A reason is required").max(1000) }),
  expire: z.object({}),
};
export type ContractAction = keyof typeof actionSchemas;
export const CONTRACT_ACTIONS = [...Object.keys(actionSchemas), "renewal-quotation"];

const allowed: Record<ContractAction, string[]> = { activate: ["DRAFT"], cancel: ["DRAFT", "ACTIVE"], expire: ["ACTIVE"] };
const target: Record<ContractAction, string> = { activate: "ACTIVE", cancel: "CANCELLED", expire: "EXPIRED" };

export async function transitionContract(ctx: AccessContext, id: string, action: ContractAction, input: unknown) {
  const schema = actionSchemas[action];
  if (!schema) throw new AppError("NOT_FOUND", "Unknown action", 404);
  assertCan(ctx, "contract.update");
  const data = schema.parse(input ?? {}) as { reason?: string };
  return prisma.$transaction(async (tx) => {
    const c = await lockContract(tx, ctx, id);
    if (!allowed[action].includes(c.status)) throw new AppError("INVALID_STATE", `Cannot ${action} a ${c.status} contract`, 422);
    if (action === "activate") {
      if (c.assets.length === 0) throw new AppError("VALIDATION_ERROR", "Add at least one covered asset before activating", 422);
      if (c.entitlements.length === 0) throw new AppError("VALIDATION_ERROR", "Add at least one entitlement before activating", 422);
      if (c.endDate < today()) throw new AppError("INVALID_STATE", "The contract period has already ended", 422);
      // Activating a renewal closes out the contract it renews.
      if (c.renewalOfId) {
        await tx.serviceContract.updateMany({ where: { id: c.renewalOfId, status: { in: ["ACTIVE", "EXPIRED"] } }, data: { status: "RENEWED" } });
      }
    }
    const updated = await tx.serviceContract.update({ where: { id }, data: { status: target[action] }, include });
    await audit(tx, ctx, { action: `service_contract.${action}`, entity: "service_contract", entityId: id, companyId: c.companyId, previous: { status: c.status }, next: { status: updated.status, reason: data.reason } });
    return updated;
  });
}

const renewalSchema = z.object({
  branchId: z.string().min(1),
  /** Defaults to one line at the current contract value. */
  lines: z.array(lineFieldsSchema).min(1).max(200).optional(),
  validUntil: z.coerce.date().optional(),
  notes: z.string().trim().max(10000).nullish(),
});

/**
 * Draft renewal quotation for the customer, priced like sales quotations, linked back
 * via `renewalQuotationId`. Retry-safe: returns the existing quotation when linked.
 */
export async function createRenewalQuotation(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "contract.update");
  assertCan(ctx, "quotation.create");
  const data = renewalSchema.parse(input ?? {});
  return prisma.$transaction(async (tx) => {
    const c = await lockContract(tx, ctx, id);
    if (c.renewalQuotationId) {
      const existing = await tx.quotation.findFirst({ where: { id: c.renewalQuotationId }, include: { lines: true } });
      if (existing) return existing;
    }
    if (!["ACTIVE", "EXPIRED"].includes(c.status)) throw new AppError("INVALID_STATE", `A ${c.status} contract cannot be renewed`, 422);
    const party = await resolveSalesParty(tx, ctx, { companyId: c.companyId, branchId: data.branchId, customerId: c.customerId });
    const days = Math.round((c.endDate.getTime() - c.startDate.getTime()) / 86_400_000);
    const lines = data.lines ?? [{ description: `AMC renewal of ${c.number} (${days + 1} days)`, quantity: new Decimal(1), unitPrice: c.value }];
    for (const l of lines) if (!l.productId && !(l.description && l.unitPrice)) throw new AppError("VALIDATION_ERROR", "Free-text lines need a description and unit price", 422);
    const priced = await priceLines(tx, ctx.organizationId, lines, { intraState: party.intraState, customerId: c.customerId });
    const validity = companySettings(party.companySettings).quotation.defaultValidityDays;
    const quotation = await tx.quotation.create({
      data: {
        organizationId: ctx.organizationId,
        companyId: c.companyId,
        branchId: data.branchId,
        number: await nextDocumentNumber(tx, ctx.organizationId, c.companyId, "quotation"),
        customerId: c.customerId,
        validUntil: data.validUntil ?? new Date(today().getTime() + validity * 86_400_000),
        currency: party.currency,
        placeOfSupplyState: party.placeOfSupplyState,
        terms: c.terms,
        notes: data.notes ?? `Renewal of maintenance contract ${c.number}`,
        ...priced.totals,
        createdById: ctx.userId,
        lines: { create: priced.lines },
      },
      include: { lines: true },
    });
    await tx.serviceContract.update({ where: { id }, data: { renewalQuotationId: quotation.id } });
    await audit(tx, ctx, { action: "quotation.created", entity: "quotation", entityId: quotation.id, companyId: c.companyId, next: { ...quotation, renewalOfContractId: id } });
    await audit(tx, ctx, { action: "service_contract.renewal_quoted", entity: "service_contract", entityId: id, companyId: c.companyId, next: { renewalQuotationId: quotation.id } });
    return quotation;
  });
}

export async function listContracts(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "contract.view");
  const q = listQuerySchema
    .extend({ status: z.enum(["DRAFT", "ACTIVE", "EXPIRED", "CANCELLED", "RENEWED"]).optional(), customerId: z.string().optional(), assetId: z.string().optional(), endingBefore: z.coerce.date().optional() })
    .parse(query);
  const where: Prisma.ServiceContractWhereInput = {
    ...contractScope(ctx),
    status: q.status,
    customerId: q.customerId,
    assets: q.assetId ? { some: { assetId: q.assetId } } : undefined,
    endDate: q.endingBefore ? { lte: q.endingBefore } : undefined,
    ...searchWhere(q.q, ["number"]),
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.serviceContract.findMany({ where, include: { customer: { select: { id: true, name: true } }, _count: { select: { assets: true } } }, ...listArgs(q, ["createdAt", "endDate", "number", "value"], "createdAt") }),
      prisma.serviceContract.count({ where }),
    ]),
  );
}

export async function getContract(ctx: AccessContext, id: string) {
  assertCan(ctx, "contract.view");
  const c = await prisma.serviceContract.findFirst({ where: { id, ...contractScope(ctx) }, include });
  if (!c) throw new AppError("NOT_FOUND", "Contract not found", 404);
  return c;
}

// ─── Jobs ────────────────────────────────────────────────────────────────────

/** Job: ACTIVE contracts past their end date become EXPIRED. */
export async function expireServiceContracts(now = new Date()) {
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const { count } = await prisma.serviceContract.updateMany({ where: { status: "ACTIVE", endDate: { lt: day } }, data: { status: "EXPIRED" } });
  return { expired: count };
}

async function firstOwner(organizationId: string) {
  const m = await prisma.organizationMember.findFirst({ where: { organizationId, isOwner: true, status: MemberStatus.ACTIVE }, select: { userId: true } });
  return m?.userId ?? null;
}

/**
 * Job: one reminder per ACTIVE contract and per warranty ending within `days`. Rows are
 * claimed with a conditional update on `remindedAt` first, so overlapping runs never
 * notify twice. Contract → creator; warranty → assigned user, customer owner, or org owner.
 */
export async function sendContractAndWarrantyReminders(now = new Date(), days = 30) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const until = new Date(from.getTime() + days * 86_400_000);
  let sent = 0;

  const contracts = await prisma.serviceContract.findMany({
    where: { status: "ACTIVE", remindedAt: null, endDate: { gte: from, lte: until } },
    include: { customer: { select: { name: true } } },
    take: 1000,
  });
  for (const c of contracts) {
    await createSystemNotification({
      organizationId: c.organizationId,
      userId: c.createdById,
      type: "service_contract.expiring",
      title: `AMC ${c.number} (${c.customer.name}) ends ${c.endDate.toISOString().slice(0, 10)}`,
      body: "Send a renewal quotation from the contract page.",
      data: { contractId: c.id, href: `/service/contracts/${c.id}` },
      dedupeKey: `contract-expiring:${c.id}:${c.endDate.toISOString().slice(0, 10)}`,
    });
    const claimed = await prisma.serviceContract.updateMany({ where: { id: c.id, remindedAt: null }, data: { remindedAt: now } });
    if (claimed.count === 0) continue;
    sent += 1;
  }

  const warranties = await prisma.warranty.findMany({
    where: { remindedAt: null, endDate: { gte: from, lte: until }, asset: { status: { notIn: ["RETIRED", "DISPOSED"] } } },
    include: { asset: { select: { id: true, tag: true, name: true, assignedToId: true, customer: { select: { name: true, ownerUserId: true } } } } },
    take: 1000,
  });
  for (const w of warranties) {
    const userId = w.asset.assignedToId ?? w.asset.customer?.ownerUserId ?? (await firstOwner(w.organizationId));
    if (!userId) continue; // nobody to tell yet: retried next run instead of being marked reminded
    await createSystemNotification({
      organizationId: w.organizationId,
      userId,
      type: "warranty.expiring",
      title: `Warranty for ${w.asset.tag} ${w.asset.name} ends ${w.endDate.toISOString().slice(0, 10)}`,
      body: w.asset.customer ? `Customer: ${w.asset.customer.name}. Offer an extended warranty or AMC.` : undefined,
      data: { assetId: w.asset.id, warrantyId: w.id, href: `/service/assets/${w.asset.id}` },
      dedupeKey: `warranty-expiring:${w.id}:${w.endDate.toISOString().slice(0, 10)}`,
    });
    const claimed = await prisma.warranty.updateMany({ where: { id: w.id, remindedAt: null }, data: { remindedAt: now } });
    if (claimed.count === 0) continue;
    sent += 1;
  }
  return { sent };
}
