import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { dec } from "@/lib/money";
import type { AccessContext } from "@/lib/access";
import { createProduct, setUomConversions, updateProduct } from "@/features/catalog/service";
import { createCustomer } from "@/features/customers/service";
import { updateCompany, createBranch } from "@/features/companies/service";
import { createWarehouse } from "@/features/inventory/warehouses";
import {
  cancelStockEntry,
  createReturn,
  createStockEntry,
  deliverSalesOrder,
  getStockEntry,
  postStockEntry,
  receivePurchaseOrder,
} from "@/features/inventory/entries";
import { getReorderSuggestions, getStockLevels, reconcileStock } from "@/features/inventory/stock";
import { sendLowStockAlerts } from "@/features/inventory/alerts";
import { cancelSalesOrder, confirmSalesOrder, createSalesOrder, reserveSalesOrderStock } from "@/features/sales/orders";
import { createVendor } from "@/features/purchasing/vendors";
import { createPurchaseOrder, transitionPurchaseOrder } from "@/features/purchasing/purchase-orders";
import { cancelVendorBill, createVendorBill, postVendorBill } from "@/features/purchasing/bills";
import * as salesOrderActionRoute from "@/app/api/v1/sales-orders/[id]/[action]/route";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";
import { call, signInAs } from "./helpers/http";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));

let a: OrgFixture;
let b: OrgFixture;
let owner: AccessContext;
let main: { id: string };
let wh2: { id: string };
let nos: string;
let gst18: string;
let customerId: string;
let vendorId: string;

const product = async (sku: string, extra: Record<string, unknown> = {}) =>
  createProduct(owner, { sku, name: sku, uomId: nos, taxRateId: gst18, salesPrice: "500", purchasePrice: "100", ...extra });

const onHand = async (productId: string, warehouseId = main.id) =>
  dec((await prisma.stockBalance.aggregate({ where: { warehouseId, productId }, _sum: { quantity: true } }))._sum.quantity).toNumber();

const valuation = (productId: string) =>
  prisma.stockValuation.findUniqueOrThrow({ where: { companyId_productId: { companyId: a.company.id, productId } } });

const stockIn = (productId: string, quantity: string, unitCost = "100", extra: Record<string, unknown> = {}) =>
  createStockEntry(owner, {
    companyId: a.company.id,
    type: "RECEIPT",
    targetWarehouseId: main.id,
    lines: [{ productId, quantity, unitCost, ...extra }],
    post: true,
  });

const order = async (productId: string, quantity: string) =>
  createSalesOrder(owner, {
    companyId: a.company.id,
    branchId: a.branch.id,
    customerId,
    warehouseId: main.id,
    lines: [{ productId, quantity }],
  });

beforeAll(async () => {
  a = await createOrg("Stock Co");
  b = await createOrg("Other Stock Co");
  owner = await a.ctx(a.ownerId);
  await prisma.company.update({ where: { id: a.company.id }, data: { stateCode: "29" } });
  main = await prisma.warehouse.findFirstOrThrow({ where: { companyId: a.company.id, code: "MAIN" } });
  wh2 = await createWarehouse(owner, { companyId: a.company.id, code: "WH2", name: "Overflow" });
  nos = (await prisma.uom.findFirstOrThrow({ where: { organizationId: a.org.id, code: "NOS" } })).id;
  gst18 = (await prisma.taxRate.findFirstOrThrow({ where: { organizationId: a.org.id, name: "GST 18%" } })).id;
  customerId = (await createCustomer(owner, { name: "Buyer", stateCode: "29", ignoreDuplicates: true })).id;
  vendorId = (await createVendor(owner, { name: "Supplier", stateCode: "29" })).id;
});
afterAll(cleanupFixtures);

describe("stock ledger and valuation", () => {
  it("values stock at moving weighted average cost", async () => {
    const p = await product("VAL-1");
    await createStockEntry(owner, { companyId: a.company.id, type: "OPENING", targetWarehouseId: main.id, lines: [{ productId: p.id, quantity: "10", unitCost: "100" }], post: true });
    await stockIn(p.id, "10", "200");
    let v = await valuation(p.id);
    expect([v.quantity.toString(), v.value.toString(), v.averageCost.toString()]).toEqual(["20", "3000", "150"]);

    await createStockEntry(owner, { companyId: a.company.id, type: "ISSUE", sourceWarehouseId: main.id, lines: [{ productId: p.id, quantity: "5" }], post: true });
    v = await valuation(p.id);
    expect([v.quantity.toString(), v.value.toString(), v.averageCost.toString()]).toEqual(["15", "2250", "150"]);
    expect(await onHand(p.id)).toBe(15);
    const moves = await prisma.stockMove.findMany({ where: { productId: p.id }, orderBy: { movedAt: "asc" } });
    expect(moves.map((m) => m.quantity.toString())).toEqual(["10", "10", "-5"]);
  });

  it("refuses negative stock and rolls the whole document back", async () => {
    const p = await product("NEG-1");
    await stockIn(p.id, "3");
    const entriesBefore = await prisma.stockEntry.count({ where: { companyId: a.company.id } });
    const seqBefore = await prisma.numberSequence.findUnique({ where: { companyId_documentType: { companyId: a.company.id, documentType: "stock_entry" } } });

    await expect(
      createStockEntry(owner, { companyId: a.company.id, type: "ISSUE", sourceWarehouseId: main.id, lines: [{ productId: p.id, quantity: "5" }], post: true }),
    ).rejects.toMatchObject({ code: "INSUFFICIENT_STOCK" });
    expect(await onHand(p.id)).toBe(3);
    expect(await prisma.stockEntry.count({ where: { companyId: a.company.id } })).toBe(entriesBefore);
    const seqAfter = await prisma.numberSequence.findUnique({ where: { companyId_documentType: { companyId: a.company.id, documentType: "stock_entry" } } });
    expect(seqAfter?.nextNumber).toBe(seqBefore?.nextNumber); // gapless: the failed number is reused

    await updateCompany(owner, a.company.id, { settings: { inventory: { allowNegativeStock: true } } });
    await createStockEntry(owner, { companyId: a.company.id, type: "ISSUE", sourceWarehouseId: main.id, lines: [{ productId: p.id, quantity: "5" }], post: true });
    expect(await onHand(p.id)).toBe(-2);
    await updateCompany(owner, a.company.id, { settings: { inventory: { allowNegativeStock: false } } });
  });

  it("transfers between warehouses without changing value", async () => {
    const p = await product("XFER-1");
    await stockIn(p.id, "10", "50");
    const before = await valuation(p.id);
    await createStockEntry(owner, {
      companyId: a.company.id, type: "TRANSFER", sourceWarehouseId: main.id, targetWarehouseId: wh2.id,
      lines: [{ productId: p.id, quantity: "4" }], post: true,
    });
    expect([await onHand(p.id), await onHand(p.id, wh2.id)]).toEqual([6, 4]);
    const after = await valuation(p.id);
    expect([after.quantity.toString(), after.value.toString()]).toEqual([before.quantity.toString(), before.value.toString()]);
    await expect(
      createStockEntry(owner, { companyId: a.company.id, type: "TRANSFER", sourceWarehouseId: main.id, targetWarehouseId: main.id, lines: [{ productId: p.id, quantity: "1" }] }),
    ).rejects.toThrow(/different warehouses/);
  });

  it("posts a draft at most once and reverses a posted entry on cancel", async () => {
    const p = await product("REV-1");
    const draft = await createStockEntry(owner, { companyId: a.company.id, type: "RECEIPT", targetWarehouseId: main.id, lines: [{ productId: p.id, quantity: "7", unitCost: "10" }] });
    expect(await onHand(p.id)).toBe(0);
    await Promise.all([postStockEntry(owner, draft.id), postStockEntry(owner, draft.id)]);
    await postStockEntry(owner, draft.id);
    expect(await onHand(p.id)).toBe(7);
    expect(await prisma.stockMove.count({ where: { entryId: draft.id } })).toBe(1);

    await cancelStockEntry(owner, draft.id, { reason: "Wrong supplier" });
    expect(await onHand(p.id)).toBe(0);
    expect((await valuation(p.id)).value.toString()).toBe("0");
    const moves = await prisma.stockMove.findMany({ where: { entryId: draft.id }, orderBy: { movedAt: "asc" } });
    expect(moves.map((m) => [m.quantity.toString(), m.isReversal])).toEqual([["7", false], ["-7", true]]);
  });
});

describe("sales reservations and deliveries", () => {
  it("never over-reserves under concurrent confirmations", async () => {
    const p = await product("RES-1");
    await stockIn(p.id, "10");
    const [o1, o2] = await Promise.all([order(p.id, "8"), order(p.id, "8")]);
    await Promise.all([confirmSalesOrder(owner, o1.id), confirmSalesOrder(owner, o2.id)]);

    const reservations = await prisma.stockReservation.findMany({ where: { productId: p.id } });
    const total = reservations.reduce((sum, r) => sum + r.quantity.toNumber(), 0);
    expect(total).toBe(10);
    expect(reservations.map((r) => r.quantity.toNumber()).sort()).toEqual([2, 8]);
    const levels = await getStockLevels(owner, { productId: p.id, warehouseId: main.id });
    expect(levels[0]).toMatchObject({ onHand: "10", reserved: "10", available: "0" });

    // Re-reserving is idempotent.
    await reserveSalesOrderStock(owner, o1.id);
    await reserveSalesOrderStock(owner, o1.id);
    expect((await prisma.stockReservation.aggregate({ where: { productId: p.id }, _sum: { quantity: true } }))._sum.quantity?.toNumber()).toBe(10);
  });

  it("delivers against reservations, rejects stealing and over-delivery, and is retry-safe", async () => {
    const p = await product("DEL-1");
    await stockIn(p.id, "10");
    const big = await order(p.id, "8");
    const small = await order(p.id, "5");
    await confirmSalesOrder(owner, big.id); // reserves 8
    await confirmSalesOrder(owner, small.id); // reserves the last 2
    const smallLine = await prisma.salesOrderLine.findFirstOrThrow({ where: { salesOrderId: small.id } });
    const bigLine = await prisma.salesOrderLine.findFirstOrThrow({ where: { salesOrderId: big.id } });

    await expect(deliverSalesOrder(owner, small.id, { lines: [{ salesOrderLineId: smallLine.id, quantity: "5" }] })).rejects.toMatchObject({
      code: "INSUFFICIENT_STOCK",
    });
    await expect(deliverSalesOrder(owner, big.id, { lines: [{ salesOrderLineId: bigLine.id, quantity: "9" }] })).rejects.toMatchObject({
      code: "QUANTITY_EXCEEDED",
    });

    // HTTP retry with the same Idempotency-Key ships once.
    await signInAs(a.ownerId);
    const send = () =>
      call(salesOrderActionRoute.POST, {
        method: "POST",
        params: { id: big.id, action: "deliver" },
        body: { lines: [{ salesOrderLineId: bigLine.id, quantity: "8" }] },
        headers: { "idempotency-key": `deliver-${big.id}` },
      });
    const first = await send();
    const retry = await send();
    expect(first.status).toBe(200);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(await onHand(p.id)).toBe(2);
    expect((await prisma.salesOrder.findUniqueOrThrow({ where: { id: big.id } })).status).toBe("DELIVERED");
    expect((await prisma.stockReservation.findUniqueOrThrow({ where: { organizationId_salesOrderLineId: { organizationId: a.org.id, salesOrderLineId: bigLine.id } } })).quantity.toNumber()).toBe(0);

    // A partial delivery of the small order from its own reservation is fine.
    await deliverSalesOrder(owner, small.id, { lines: [{ salesOrderLineId: smallLine.id, quantity: "2" }] });
    expect((await prisma.salesOrder.findUniqueOrThrow({ where: { id: small.id } })).status).toBe("PARTIALLY_DELIVERED");
    await expect(cancelSalesOrder(owner, small.id, { reason: "x" })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("releases reservations when an order is cancelled", async () => {
    const p = await product("REL-1");
    await stockIn(p.id, "5");
    const o = await order(p.id, "5");
    const confirmed = await confirmSalesOrder(owner, o.id);
    expect(confirmed.reservations[0]).toMatchObject({ reserved: "5", short: "0" });
    await cancelSalesOrder(owner, o.id, { reason: "Customer cancelled" });
    expect(await prisma.stockReservation.count({ where: { productId: p.id } })).toBe(0);
    expect((await getStockLevels(owner, { productId: p.id, warehouseId: main.id }))[0].available).toBe("5");
  });

  it("returns goods at their original cost, never more than delivered", async () => {
    const p = await product("RET-1");
    await stockIn(p.id, "10", "40");
    const o = await order(p.id, "6");
    await confirmSalesOrder(owner, o.id);
    const line = await prisma.salesOrderLine.findFirstOrThrow({ where: { salesOrderId: o.id } });
    const delivery = await deliverSalesOrder(owner, o.id, { lines: [{ salesOrderLineId: line.id, quantity: "6" }] });
    const deliveryLine = delivery.lines[0];

    await createReturn(owner, delivery.id, { lines: [{ entryLineId: deliveryLine.id, quantity: "4" }], reason: "Damaged" });
    expect(await onHand(p.id)).toBe(8);
    const ret = await prisma.stockMove.findFirstOrThrow({ where: { productId: p.id, entry: { type: "SALES_RETURN" } } });
    expect(ret.unitCost.toString()).toBe("40");
    expect((await prisma.salesOrderLine.findUniqueOrThrow({ where: { id: line.id } })).returnedQty.toNumber()).toBe(4);
    await expect(createReturn(owner, delivery.id, { lines: [{ entryLineId: deliveryLine.id, quantity: "3" }] })).rejects.toMatchObject({
      code: "QUANTITY_EXCEEDED",
    });
    // The delivery cannot be cancelled while a posted return depends on it.
    await expect(cancelStockEntry(owner, delivery.id, { reason: "x" })).rejects.toThrow(/returns/);
  });
});

describe("purchasing", () => {
  it("approves, receives partially, three-way matches bills and returns", async () => {
    const p = await product("PO-1", { purchasePrice: "250" });
    await updateCompany(owner, a.company.id, { settings: { purchase: { approvalAmount: 1000 } } });
    const buyer = await a.addMember("purchase_manager");
    const buyerCtx = await a.ctx(buyer.userId);
    const po = await createPurchaseOrder(buyerCtx, {
      companyId: a.company.id, branchId: a.branch.id, warehouseId: main.id, vendorId,
      lines: [{ productId: p.id, quantity: "10", discountPercent: "10" }],
    });
    expect(po.grandTotal.toFixed(2)).toBe("2655.00"); // 10 x 250 - 10% = 2250 + 18% GST

    const submitted = await transitionPurchaseOrder(buyerCtx, po.id, "submit", {});
    expect(submitted.status).toBe("PENDING_APPROVAL");
    await expect(transitionPurchaseOrder(buyerCtx, po.id, "approve", {})).rejects.toThrow(/you created/);
    await expect(receivePurchaseOrder(owner, po.id, { lines: [] })).rejects.toThrow();
    await transitionPurchaseOrder(owner, po.id, "approve", {});
    expect(await onHand(p.id)).toBe(0); // approval alone never adds stock

    const poLine = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id } });
    const grn = await receivePurchaseOrder(buyerCtx, po.id, { lines: [{ purchaseOrderLineId: poLine.id, quantity: "4" }] });
    expect(await onHand(p.id)).toBe(4);
    expect((await prisma.stockMove.findFirstOrThrow({ where: { entryId: grn.id } })).unitCost.toString()).toBe("225"); // net of discount, excl. GST
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe("PARTIALLY_RECEIVED");
    await expect(receivePurchaseOrder(buyerCtx, po.id, { lines: [{ purchaseOrderLineId: poLine.id, quantity: "7" }] })).rejects.toMatchObject({
      code: "QUANTITY_EXCEEDED",
    });
    await expect(transitionPurchaseOrder(owner, po.id, "cancel", { reason: "x" })).rejects.toThrow(/close the order/);

    const bill = await createVendorBill(buyerCtx, {
      companyId: a.company.id, branchId: a.branch.id, vendorId, purchaseOrderId: po.id, vendorInvoiceNumber: "INV-77",
      billDate: "2026-10-16", lines: [{ purchaseOrderLineId: poLine.id, quantity: "4" }],
    });
    expect(bill.grandTotal.toFixed(2)).toBe("1062.00");
    await postVendorBill(buyerCtx, bill.id);
    await postVendorBill(buyerCtx, bill.id); // retry-safe
    expect((await prisma.purchaseOrderLine.findUniqueOrThrow({ where: { id: poLine.id } })).billedQty.toNumber()).toBe(4);
    const over = await createVendorBill(buyerCtx, {
      companyId: a.company.id, branchId: a.branch.id, vendorId, purchaseOrderId: po.id, vendorInvoiceNumber: "INV-78",
      billDate: "2026-10-16", lines: [{ purchaseOrderLineId: poLine.id, quantity: "1" }],
    });
    await expect(postVendorBill(buyerCtx, over.id)).rejects.toMatchObject({ code: "QUANTITY_EXCEEDED" });
    await expect(
      createVendorBill(buyerCtx, { companyId: a.company.id, branchId: a.branch.id, vendorId, vendorInvoiceNumber: "INV-77", billDate: "2026-10-16", lines: [{ description: "x", unitPrice: "1", quantity: "1" }] }),
    ).rejects.toMatchObject({ code: "P2002" });

    // Receipt cannot be cancelled while billed; return goods instead.
    await expect(cancelStockEntry(owner, grn.id, { reason: "x" })).rejects.toThrow(/vendor bills/);
    const grnLine = (await getStockEntry(owner, grn.id)).lines[0];
    await createReturn(buyerCtx, grn.id, { lines: [{ entryLineId: grnLine.id, quantity: "1" }] });
    expect(await onHand(p.id)).toBe(3);
    expect((await prisma.purchaseOrderLine.findUniqueOrThrow({ where: { id: poLine.id } })).returnedQty.toNumber()).toBe(1);

    await receivePurchaseOrder(buyerCtx, po.id, { lines: [{ purchaseOrderLineId: poLine.id, quantity: "6" }] });
    expect((await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe("RECEIVED");
    await cancelVendorBill(buyerCtx, bill.id, { reason: "Credit note" });
    expect((await prisma.purchaseOrderLine.findUniqueOrThrow({ where: { id: poLine.id } })).billedQty.toNumber()).toBe(0);
    await updateCompany(owner, a.company.id, { settings: { purchase: { approvalAmount: null } } });
  });

  it("receives in purchase units converted to the base unit", async () => {
    const p = await product("BOX-1", { purchasePrice: "1200" });
    const box = await prisma.uom.findFirstOrThrow({ where: { organizationId: a.org.id, code: "BOX" } });
    await setUomConversions(owner, p.id, { conversions: [{ uomId: box.id, factor: "12" }] });
    const po = await createPurchaseOrder(owner, {
      companyId: a.company.id, branchId: a.branch.id, warehouseId: main.id, vendorId,
      lines: [{ productId: p.id, quantity: "2", uomId: box.id }],
    });
    await transitionPurchaseOrder(owner, po.id, "submit", {});
    const line = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id } });
    await receivePurchaseOrder(owner, po.id, { lines: [{ purchaseOrderLineId: line.id, quantity: "2" }] });
    expect(await onHand(p.id)).toBe(24);
    expect((await valuation(p.id)).averageCost.toString()).toBe("100"); // 1200 per box / 12
  });
});

describe("batch, serial and expiry tracking", () => {
  it("requires lots, blocks expired batches and duplicate serials", async () => {
    const batch = await product("BATCH-1", { trackingMode: "BATCH", hasExpiry: true });
    await expect(stockIn(batch.id, "5")).rejects.toThrow(/batch number/);
    await expect(stockIn(batch.id, "5", "10", { lotNumber: "B1" })).rejects.toThrow(/expiry date/);
    await stockIn(batch.id, "5", "10", { lotNumber: "OLD", expiryDate: "2020-01-01" });
    await stockIn(batch.id, "5", "10", { lotNumber: "NEW", expiryDate: "2099-01-01" });
    const o = await order(batch.id, "3");
    await confirmSalesOrder(owner, o.id);
    const line = await prisma.salesOrderLine.findFirstOrThrow({ where: { salesOrderId: o.id } });
    await expect(deliverSalesOrder(owner, o.id, { lines: [{ salesOrderLineId: line.id, quantity: "3", lotNumber: "OLD" }] })).rejects.toThrow(/expired/);
    await deliverSalesOrder(owner, o.id, { lines: [{ salesOrderLineId: line.id, quantity: "3", lotNumber: "NEW" }] });
    const lots = await prisma.stockBalance.findMany({ where: { productId: batch.id }, include: { lot: true } });
    expect(Object.fromEntries(lots.map((l) => [l.lot!.lotNumber, l.quantity.toNumber()]))).toEqual({ OLD: 5, NEW: 2 });

    const serial = await product("SER-1", { trackingMode: "SERIAL" });
    await expect(stockIn(serial.id, "2", "10", { lotNumber: "SN-1" })).rejects.toThrow(/one unit per line/);
    await stockIn(serial.id, "1", "10", { lotNumber: "SN-1" });
    await expect(stockIn(serial.id, "1", "10", { lotNumber: "SN-1" })).rejects.toThrow(/already in stock/);
  });
});

describe("reorder, alerts, reconciliation, integrity", () => {
  it("suggests reorders net of open purchase orders and alerts once", async () => {
    const p = await product("REORD-1", { reorderLevel: "20", reorderQty: "50" });
    await stockIn(p.id, "5");
    const suggestions = await getReorderSuggestions(owner, a.company.id);
    expect(suggestions.find((s) => s.product.id === p.id)).toMatchObject({ available: "5", suggestedQuantity: "50" });

    const first = await sendLowStockAlerts();
    const again = await sendLowStockAlerts();
    expect(first.sent).toBeGreaterThan(0);
    const alerts = await prisma.notification.count({ where: { userId: a.ownerId, type: "stock.low", data: { path: ["productId"], equals: p.id } } });
    expect(alerts).toBe(1);
    expect(again.sent).toBeLessThan(first.sent);

    const po = await createPurchaseOrder(owner, { companyId: a.company.id, branchId: a.branch.id, warehouseId: main.id, vendorId, lines: [{ productId: p.id, quantity: "30" }] });
    await transitionPurchaseOrder(owner, po.id, "submit", {});
    expect((await getReorderSuggestions(owner, a.company.id)).find((s) => s.product.id === p.id)).toBeUndefined();
  });

  it("detects and repairs cache drift from the ledger", async () => {
    const p = await product("RECON-1");
    await stockIn(p.id, "9", "11");
    await prisma.stockBalance.updateMany({ where: { productId: p.id }, data: { quantity: 1 } });
    const report = await reconcileStock(owner, a.company.id, {});
    expect(report.balanceDiffs.find((d) => d.productId === p.id)).toMatchObject({ ledger: "9", cached: "1" });
    await reconcileStock(owner, a.company.id, { fix: true });
    expect(await onHand(p.id)).toBe(9);
    expect((await reconcileStock(owner, a.company.id, {})).balanceDiffs).toHaveLength(0);
  });

  it("blocks archiving stocked products and isolates tenants and branches", async () => {
    const p = await product("ARCH-1");
    await stockIn(p.id, "1");
    await expect(updateProduct(owner, p.id, { status: "ARCHIVED" })).rejects.toThrow(/cannot be archived/);
    await expect(updateProduct(owner, p.id, { trackingMode: "BATCH" })).rejects.toThrow(/while stock exists/);

    const entry = await stockIn(p.id, "1");
    const other = await b.ctx(b.ownerId);
    await expect(getStockEntry(other, entry.id)).rejects.toMatchObject({ status: 404 });
    await expect(postStockEntry(other, entry.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      createStockEntry(other, { companyId: a.company.id, type: "RECEIPT", targetWarehouseId: main.id, lines: [{ productId: p.id, quantity: "1", unitCost: "1" }] }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      createStockEntry(other, { companyId: b.company.id, type: "RECEIPT", targetWarehouseId: main.id, lines: [{ productId: p.id, quantity: "1", unitCost: "1" }] }),
    ).rejects.toMatchObject({ status: 404 }); // our warehouse is not in their company

    const north = await createBranch(owner, a.company.id, { code: "NORTH", name: "North" });
    const clerk = await a.addMember("inventory_manager", [{ companyId: a.company.id, branchId: north.id }]);
    const clerkCtx = await a.ctx(clerk.userId);
    await expect(getStockEntry(clerkCtx, entry.id)).rejects.toThrow(); // company-wide entry, branch-limited user
    const o = await order(p.id, "1");
    await confirmSalesOrder(owner, o.id);
    const line = await prisma.salesOrderLine.findFirstOrThrow({ where: { salesOrderId: o.id } });
    await expect(deliverSalesOrder(clerkCtx, o.id, { lines: [{ salesOrderLineId: line.id, quantity: "1" }] })).rejects.toMatchObject({ status: 404 });
  });
});
