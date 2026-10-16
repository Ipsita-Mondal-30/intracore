import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate } from "@/lib/api/list";
import { assetScope, findAsset } from "@/features/service/assets";
import { contractScope } from "@/features/service/contracts";

/**
 * Warranty / AMC service claims. `submitClaim` checks coverage on the claim date:
 *   WARRANTY: a warranty of the asset in force that covers the service type
 *             (PARTS needs coversParts, LABOR needs coversLabor, REPAIR needs both)
 *   AMC:      an ACTIVE contract of the asset's customer, in its period, covering the
 *             asset, with an entitlement for the service type that has quantity left
 * Covered claims are PENDING until approved; approval re-validates and consumes one
 * unit of the entitlement atomically. Uncovered claims are recorded REJECTED with the
 * reason codes in `decisionReason` (chargeable work).
 */

export const CLAIM_REASONS = {
  NO_WARRANTY: "The asset has no warranty",
  WARRANTY_NOT_STARTED: "The warranty has not started yet",
  WARRANTY_EXPIRED: "The warranty has expired",
  WARRANTY_TYPE_NOT_COVERED: "The warranty does not cover this service type",
  NO_ACTIVE_CONTRACT: "No active maintenance contract covers the asset on this date",
  SERVICE_TYPE_NOT_COVERED: "The contract has no entitlement for this service type",
  ENTITLEMENT_EXHAUSTED: "The contract entitlement for this service type is used up",
} as const;
type Reason = keyof typeof CLAIM_REASONS;

type Coverage =
  | { covered: true; claimType: "WARRANTY" | "AMC"; contractId: string | null; entitlementId: string | null }
  | { covered: false; claimType: "WARRANTY" | "AMC"; reasons: Reason[] };

const dayOf = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));

function warrantyCovers(w: { coversParts: boolean; coversLabor: boolean }, serviceType: string) {
  if (serviceType === "PARTS") return w.coversParts;
  if (serviceType === "LABOR") return w.coversLabor;
  if (serviceType === "REPAIR") return w.coversParts && w.coversLabor;
  return false;
}

async function warrantyCoverage(db: Prisma.TransactionClient, assetId: string, serviceType: string, on: Date): Promise<Reason | null> {
  const warranties = await db.warranty.findMany({ where: { assetId } });
  if (warranties.length === 0) return "NO_WARRANTY";
  const inForce = warranties.filter((w) => w.startDate <= on && w.endDate >= on);
  if (inForce.length === 0) return warranties.some((w) => w.endDate < on) ? "WARRANTY_EXPIRED" : "WARRANTY_NOT_STARTED";
  return inForce.some((w) => warrantyCovers(w, serviceType)) ? null : "WARRANTY_TYPE_NOT_COVERED";
}

async function contractCoverage(
  db: Prisma.TransactionClient,
  asset: { id: string; customerId: string | null },
  serviceType: string,
  on: Date,
  contractId?: string | null,
): Promise<{ reason: Reason } | { contractId: string; entitlementId: string }> {
  if (!asset.customerId) return { reason: "NO_ACTIVE_CONTRACT" };
  const contracts = await db.serviceContract.findMany({
    where: { id: contractId ?? undefined, customerId: asset.customerId, status: "ACTIVE", startDate: { lte: on }, endDate: { gte: on }, assets: { some: { assetId: asset.id } } },
    include: { entitlements: { where: { serviceType } } },
    orderBy: { endDate: "asc" },
  });
  if (contracts.length === 0) return { reason: "NO_ACTIVE_CONTRACT" };
  const entitled = contracts.flatMap((c) => c.entitlements);
  if (entitled.length === 0) return { reason: "SERVICE_TYPE_NOT_COVERED" };
  const open = entitled.find((e) => e.quantity === null || e.usedCount < e.quantity);
  return open ? { contractId: open.contractId, entitlementId: open.id } : { reason: "ENTITLEMENT_EXHAUSTED" };
}

/** Eligibility of one asset/service type on a date, for the requested claim type (or either). */
export async function checkCoverage(
  db: Prisma.TransactionClient,
  asset: { id: string; customerId: string | null },
  serviceType: string,
  on: Date,
  opts: { claimType?: "WARRANTY" | "AMC"; contractId?: string | null } = {},
): Promise<Coverage> {
  const day = dayOf(on);
  const reasons: Reason[] = [];
  if (opts.claimType !== "AMC" && !opts.contractId) {
    const reason = await warrantyCoverage(db, asset.id, serviceType, day);
    if (!reason) return { covered: true, claimType: "WARRANTY", contractId: null, entitlementId: null };
    reasons.push(reason);
  }
  if (opts.claimType !== "WARRANTY") {
    const r = await contractCoverage(db, asset, serviceType, day, opts.contractId);
    if (!("reason" in r)) return { covered: true, claimType: "AMC", ...r };
    reasons.push(r.reason);
  }
  return { covered: false, claimType: opts.claimType ?? (opts.contractId ? "AMC" : "WARRANTY"), reasons };
}

const submitSchema = z.object({
  assetId: z.string().min(1),
  /** When given, the asset must belong to this customer. */
  customerId: z.string().min(1).optional(),
  serviceType: z.string().trim().toUpperCase().min(1).max(60),
  claimType: z.enum(["WARRANTY", "AMC"]).optional(),
  contractId: z.string().min(1).optional(),
  ticketId: z.string().min(1).optional(),
});

const include = {
  asset: { select: { id: true, tag: true, name: true, serialNumber: true, companyId: true, customerId: true } },
  contract: { select: { id: true, number: true } },
  ticket: { select: { id: true, number: true } },
} satisfies Prisma.ServiceClaimInclude;

const withCoverage = <T extends { status: string; decisionReason: string | null }>(claim: T) => ({
  ...claim,
  covered: claim.status === "PENDING" || claim.status === "APPROVED",
});

export async function submitClaim(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "contract.update");
  const data = submitSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const asset = await findAsset(tx, ctx, data.assetId);
    if (data.customerId && asset.customerId !== data.customerId) {
      throw new AppError("ASSET_CUSTOMER_MISMATCH", "The asset does not belong to this customer", 422);
    }
    if (data.ticketId) {
      const ticket = await tx.ticket.findFirst({ where: { id: data.ticketId, organizationId: ctx.organizationId, companyId: asset.companyId }, select: { assetId: true } });
      if (!ticket) throw new AppError("INVALID_REFERENCE", "Ticket not found", 422);
      if (ticket.assetId && ticket.assetId !== asset.id) throw new AppError("INVALID_REFERENCE", "The ticket is for a different asset", 422);
    }
    if (data.contractId && !(await tx.serviceContract.findFirst({ where: { id: data.contractId, ...contractScope(ctx) }, select: { id: true } }))) {
      throw new AppError("INVALID_REFERENCE", "Contract not found", 422);
    }
    const coverage = await checkCoverage(tx, asset, data.serviceType, new Date(), data);
    const claim = await tx.serviceClaim.create({
      data: {
        organizationId: ctx.organizationId,
        assetId: asset.id,
        ticketId: data.ticketId ?? null,
        serviceType: data.serviceType,
        claimType: coverage.claimType,
        contractId: coverage.covered ? coverage.contractId : data.contractId ?? null,
        ...(coverage.covered ? {} : { status: "REJECTED" as const, decisionReason: coverage.reasons.join(","), decidedAt: new Date() }),
      },
      include,
    });
    await audit(tx, ctx, { action: coverage.covered ? "service_claim.submitted" : "service_claim.not_covered", entity: "asset", entityId: asset.id, companyId: asset.companyId, next: { claimId: claim.id, status: claim.status, reason: claim.decisionReason } });
    return withCoverage(claim);
  });
}

const actionSchemas = {
  approve: z.object({}),
  reject: z.object({ reason: z.string().trim().min(1, "A reason is required").max(1000) }),
  cancel: z.object({}),
};
export type ClaimAction = keyof typeof actionSchemas;
export const CLAIM_ACTIONS = Object.keys(actionSchemas) as ClaimAction[];

export async function transitionClaim(ctx: AccessContext, id: string, action: ClaimAction, input: unknown) {
  const schema = actionSchemas[action];
  if (!schema) throw new AppError("NOT_FOUND", "Unknown action", 404);
  assertCan(ctx, action === "cancel" ? "contract.update" : "service.administer");
  const body = schema.parse(input ?? {}) as { reason?: string };

  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "service_claims" WHERE "id" = ${id} AND "organizationId" = ${ctx.organizationId} FOR UPDATE`;
    const claim = await tx.serviceClaim.findFirst({ where: { id, organizationId: ctx.organizationId, asset: assetScope(ctx) }, include: { asset: true } });
    if (!claim) throw new AppError("NOT_FOUND", "Claim not found", 404);
    // Retry of an approval that already happened returns the result, never consumes twice.
    if (action === "approve" && claim.status === "APPROVED") return withCoverage(await tx.serviceClaim.findUniqueOrThrow({ where: { id }, include }));
    if (claim.status !== "PENDING") throw new AppError("INVALID_STATE", `Cannot ${action} a ${claim.status} claim`, 422);

    let data: Prisma.ServiceClaimUncheckedUpdateInput = { decidedById: ctx.userId, decidedAt: new Date() };
    if (action === "approve") {
      const coverage = await checkCoverage(tx, claim.asset, claim.serviceType, claim.createdAt, { claimType: claim.claimType as "WARRANTY" | "AMC", contractId: claim.contractId });
      if (!coverage.covered) throw new AppError(coverage.reasons[0], CLAIM_REASONS[coverage.reasons[0]], 422, { reasons: coverage.reasons });
      if (coverage.entitlementId) {
        // Atomic: never consumes past the included quantity, whatever runs concurrently.
        const consumed = await tx.$executeRaw`
          UPDATE "contract_entitlements" SET "usedCount" = "usedCount" + 1
          WHERE "id" = ${coverage.entitlementId} AND ("quantity" IS NULL OR "usedCount" < "quantity")`;
        if (consumed === 0) throw new AppError("ENTITLEMENT_EXHAUSTED", CLAIM_REASONS.ENTITLEMENT_EXHAUSTED, 422);
      }
      data = { ...data, status: "APPROVED", contractId: coverage.contractId ?? claim.contractId };
    } else if (action === "reject") {
      data = { ...data, status: "REJECTED", decisionReason: body.reason };
    } else {
      data = { ...data, status: "CANCELLED" };
    }
    const updated = await tx.serviceClaim.update({ where: { id }, data, include });
    await audit(tx, ctx, { action: `service_claim.${action}`, entity: "asset", entityId: claim.assetId, companyId: claim.asset.companyId, previous: { claimId: id, status: claim.status }, next: { claimId: id, status: updated.status, reason: body.reason } });
    return withCoverage(updated);
  });
}

export async function listClaims(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "contract.view");
  const q = listQuerySchema
    .extend({ status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED"]).optional(), assetId: z.string().optional(), contractId: z.string().optional() })
    .parse(query);
  const where: Prisma.ServiceClaimWhereInput = { organizationId: ctx.organizationId, asset: assetScope(ctx), status: q.status, assetId: q.assetId, contractId: q.contractId };
  return paginate(q, () =>
    Promise.all([
      prisma.serviceClaim.findMany({ where, include, ...listArgs(q, ["createdAt"], "createdAt") }),
      prisma.serviceClaim.count({ where }),
    ]),
  ).then((p) => ({ ...p, items: p.items.map(withCoverage) }));
}

export async function getClaim(ctx: AccessContext, id: string) {
  assertCan(ctx, "contract.view");
  const claim = await prisma.serviceClaim.findFirst({ where: { id, organizationId: ctx.organizationId, asset: assetScope(ctx) }, include });
  if (!claim) throw new AppError("NOT_FOUND", "Claim not found", 404);
  return withCoverage(claim);
}
