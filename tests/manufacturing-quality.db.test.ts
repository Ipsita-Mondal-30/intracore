import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { dec } from "@/lib/money";
import type { AccessContext } from "@/lib/access";
import { createProduct } from "@/features/catalog/service";
import { createStockEntry, receivePurchaseOrder } from "@/features/inventory/entries";
import { createVendor } from "@/features/purchasing/vendors";
import { createPurchaseOrder, transitionPurchaseOrder } from "@/features/purchasing/purchase-orders";
import { setupFinance } from "@/features/finance/setup";
import { updateTask } from "@/features/tasks/service";
import { createBom, transitionBom, updateBom } from "@/features/manufacturing/boms";
import { createWorkOrder, getWorkOrder, issueMaterials, receiveFinishedGoods, transitionWorkOrder } from "@/features/manufacturing/work-orders";
import { materialRequirements } from "@/features/manufacturing/mrp";
import { createInspection, createInspectionTemplate, updateInspectionTemplate } from "@/features/quality/inspections";
import { addCorrectiveAction, getNonConformance, transitionNonConformance } from "@/features/quality/ncr";
import { createSupplierEvaluation, procurementReport } from "@/features/quality/suppliers";
import * as workOrdersRoute from "@/app/api/v1/work-orders/route";
import * as workOrderRoute from "@/app/api/v1/work-orders/[id]/route";
import * as workOrderActionRoute from "@/app/api/v1/work-orders/[id]/[action]/route";
import * as bomsRoute from "@/app/api/v1/boms/route";
import * as purchaseOrdersRoute from "@/app/api/v1/purchase-orders/route";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";
import { call, signInAs } from "./helpers/http";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));

let a: OrgFixture;
let b: OrgFixture;
let owner: AccessContext;
let main: { id: string };
let nos: string;
let gst18: string;

const product = async (ctx: AccessContext, sku: string, extra: Record<string, unknown> = {}) =>
  createProduct(ctx, { sku, name: sku, uomId: extra.uomId ?? nos, taxRateId: extra.taxRateId ?? gst18, salesPrice: "500", purchasePrice: "100", ...extra });

const onHand = async (productId: string, warehouseId = main.id) =>
  dec((await prisma.stockBalance.aggregate({ where: { warehouseId, productId }, _sum: { quantity: true } }))._sum.quantity).toString();

const stockIn = (productId: string, quantity: string, unitCost: string, ctx = owner, companyId = a.company.id, warehouseId = main.id) =>
  createStockEntry(ctx, { companyId, type: "RECEIPT", targetWarehouseId: warehouseId, lines: [{ productId, quantity, unitCost }], post: true });

const activeBomFor = async (productId: string, lines: { componentId: string; quantity: string; scrapPercent?: string }[], outputQuantity = "1", ctx = owner) => {
  const bom = await createBom(ctx, { productId, outputQuantity, lines });
  return transitionBom(ctx, bom.id, "activate");
};

const materials = (workOrderId: string) =>
  prisma.workOrderMaterial.findMany({ where: { workOrderId }, include: { product: true, reservation: true }, orderBy: { product: { sku: "asc" } } });

beforeAll(async () => {
  a = await createOrg("Mfg Co");
  b = await createOrg("Other Mfg Co");
  owner = await a.ctx(a.ownerId);
  main = await prisma.warehouse.findFirstOrThrow({ where: { companyId: a.company.id, code: "MAIN" } });
  nos = (await prisma.uom.findFirstOrThrow({ where: { organizationId: a.org.id, code: "NOS" } })).id;
  gst18 = (await prisma.taxRate.findFirstOrThrow({ where: { organizationId: a.org.id, name: "GST 18%" } })).id;
});
afterAll(cleanupFixtures);

describe("bills of materials", () => {
  it("versions BOMs: one active per product, frozen once active, no self-reference or cycles", async () => {
    const fg = await product(owner, "BOM-FG");
    const c1 = await product(owner, "BOM-C1");
    const c2 = await product(owner, "BOM-C2");
    await expect(createBom(owner, { productId: fg.id, lines: [{ componentId: fg.id, quantity: "1" }] })).rejects.toMatchObject({ status: 422 });
    await expect(createBom(owner, { productId: fg.id, lines: [{ componentId: c1.id, quantity: "0" }] })).rejects.toMatchObject({ name: "ZodError" });
    await expect(createBom(owner, { productId: fg.id, lines: [{ componentId: c1.id, quantity: "1" }, { componentId: c1.id, quantity: "2" }] })).rejects.toThrow(/twice/);

    const v1 = await activeBomFor(fg.id, [{ componentId: c1.id, quantity: "2" }]);
    expect([v1.version, v1.status]).toEqual([1, "ACTIVE"]);
    await expect(updateBom(owner, v1.id, { lines: [{ componentId: c2.id, quantity: "1" }] })).rejects.toMatchObject({ code: "INVALID_STATE" });

    const v2 = await transitionBom(owner, v1.id, "copy");
    expect([v2.version, v2.status]).toEqual([2, "DRAFT"]);
    await updateBom(owner, v2.id, { lines: [{ componentId: c1.id, quantity: "2" }, { componentId: c2.id, quantity: "1" }] });
    await transitionBom(owner, v2.id, "activate");
    const versions = await prisma.bom.findMany({ where: { productId: fg.id }, orderBy: { version: "asc" } });
    expect(versions.map((v) => v.status)).toEqual(["ARCHIVED", "ACTIVE"]);

    // c1 → c2 → fg would close a loop (fg already needs c1 and c2).
    await activeBomFor(c2.id, [{ componentId: c1.id, quantity: "1" }]);
    const loop = await createBom(owner, { productId: c1.id, lines: [{ componentId: fg.id, quantity: "1" }] });
    await expect(transitionBom(owner, loop.id, "activate")).rejects.toMatchObject({ code: "CYCLE" });
    expect((await prisma.bom.findUniqueOrThrow({ where: { id: loop.id } })).status).toBe("DRAFT");
  });

  it("explodes multi-level BOMs and nets shortages against available stock", async () => {
    const fg = await product(owner, "MRP-FG");
    const sub = await product(owner, "MRP-SUB");
    const raw1 = await product(owner, "MRP-RAW1");
    const raw2 = await product(owner, "MRP-RAW2");
    // fg = 2 sub + 1 raw1 (10% scrap); sub (made in 2s) = 6 raw2
    await activeBomFor(sub.id, [{ componentId: raw2.id, quantity: "6" }], "2");
    await activeBomFor(fg.id, [{ componentId: sub.id, quantity: "2" }, { componentId: raw1.id, quantity: "1", scrapPercent: "10" }]);
    await stockIn(sub.id, "1", "10");
    await stockIn(raw2.id, "2", "10");

    const plan = await materialRequirements(owner, { companyId: a.company.id, productId: fg.id, quantity: "5" });
    if (plan.mode !== "explosion") throw new Error("expected an explosion");
    const row = (sku: string) => plan.lines.find((l) => l.product.sku === sku);
    expect(row("MRP-SUB")).toMatchObject({ level: 1, source: "MAKE", required: "10", covered: "1", shortage: "9" });
    expect(row("MRP-RAW1")).toMatchObject({ level: 1, source: "BUY", required: "5.5", shortage: "5.5" });
    // 9 short subs → 9 × 6 / 2 = 27 raw2, 2 on hand
    expect(row("MRP-RAW2")).toMatchObject({ level: 2, source: "BUY", required: "27", covered: "2", shortage: "25" });

    await expect(materialRequirements(owner, { companyId: a.company.id, productId: raw1.id, quantity: "1" })).rejects.toMatchObject({ code: "NO_BOM" });
    await expect(materialRequirements(owner, { companyId: a.company.id, productId: fg.id })).rejects.toMatchObject({ name: "ZodError" });
  });
});

describe("work orders", () => {
  it("reserves on release, issues materials, receives finished goods at consumed cost", async () => {
    const fg = await product(owner, "WO-FG");
    const rmA = await product(owner, "WO-RMA");
    const rmB = await product(owner, "WO-RMB");
    await activeBomFor(fg.id, [{ componentId: rmA.id, quantity: "4" }, { componentId: rmB.id, quantity: "1" }], "2");
    await stockIn(rmA.id, "10", "100");
    await stockIn(rmB.id, "1", "50");

    const wo = await createWorkOrder(owner, { companyId: a.company.id, productId: fg.id, warehouseId: main.id, quantity: "4" });
    expect(wo.number).toMatch(/^WO-/);
    expect(wo.materials.map((m) => m.requiredQty.toString()).sort()).toEqual(["2", "8"]);

    // Release with a shortage: A fully reserved, B partially (1 of 2).
    const released = await transitionWorkOrder(owner, wo.id, "release", {});
    expect(released.status).toBe("RELEASED");
    expect(released.reservations!.map((r) => [r.reserved, r.short]).sort()).toEqual([["1", "1"], ["8", "0"]]);
    let mats = await materials(wo.id);
    expect(mats.map((m) => m.reservation?.quantity.toString())).toEqual(["8", "1"]);
    const shortages = await materialRequirements(owner, { companyId: a.company.id });
    expect(shortages.lines.find((l) => l.product.sku === "WO-RMB")).toMatchObject({ openRequirement: "2", reservedForWorkOrders: "1", shortage: "1" });

    // Reserved stock is protected from other issues.
    await expect(
      createStockEntry(owner, { companyId: a.company.id, type: "ISSUE", sourceWarehouseId: main.id, lines: [{ productId: rmA.id, quantity: "3" }], post: true }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });

    // Over the requirement without the flag, and beyond stock: both refused, nothing persisted.
    await expect(issueMaterials(owner, wo.id, { lines: [{ productId: rmA.id, quantity: "9" }] })).rejects.toMatchObject({ code: "QUANTITY_EXCEEDED" });
    await expect(issueMaterials(owner, wo.id, {})).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await prisma.stockEntry.count({ where: { workOrderId: wo.id } })).toBe(0);
    mats = await materials(wo.id);
    expect(mats.map((m) => m.consumedQty.toString())).toEqual(["0", "0"]);
    expect(await onHand(rmA.id)).toBe("10");
    expect((await prisma.workOrder.findUniqueOrThrow({ where: { id: wo.id } })).status).toBe("RELEASED");

    // Stock arrives, top up the reservation, issue everything open.
    await stockIn(rmB.id, "1", "50");
    const topped = await transitionWorkOrder(owner, wo.id, "reserve", {});
    expect(topped.reservations!.every((r) => r.short === "0")).toBe(true);
    const issue = await issueMaterials(owner, wo.id, {});
    expect(issue.type).toBe("PRODUCTION_ISSUE");
    expect([await onHand(rmA.id), await onHand(rmB.id)]).toEqual(["2", "0"]);
    mats = await materials(wo.id);
    expect(mats.map((m) => m.consumedQty.toString())).toEqual(["8", "2"]);
    expect(mats.map((m) => m.reservation?.quantity.toString())).toEqual(["0", "0"]);
    expect((await prisma.workOrder.findUniqueOrThrow({ where: { id: wo.id } })).status).toBe("IN_PROGRESS");
    await expect(issueMaterials(owner, wo.id, {})).rejects.toMatchObject({ code: "INVALID_STATE" });

    // Consumed value 8 × 100 + 2 × 50 = 900, spread over the 4 planned units.
    const r1 = await receiveFinishedGoods(owner, wo.id, { quantity: "3" });
    expect(r1.lines[0].unitCost?.toString()).toBe("225");
    await expect(receiveFinishedGoods(owner, wo.id, { quantity: "2" })).rejects.toMatchObject({ code: "QUANTITY_EXCEEDED" });
    await receiveFinishedGoods(owner, wo.id, { quantity: "1" });
    const v = await prisma.stockValuation.findUniqueOrThrow({ where: { companyId_productId: { companyId: a.company.id, productId: fg.id } } });
    expect([v.quantity.toString(), v.value.toString()]).toEqual(["4", "900"]);
    const detail = await getWorkOrder(owner, wo.id);
    expect(detail.costs).toEqual({ consumedValue: "900.00", absorbedValue: "900.00", wipValue: "0.00" });
    expect(detail.producedQty.toString()).toBe("4");

    const done = await transitionWorkOrder(owner, wo.id, "complete", {});
    expect(done.status).toBe("COMPLETED");
    await expect(transitionWorkOrder(owner, wo.id, "cancel", {})).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("cancels with reservations released; refuses cancel after consumption and complete without output", async () => {
    const fg = await product(owner, "WO2-FG");
    const rm = await product(owner, "WO2-RM");
    await activeBomFor(fg.id, [{ componentId: rm.id, quantity: "1" }]);
    await stockIn(rm.id, "5", "10");

    const wo = await createWorkOrder(owner, { companyId: a.company.id, productId: fg.id, warehouseId: main.id, quantity: "3" });
    await transitionWorkOrder(owner, wo.id, "release", {});
    expect(await prisma.stockReservation.count({ where: { workOrderMaterial: { workOrderId: wo.id } } })).toBe(1);
    await expect(transitionWorkOrder(owner, wo.id, "complete", {})).rejects.toMatchObject({ code: "INVALID_STATE" });
    await transitionWorkOrder(owner, wo.id, "cancel", { reason: "Plan changed" });
    expect(await prisma.stockReservation.count({ where: { workOrderMaterial: { workOrderId: wo.id } } })).toBe(0);
    await expect(transitionWorkOrder(owner, wo.id, "release", {})).rejects.toMatchObject({ code: "INVALID_STATE" });

    const wo2 = await createWorkOrder(owner, { companyId: a.company.id, productId: fg.id, warehouseId: main.id, quantity: "2" });
    await transitionWorkOrder(owner, wo2.id, "release", {});
    await issueMaterials(owner, wo2.id, { lines: [{ productId: rm.id, quantity: "1" }] });
    await expect(transitionWorkOrder(owner, wo2.id, "cancel", {})).rejects.toMatchObject({ code: "INVALID_STATE" });
    // Over-issue only with the explicit flag.
    await expect(issueMaterials(owner, wo2.id, { lines: [{ productId: rm.id, quantity: "2" }] })).rejects.toMatchObject({ code: "QUANTITY_EXCEEDED" });
    await issueMaterials(owner, wo2.id, { lines: [{ productId: rm.id, quantity: "2" }], allowOverIssue: true });
    expect((await materials(wo2.id))[0].consumedQty.toString()).toBe("3");
  });

  it("journals production through work in progress when finance is on", async () => {
    const c = await createOrg("Mfg Finance Co");
    const ctx = await c.ctx(c.ownerId);
    const cNos = (await prisma.uom.findFirstOrThrow({ where: { organizationId: c.org.id, code: "NOS" } })).id;
    const cGst = (await prisma.taxRate.findFirstOrThrow({ where: { organizationId: c.org.id, name: "GST 18%" } })).id;
    const now = new Date();
    const fyYear = now.getUTCMonth() + 1 >= 4 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
    await setupFinance(ctx, c.company.id, { accountingStartDate: `${fyYear}-04-01` });
    const wh = await prisma.warehouse.findFirstOrThrow({ where: { companyId: c.company.id, code: "MAIN" } });
    const fg = await product(ctx, "FIN-FG", { uomId: cNos, taxRateId: cGst });
    const rm = await product(ctx, "FIN-RM", { uomId: cNos, taxRateId: cGst });
    await activeBomFor(fg.id, [{ componentId: rm.id, quantity: "2" }], "1", ctx);
    await stockIn(rm.id, "4", "25", ctx, c.company.id, wh.id);

    const wo = await createWorkOrder(ctx, { companyId: c.company.id, productId: fg.id, warehouseId: wh.id, quantity: "2" });
    await transitionWorkOrder(ctx, wo.id, "release", {});
    const issue = await issueMaterials(ctx, wo.id, {});
    const receipt = await receiveFinishedGoods(ctx, wo.id, { quantity: "2" });

    const journal = (id: string) =>
      prisma.journalEntry.findFirstOrThrow({ where: { companyId: c.company.id, sourceType: "STOCK_ENTRY", sourceId: id }, include: { lines: { include: { account: true } } } });
    const net = (lines: { account: { code: string }; debit: unknown; credit: unknown }[], code: string) =>
      lines.filter((l) => l.account.code === code).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
    const ij = await journal(issue.id);
    expect([net(ij.lines, "1450"), net(ij.lines, "1400")]).toEqual([100, -100]);
    const rj = await journal(receipt.id);
    expect([net(rj.lines, "1400"), net(rj.lines, "1450")]).toEqual([100, -100]);
  });
});

describe("quality", () => {
  let vendorId: string;
  let template: { id: string; items: { id: string; label: string }[] };
  let grnId: string;
  let itemId: string;
  let poLineId: string;

  beforeAll(async () => {
    vendorId = (await createVendor(owner, { name: "Bolt Supplier" })).id;
    const item = await product(owner, "QC-BOLT");
    itemId = item.id;
    template = await createInspectionTemplate(owner, {
      name: "Incoming bolts",
      appliesTo: "GOODS_RECEIPT",
      items: [
        { label: "Length (mm)", type: "NUMERIC", minValue: "9.5", maxValue: "10.5" },
        { label: "Thread OK", type: "BOOLEAN" },
        { label: "Remarks", type: "TEXT", required: false },
      ],
    });
    const po = await createPurchaseOrder(owner, { companyId: a.company.id, branchId: a.branch.id, warehouseId: main.id, vendorId, lines: [{ productId: item.id, quantity: "20", unitPrice: "10" }] });
    await transitionPurchaseOrder(owner, po.id, "submit", {});
    poLineId = (await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id } })).id;
    grnId = (await receivePurchaseOrder(owner, po.id, { lines: [{ purchaseOrderLineId: poLineId, quantity: "20" }] })).id;
  });

  const values = (length: string | number, thread: boolean | string) => [
    { itemId: template.items[0].id, value: length },
    { itemId: template.items[1].id, value: thread },
  ];

  it("evaluates criteria: passing records no NCR, failing rejects and raises an NCR", async () => {
    const pass = await createInspection(owner, { templateId: template.id, sourceType: "GOODS_RECEIPT", sourceId: grnId, productId: itemId, inspectedQty: "5", results: values("10.1", true) });
    expect([pass.result, pass.acceptedQty.toString(), pass.nonConformance]).toEqual(["PASSED", "5", null]);

    await expect(
      createInspection(owner, { templateId: template.id, sourceType: "GOODS_RECEIPT", sourceId: grnId, productId: itemId, inspectedQty: "1", results: [{ itemId: template.items[1].id, value: true }] }),
    ).rejects.toThrow(/Length.*required/);
    await expect(
      createInspection(owner, { templateId: template.id, sourceType: "GOODS_RECEIPT", sourceId: grnId, productId: itemId, inspectedQty: "1", rejectedQty: "0", results: values(11, true) }),
    ).rejects.toThrow(/reject at least/);

    const fail = await createInspection(owner, { templateId: template.id, sourceType: "GOODS_RECEIPT", sourceId: grnId, productId: itemId, inspectedQty: "5", results: values("11", "pass"), severity: "MAJOR" });
    expect([fail.result, fail.rejectedQty.toString(), fail.acceptedQty.toString()]).toEqual(["FAILED", "5", "0"]);
    expect(fail.nonConformance).toMatchObject({ status: "OPEN", severity: "MAJOR", vendorId, productId: itemId });
    expect(fail.nonConformance!.number).toMatch(/^NCR-/);
    expect(fail.nonConformance!.description).toMatch(/Length/);

    // Cannot inspect more than the receipt brought in (10 of 20 left).
    await expect(
      createInspection(owner, { templateId: template.id, sourceType: "GOODS_RECEIPT", sourceId: grnId, productId: itemId, inspectedQty: "11", results: values(10, true) }),
    ).rejects.toMatchObject({ code: "QUANTITY_EXCEEDED" });

    // Checks are frozen once the template is used.
    await expect(updateInspectionTemplate(owner, template.id, { items: [{ label: "x" }] })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("returns rejected goods to the vendor in the same transaction", async () => {
    const before = Number(await onHand(itemId));
    const partial = await createInspection(owner, {
      templateId: template.id, sourceType: "GOODS_RECEIPT", sourceId: grnId, productId: itemId,
      inspectedQty: "4", rejectedQty: "3", results: values("9", false), returnRejected: true, raiseNcr: false,
    });
    expect([partial.result, partial.nonConformance]).toEqual(["PARTIAL", null]);
    expect(partial.purchaseReturn).toMatchObject({ type: "PURCHASE_RETURN", status: "POSTED", returnOfId: grnId });
    expect(Number(await onHand(itemId))).toBe(before - 3);
    expect((await prisma.purchaseOrderLine.findUniqueOrThrow({ where: { id: poLineId } })).returnedQty.toString()).toBe("3");
  });

  it("tracks corrective actions; an NCR closes only with a root cause and no open actions", async () => {
    const fail = await createInspection(owner, { templateId: template.id, sourceType: "GOODS_RECEIPT", sourceId: grnId, productId: itemId, inspectedQty: "1", results: values("12", true) });
    const ncrId = fail.nonConformance!.id;
    const task = await addCorrectiveAction(owner, ncrId, { title: "Recalibrate supplier cutting jig" });
    expect(task).toMatchObject({ entityType: "nonconformance", entityId: ncrId, status: "PENDING" });
    expect((await getNonConformance(owner, ncrId)).status).toBe("IN_PROGRESS");

    await expect(transitionNonConformance(owner, ncrId, "close", {})).rejects.toThrow(/root cause/);
    await expect(transitionNonConformance(owner, ncrId, "close", { rootCause: "Worn jig" })).rejects.toMatchObject({ code: "OPEN_ACTIONS" });
    await updateTask(owner, task.id, { status: "COMPLETED" });
    const closed = await transitionNonConformance(owner, ncrId, "close", { rootCause: "Worn jig" });
    expect([closed.status, closed.rootCause]).toEqual(["CLOSED", "Worn jig"]);
    await expect(addCorrectiveAction(owner, ncrId, { title: "Late" })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("records production rejections on the work order", async () => {
    const fg = await product(owner, "QC-FG");
    const rm = await product(owner, "QC-RM");
    await activeBomFor(fg.id, [{ componentId: rm.id, quantity: "1" }]);
    const prodTemplate = await createInspectionTemplate(owner, { name: "Final check", appliesTo: "PRODUCTION", items: [{ label: "Finish OK" }] });
    const wo = await createWorkOrder(owner, { companyId: a.company.id, productId: fg.id, warehouseId: main.id, quantity: "5" });
    await expect(
      createInspection(owner, { templateId: template.id, sourceType: "WORK_ORDER", sourceId: wo.id, inspectedQty: "1", results: values(10, true) }),
    ).rejects.toThrow(/goods receipt inspections/);
    await transitionWorkOrder(owner, wo.id, "release", {});
    const insp = await createInspection(owner, { templateId: prodTemplate.id, sourceType: "WORK_ORDER", sourceId: wo.id, inspectedQty: "5", rejectedQty: "2", results: [{ itemId: prodTemplate.items[0].id, value: false }] });
    expect([insp.result, insp.productId]).toEqual(["PARTIAL", fg.id]);
    expect((await prisma.workOrder.findUniqueOrThrow({ where: { id: wo.id } })).rejectedQty.toString()).toBe("2");
  });

  it("blocks purchase orders for BLOCKED vendors and reports per-vendor procurement", async () => {
    const report = await procurementReport(owner, { companyId: a.company.id });
    const row = report.find((r) => r.vendor.id === vendorId)!;
    expect(row).toMatchObject({ purchaseOrders: 1, orderValue: "236.00", receipts: 1, inspectedQty: "15", rejectedQty: "9", rejectionRatePct: "60" });
    expect(row.nonConformances).toEqual({ total: 2, open: 1 });

    const draft = await createPurchaseOrder(owner, { companyId: a.company.id, branchId: a.branch.id, warehouseId: main.id, vendorId, lines: [{ productId: itemId, quantity: "1" }] });
    const evaluation = await createSupplierEvaluation(owner, { vendorId, qualityScore: 40, deliveryScore: 70, priceScore: 80, qualificationStatus: "BLOCKED" });
    expect(evaluation.qualificationStatus).toBe("BLOCKED");
    await expect(
      createPurchaseOrder(owner, { companyId: a.company.id, branchId: a.branch.id, warehouseId: main.id, vendorId, lines: [{ productId: itemId, quantity: "1" }] }),
    ).rejects.toMatchObject({ code: "VENDOR_NOT_QUALIFIED", status: 422 });
    await expect(transitionPurchaseOrder(owner, draft.id, "submit", {})).rejects.toMatchObject({ code: "VENDOR_NOT_QUALIFIED" });

    await signInAs(a.ownerId);
    const res = await call(purchaseOrdersRoute.POST, {
      method: "POST",
      body: { companyId: a.company.id, branchId: a.branch.id, warehouseId: main.id, vendorId, lines: [{ productId: itemId, quantity: "1" }] },
    });
    expect([res.status, res.json.code]).toEqual([422, "VENDOR_NOT_QUALIFIED"]);

    const qm = await a.addMember("quality_manager");
    await expect(createSupplierEvaluation(await a.ctx(qm.userId), { vendorId, qualityScore: 90, deliveryScore: 90, priceScore: 90, qualificationStatus: "APPROVED" })).resolves.toBeTruthy();
    await expect(transitionPurchaseOrder(owner, draft.id, "submit", {})).resolves.toMatchObject({ status: "APPROVED" });
  });
});

describe("API", () => {
  let fgId: string;

  beforeAll(async () => {
    const fg = await product(owner, "API-FG");
    const rm = await product(owner, "API-RM");
    await activeBomFor(fg.id, [{ componentId: rm.id, quantity: "1" }]);
    await stockIn(rm.id, "10", "5");
    fgId = fg.id;
  });

  it("enforces permissions (403), tenant scope (404) and validation (422)", async () => {
    const qm = await a.addMember("quality_manager"); // manufacturing.view only
    await signInAs(qm.userId);
    const denied = await call(workOrdersRoute.POST, { method: "POST", body: { companyId: a.company.id, productId: fgId, warehouseId: main.id, quantity: "1" } });
    expect([denied.status, denied.json.code]).toEqual([403, "FORBIDDEN"]);

    await signInAs(a.ownerId);
    const created = await call(workOrdersRoute.POST, { method: "POST", body: { companyId: a.company.id, productId: fgId, warehouseId: main.id, quantity: "1" } });
    expect(created.status).toBe(201);

    await signInAs(b.ownerId);
    const foreign = await call(workOrderRoute.GET, { params: { id: created.json.data.id } });
    expect(foreign.status).toBe(404);
    const foreignCompany = await call(workOrdersRoute.POST, { method: "POST", body: { companyId: a.company.id, productId: fgId, warehouseId: main.id, quantity: "1" } });
    expect(foreignCompany.status).toBe(404);

    await signInAs(a.ownerId);
    const invalid = await call(bomsRoute.POST, { method: "POST", body: { productId: fgId, lines: [] } });
    expect([invalid.status, invalid.json.code]).toEqual([422, "VALIDATION_ERROR"]);
    const badQty = await call(workOrdersRoute.POST, { method: "POST", body: { companyId: a.company.id, productId: fgId, warehouseId: main.id, quantity: "-1" } });
    expect(badQty.status).toBe(422);
    const unknown = await call(workOrderActionRoute.POST, { method: "POST", params: { id: created.json.data.id, action: "explode" } });
    expect(unknown.status).toBe(404);
  });

  it("replays idempotent creates and production steps", async () => {
    await signInAs(a.ownerId);
    const body = { companyId: a.company.id, productId: fgId, warehouseId: main.id, quantity: "2" };
    const headers = { "idempotency-key": `wo-${Date.now()}` };
    const first = await call(workOrdersRoute.POST, { method: "POST", body, headers });
    const second = await call(workOrdersRoute.POST, { method: "POST", body, headers });
    expect(second.json.data.id).toBe(first.json.data.id);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    const id = first.json.data.id;

    await call(workOrderActionRoute.POST, { method: "POST", params: { id, action: "release" } });
    const issueHeaders = { "idempotency-key": `issue-${id}` };
    const i1 = await call(workOrderActionRoute.POST, { method: "POST", params: { id, action: "issue" }, body: {}, headers: issueHeaders });
    const i2 = await call(workOrderActionRoute.POST, { method: "POST", params: { id, action: "issue" }, body: {}, headers: issueHeaders });
    expect([i1.status, i2.status]).toEqual([200, 200]);
    expect(i2.json.data.id).toBe(i1.json.data.id);
    expect(await prisma.stockEntry.count({ where: { workOrderId: id, type: "PRODUCTION_ISSUE" } })).toBe(1);
  });
});
