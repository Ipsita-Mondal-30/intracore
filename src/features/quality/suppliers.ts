import { z } from "zod";
import { PurchaseOrderStatus, StockEntryStatus, StockEntryType, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, can, companyScopeWhere, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate } from "@/lib/api/list";
import { dec, Decimal } from "@/lib/money";
import { fullCompanyIds } from "@/features/manufacturing/scope";

const ZERO = new Decimal(0);
const DAY = 86_400_000;

export const QUALIFICATION_STATUSES = ["APPROVED", "CONDITIONAL", "PENDING", "BLOCKED"] as const;

// ─── Supplier evaluations and qualification ─────────────────────────────────

const score = z.coerce.number().int().min(0).max(100);
const evaluationSchema = z.object({
  vendorId: z.string().min(1),
  evaluatedOn: z.coerce.date().optional(),
  qualityScore: score,
  deliveryScore: score,
  priceScore: score,
  notes: z.string().trim().max(4000).nullish(),
  /** Optionally change the vendor's qualification (BLOCKED vendors get no new purchase orders) */
  qualificationStatus: z.enum(QUALIFICATION_STATUSES).optional(),
});

/** Scores are 0–100. Setting qualificationStatus is audited on the vendor. */
export async function createSupplierEvaluation(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "supplier.evaluate");
  const data = evaluationSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const vendor = await tx.vendor.findFirst({ where: { id: data.vendorId, organizationId: ctx.organizationId } });
    if (!vendor) throw new AppError("NOT_FOUND", "Vendor not found", 404);
    const { qualificationStatus, evaluatedOn, ...scores } = data;
    const evaluation = await tx.supplierEvaluation.create({
      data: { ...scores, organizationId: ctx.organizationId, evaluatedOn: evaluatedOn ?? new Date(), evaluatorId: ctx.userId },
    });
    await audit(tx, ctx, { action: "supplier_evaluation.created", entity: "vendor", entityId: vendor.id, next: evaluation });
    if (qualificationStatus && qualificationStatus !== vendor.qualificationStatus) {
      await tx.vendor.update({ where: { id: vendor.id }, data: { qualificationStatus } });
      await audit(tx, ctx, {
        action: "vendor.qualification_changed",
        entity: "vendor",
        entityId: vendor.id,
        previous: { qualificationStatus: vendor.qualificationStatus },
        next: { qualificationStatus, evaluationId: evaluation.id },
      });
    }
    return { ...evaluation, qualificationStatus: qualificationStatus ?? vendor.qualificationStatus };
  });
}

export async function listSupplierEvaluations(ctx: AccessContext, query: unknown) {
  if (!can(ctx, "supplier.evaluate")) assertCan(ctx, "vendor.view");
  const q = listQuerySchema.extend({ vendorId: z.string().optional() }).parse(query);
  const where: Prisma.SupplierEvaluationWhereInput = { organizationId: ctx.organizationId, vendorId: q.vendorId };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.supplierEvaluation.findMany({
        where,
        include: { vendor: { select: { id: true, name: true, qualificationStatus: true } } },
        ...listArgs(q, ["evaluatedOn", "createdAt"], "evaluatedOn"),
      }),
      prisma.supplierEvaluation.count({ where }),
    ]),
  );
}

// ─── Procurement report ──────────────────────────────────────────────────────

const reportSchema = z.object({
  companyId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

const pct = (part: Decimal, whole: Decimal) => (whole.gt(0) ? part.div(whole).mul(100).toDecimalPlaces(1).toString() : null);

/**
 * Per vendor, for purchase orders dated in [from, to] that were approved (not draft,
 * pending or cancelled), in the caller's companies:
 * - orderValue: Σ PO grand total;
 * - onTimeReceiptPct: posted goods receipts on or before the PO's expected date, out of
 *   receipts on POs that have one;
 * - avgLeadTimeDays: order date → first posted receipt, averaged over POs with a receipt;
 * - rejectionRatePct: rejected ÷ inspected on those receipts' inspections;
 * - open/total NCRs raised against the vendor, latest evaluation, qualification status.
 */
export async function procurementReport(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "purchase_order.view");
  const q = reportSchema.parse(query);
  if (q.companyId && !ctx.companies.has(q.companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);

  const pos = await prisma.purchaseOrder.findMany({
    where: {
      AND: [
        companyScopeWhere(ctx),
        {
          companyId: q.companyId,
          status: { notIn: [PurchaseOrderStatus.DRAFT, PurchaseOrderStatus.PENDING_APPROVAL, PurchaseOrderStatus.CANCELLED] },
          orderDate: { gte: q.from, lte: q.to },
        },
      ],
    },
    select: {
      id: true,
      vendorId: true,
      grandTotal: true,
      orderDate: true,
      expectedDate: true,
      stockEntries: { where: { type: StockEntryType.GOODS_RECEIPT, status: StockEntryStatus.POSTED }, select: { id: true, postedAt: true } },
    },
  });
  const grnVendor = new Map(pos.flatMap((po) => po.stockEntries.map((e) => [e.id, po.vendorId] as const)));
  const vendorIds = [...new Set(pos.map((po) => po.vendorId))];
  const [vendors, inspections, ncrs, evaluations] = await Promise.all([
    prisma.vendor.findMany({ where: { organizationId: ctx.organizationId, id: { in: vendorIds } }, select: { id: true, name: true, qualificationStatus: true } }),
    prisma.inspection.findMany({
      where: { organizationId: ctx.organizationId, sourceType: "GOODS_RECEIPT", sourceId: { in: [...grnVendor.keys()] } },
      select: { sourceId: true, inspectedQty: true, rejectedQty: true },
    }),
    prisma.nonConformance.findMany({
      where: { organizationId: ctx.organizationId, companyId: { in: fullCompanyIds(ctx) }, vendorId: { in: vendorIds } },
      select: { vendorId: true, status: true },
    }),
    prisma.supplierEvaluation.findMany({ where: { organizationId: ctx.organizationId, vendorId: { in: vendorIds } }, orderBy: [{ evaluatedOn: "desc" }, { createdAt: "desc" }] }),
  ]);

  return vendors
    .map((vendor) => {
      const mine = pos.filter((po) => po.vendorId === vendor.id);
      let onTime = 0;
      let timed = 0;
      const leadDays: number[] = [];
      for (const po of mine) {
        if (po.expectedDate) {
          for (const e of po.stockEntries) {
            timed += 1;
            if (e.postedAt && e.postedAt.getTime() < po.expectedDate.getTime() + DAY) onTime += 1;
          }
        }
        const first = Math.min(...po.stockEntries.map((e) => e.postedAt?.getTime() ?? Infinity));
        if (Number.isFinite(first)) leadDays.push(Math.max(0, (first - po.orderDate.getTime()) / DAY));
      }
      const checked = inspections.filter((i) => grnVendor.get(i.sourceId) === vendor.id);
      const inspected = checked.reduce((s, i) => s.add(i.inspectedQty), ZERO);
      const rejected = checked.reduce((s, i) => s.add(i.rejectedQty), ZERO);
      const vendorNcrs = ncrs.filter((n) => n.vendorId === vendor.id);
      const latest = evaluations.find((e) => e.vendorId === vendor.id);
      return {
        vendor,
        purchaseOrders: mine.length,
        orderValue: mine.reduce((s, po) => s.add(po.grandTotal), ZERO).toFixed(2),
        receipts: mine.reduce((n, po) => n + po.stockEntries.length, 0),
        onTimeReceiptPct: pct(new Decimal(onTime), new Decimal(timed)),
        avgLeadTimeDays: leadDays.length ? (leadDays.reduce((a, b) => a + b, 0) / leadDays.length).toFixed(1) : null,
        inspectedQty: inspected.toString(),
        rejectedQty: rejected.toString(),
        rejectionRatePct: pct(rejected, inspected),
        nonConformances: { total: vendorNcrs.length, open: vendorNcrs.filter((n) => n.status !== "CLOSED").length },
        latestEvaluation: latest
          ? { evaluatedOn: latest.evaluatedOn, qualityScore: latest.qualityScore, deliveryScore: latest.deliveryScore, priceScore: latest.priceScore }
          : null,
      };
    })
    .sort((a, b) => dec(b.orderValue).cmp(a.orderValue) || a.vendor.name.localeCompare(b.vendor.name));
}
