import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCompanyAccess, can, type AccessContext } from "@/lib/access";
import { leadVisibilityWhere } from "@/features/leads/scope";

/**
 * Records that tasks and documents may attach to. Each resolver returns the record's
 * companyId (null for org-level records) only if the caller may access it, so a
 * client-supplied entityType/entityId is never trusted.
 */
type Resolver = (ctx: AccessContext, id: string) => Promise<{ companyId: string | null } | null>;

const resolvers: Record<string, Resolver> = {
  company: async (ctx, id) => (ctx.companies.has(id) ? { companyId: id } : null),
  branch: async (ctx, id) => {
    const branch = await prisma.branch.findFirst({
      where: { id, organizationId: ctx.organizationId },
      select: { companyId: true },
    });
    if (!branch) return null;
    assertCompanyAccess(ctx, branch.companyId, id);
    return { companyId: branch.companyId };
  },
  lead: async (ctx, id) => {
    const lead = await prisma.lead.findFirst({
      where: { id, ...leadVisibilityWhere(ctx) },
      select: { id: true },
    });
    return lead ? { companyId: null } : null;
  },
  customer: orgRecord("customer.view", (ctx, id) =>
    prisma.customer.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { id: true } })),
  contact: orgRecord("contact.view", (ctx, id) =>
    prisma.contact.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { id: true } })),
  opportunity: orgRecord("opportunity.view", (ctx, id) =>
    prisma.opportunity.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { id: true } })),
  product: orgRecord("product.view", (ctx, id) =>
    prisma.product.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { id: true } })),
  quotation: companyRecord("quotation.view", (ctx, id) =>
    prisma.quotation.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { companyId: true, branchId: true } })),
  sales_order: companyRecord("sales_order.view", (ctx, id) =>
    prisma.salesOrder.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { companyId: true, branchId: true } })),
  vendor: orgRecord("vendor.view", (ctx, id) =>
    prisma.vendor.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { id: true } })),
  warehouse: companyRecord("inventory.view", (ctx, id) =>
    prisma.warehouse.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { companyId: true, branchId: true } })),
  stock_entry: companyRecord("inventory.view", (ctx, id) =>
    prisma.stockEntry.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { companyId: true, branchId: true } })),
  purchase_order: companyRecord("purchase_order.view", (ctx, id) =>
    prisma.purchaseOrder.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { companyId: true, branchId: true } })),
  sales_invoice: companyRecord("invoice.view", (ctx, id) =>
    prisma.salesInvoice.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { companyId: true, branchId: true } })),
  expense_claim: async (ctx, id) => {
    const claim = await prisma.expenseClaim.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { companyId: true, claimantId: true } });
    if (!claim || !ctx.companies.has(claim.companyId)) return null;
    // Claimants attach their own receipts; approvers/payers can see every claim.
    const allowed = claim.claimantId === ctx.userId || can(ctx, "expense.approve") || can(ctx, "expense.pay");
    return allowed ? { companyId: claim.companyId } : null;
  },
  vendor_bill: companyRecord("vendor_bill.view", (ctx, id) =>
    prisma.vendorBill.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { companyId: true, branchId: true } })),
};

/** Org-level record: caller needs the view permission and the row must be in the tenant. */
function orgRecord(permission: string, find: (ctx: AccessContext, id: string) => Promise<unknown>): Resolver {
  return async (ctx, id) => (can(ctx, permission) && (await find(ctx, id)) ? { companyId: null } : null);
}

/** Company-scoped record: also requires a scope covering its company/branch. */
function companyRecord(
  permission: string,
  find: (ctx: AccessContext, id: string) => Promise<{ companyId: string; branchId: string | null } | null>,
): Resolver {
  return async (ctx, id) => {
    if (!can(ctx, permission)) return null;
    const row = await find(ctx, id);
    if (!row) return null;
    assertCompanyAccess(ctx, row.companyId, row.branchId);
    return { companyId: row.companyId };
  };
}

export const entityTypes = () => Object.keys(resolvers);

export async function resolveEntity(ctx: AccessContext, type: string, id: string) {
  const resolver = resolvers[type];
  if (!resolver) {
    throw new AppError("VALIDATION_ERROR", `Unsupported entityType: ${type}`, 422);
  }
  const found = await resolver(ctx, id);
  if (!found) throw new AppError("NOT_FOUND", `${type} not found`, 404);
  return found;
}
