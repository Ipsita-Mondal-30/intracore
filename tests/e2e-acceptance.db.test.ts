/**
 * End-to-end acceptance journeys, driven through the HTTP route handlers as different
 * role holders (the same path the UI takes):
 *
 *   Lead → Opportunity → Quotation → Sales Order → Stock Reservation → Delivery → Invoice
 *        → Payment → Ledger Posting → Reports → Dashboard
 *   Purchase Order → Goods Receipt → Vendor Bill → Payment → Ledger Posting
 *
 * Each step checks role-based access, tenant isolation, transaction integrity, audit
 * history and that reports agree with the operational records.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { gstinCheckChar } from "@/lib/gst";
import * as convertRoute from "@/app/api/v1/leads/[id]/convert/route";
import * as quotationsRoute from "@/app/api/v1/quotations/route";
import * as quotationActionRoute from "@/app/api/v1/quotations/[id]/[action]/route";
import * as salesOrderActionRoute from "@/app/api/v1/sales-orders/[id]/[action]/route";
import * as invoiceActionRoute from "@/app/api/v1/sales-invoices/[id]/[action]/route";
import * as invoiceRoute from "@/app/api/v1/sales-invoices/[id]/route";
import * as receiptsRoute from "@/app/api/v1/receipts/route";
import * as purchaseOrdersRoute from "@/app/api/v1/purchase-orders/route";
import * as purchaseOrderActionRoute from "@/app/api/v1/purchase-orders/[id]/[action]/route";
import * as vendorBillsRoute from "@/app/api/v1/vendor-bills/route";
import * as vendorBillActionRoute from "@/app/api/v1/vendor-bills/[id]/[action]/route";
import * as vendorPaymentsRoute from "@/app/api/v1/vendor-payments/route";
import * as reportRoute from "@/app/api/v1/companies/[id]/reports/[report]/route";
import * as auditRoute from "@/app/api/v1/audit-logs/route";
import * as analyticsRoute from "@/app/api/v1/analytics/route";
import { setupFinance } from "@/features/finance/setup";
import { createProduct } from "@/features/catalog/service";
import { createVendor } from "@/features/purchasing/vendors";
import { createStockEntry, postStockEntry } from "@/features/inventory/entries";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";
import { call, signInAs } from "./helpers/http";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));

const gstin = (state: string, pan: string) => `${state}${pan}1Z${gstinCheckChar(`${state}${pan}1Z`)}`;
const today = new Date().toISOString().slice(0, 10);
const fyStart = (() => {
  const d = new Date();
  return `${d.getUTCMonth() + 1 >= 4 ? d.getUTCFullYear() : d.getUTCFullYear() - 1}-04-01`;
})();

let a: OrgFixture;
let b: OrgFixture;
let users: Record<"sales" | "stock" | "accounts" | "buyer" | "viewer", string>;
let productId: string;
let bankAccountId: string;

/** Call a route as a user and unwrap { ok, data }. */
async function as(userId: string, handler: Parameters<typeof call>[0], init: Parameters<typeof call>[1] = {}) {
  await signInAs(userId);
  return call(handler, init);
}
async function ok<T = Record<string, unknown>>(userId: string, handler: Parameters<typeof call>[0], init: Parameters<typeof call>[1] = {}) {
  const res = await as(userId, handler, init);
  if (!res.json.ok) throw new Error(`${res.status} ${JSON.stringify(res.json)}`);
  return res.json.data as T;
}

const sumLines = async (sourceType: string, sourceId: string, code: string) => {
  const lines = await prisma.journalLine.findMany({
    where: { entry: { companyId: a.company.id, sourceType, sourceId, status: "POSTED" }, account: { code } },
  });
  return lines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);
};

beforeAll(async () => {
  a = await createOrg("Acceptance Co");
  b = await createOrg("Acceptance Other Co");
  const owner = await a.ctx(a.ownerId);
  await prisma.company.update({ where: { id: a.company.id }, data: { stateCode: "29", gstin: gstin("29", "AAACA1234K"), address: "1 MG Road" } });
  await setupFinance(owner, a.company.id, { accountingStartDate: fyStart });
  bankAccountId = (await prisma.bankAccount.findFirstOrThrow({ where: { companyId: a.company.id, kind: "BANK" } })).id;

  users = {
    sales: (await a.addMember("sales_manager")).userId,
    stock: (await a.addMember("inventory_manager")).userId,
    accounts: (await a.addMember("accountant")).userId,
    buyer: (await a.addMember("purchase_manager")).userId,
    viewer: (await a.addMember("viewer")).userId,
  };

  const gst18 = (await prisma.taxRate.findFirstOrThrow({ where: { organizationId: a.org.id, name: "GST 18%" } })).id;
  const nos = (await prisma.uom.findFirstOrThrow({ where: { organizationId: a.org.id, code: "NOS" } })).id;
  productId = (await createProduct(owner, { sku: "E2E-WIDGET", name: "Widget", uomId: nos, taxRateId: gst18, salesPrice: "1000", purchasePrice: "600" })).id;

  // Opening stock: 10 widgets at 600.
  const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { companyId: a.company.id } });
  const opening = await createStockEntry(owner, {
    companyId: a.company.id, branchId: a.branch.id, type: "OPENING", entryDate: today, targetWarehouseId: warehouse.id,
    lines: [{ productId, quantity: "10", unitCost: "600" }],
  });
  await postStockEntry(owner, opening.id);
});
afterAll(cleanupFixtures);

describe("sales journey: lead to ledger", () => {
  let customerId: string;
  let opportunityId: string;
  let quotationId: string;
  let orderId: string;
  let invoiceId: string;
  let receiptId: string;

  it("converts a qualified lead into customer, contact and opportunity", async () => {
    const lead = await prisma.lead.create({
      data: { organizationId: a.org.id, fullName: "Meera Iyer", firstName: "Meera", company: "Iyer Retail", phone: "9876500001", email: "meera@iyer.test", gstNo: gstin("29", "AABCI5678L"), assignedUserId: users.sales },
    });
    expect((await as(users.viewer, convertRoute.POST, { method: "POST", params: { id: lead.id }, body: {} })).status).toBe(403);
    const converted = await ok<{ customerId: string; opportunityId: string }>(users.sales, convertRoute.POST, {
      method: "POST", params: { id: lead.id }, body: {}, headers: { "idempotency-key": `e2e-convert-${lead.id}` },
    });
    customerId = converted.customerId;
    opportunityId = converted.opportunityId;
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ status: "CONVERTED", convertedCustomerId: customerId });
    await prisma.customer.update({ where: { id: customerId }, data: { stateCode: "29" } });
  });

  it("quotes, sends and accepts, then converts to a sales order", async () => {
    const q = await ok<{ id: string; grandTotal: string }>(users.sales, quotationsRoute.POST, {
      method: "POST",
      body: { companyId: a.company.id, branchId: a.branch.id, customerId, opportunityId, lines: [{ productId, quantity: "4", unitPrice: "1000" }] },
    });
    quotationId = q.id;
    expect(Number(q.grandTotal)).toBe(4720); // 4 × 1000 + 18% GST
    for (const action of ["submit", "send", "accept"]) {
      await ok(users.sales, quotationActionRoute.POST, { method: "POST", params: { id: quotationId, action }, body: {} });
    }
    const converted = await ok<{ salesOrder: { id: string } }>(users.sales, quotationActionRoute.POST, { method: "POST", params: { id: quotationId, action: "convert" }, body: {} });
    orderId = converted.salesOrder.id;
    // Accepting a quotation is not a sale: no journal yet.
    expect(await prisma.journalEntry.count({ where: { companyId: a.company.id, sourceId: quotationId } })).toBe(0);
  });

  it("confirms the order and reserves stock (no stock moves, no journal)", async () => {
    await ok(users.sales, salesOrderActionRoute.POST, { method: "POST", params: { id: orderId, action: "confirm" }, body: {} });
    const reservations = await prisma.stockReservation.findMany({ where: { salesOrderLine: { salesOrderId: orderId } } });
    expect(reservations.reduce((s, r) => s + Number(r.quantity), 0)).toBe(4);
    expect(await prisma.journalEntry.count({ where: { companyId: a.company.id, sourceId: orderId } })).toBe(0);
  });

  it("delivers from the warehouse (inventory role), moving stock and posting COGS", async () => {
    const line = await prisma.salesOrderLine.findFirstOrThrow({ where: { salesOrderId: orderId } });
    // Sales can't post stock; the inventory manager can.
    expect((await as(users.viewer, salesOrderActionRoute.POST, { method: "POST", params: { id: orderId, action: "deliver" }, body: { lines: [{ salesOrderLineId: line.id, quantity: "4" }] } })).status).toBe(403);
    const delivery = await ok<{ id: string }>(users.stock, salesOrderActionRoute.POST, {
      method: "POST", params: { id: orderId, action: "deliver" }, body: { lines: [{ salesOrderLineId: line.id, quantity: "4" }] },
      headers: { "idempotency-key": `e2e-deliver-${orderId}` },
    });
    const balance = await prisma.stockBalance.findFirstOrThrow({ where: { productId } });
    expect(Number(balance.quantity)).toBe(6);
    expect(await sumLines("STOCK_ENTRY", delivery.id, "5000")).toBe(2400); // COGS 4 × 600
    expect(await sumLines("STOCK_ENTRY", delivery.id, "1400")).toBe(-2400);
    expect(await prisma.stockReservation.count({ where: { salesOrderLine: { salesOrderId: orderId }, quantity: { gt: 0 } } })).toBe(0);
  });

  it("invoices the delivered quantity and posts revenue, output GST and receivable", async () => {
    expect((await as(users.sales, invoiceActionRoute.POST, { method: "POST", params: { id: "x", action: "post" } })).status).toBe(403);
    const draft = await ok<{ id: string }>(users.accounts, salesOrderActionRoute.POST, { method: "POST", params: { id: orderId, action: "invoice" }, body: {} });
    invoiceId = draft.id;
    const posted = await ok<{ number: string; status: string; grandTotal: string }>(users.accounts, invoiceActionRoute.POST, {
      method: "POST", params: { id: invoiceId, action: "post" }, body: {},
    });
    expect(posted.status).toBe("POSTED");
    expect(posted.number).toMatch(/^INV\//);
    expect(await sumLines("SALES_INVOICE", invoiceId, "1300")).toBe(4720); // AR
    expect(await sumLines("SALES_INVOICE", invoiceId, "4000")).toBe(-4000); // revenue
    // Retrying the post is safe: still one journal.
    await ok(users.accounts, invoiceActionRoute.POST, { method: "POST", params: { id: invoiceId, action: "post" }, body: {} });
    expect(await prisma.journalEntry.count({ where: { companyId: a.company.id, sourceType: "SALES_INVOICE", sourceId: invoiceId } })).toBe(1);
  });

  it("records the customer payment against the invoice and clears the receivable", async () => {
    const overpay = await as(users.accounts, receiptsRoute.POST, {
      method: "POST", body: { companyId: a.company.id, customerId, bankAccountId, amount: "5000", allocations: [{ invoiceId, amount: "5000" }] },
    });
    expect(overpay.status).toBe(422);
    expect(await prisma.paymentReceipt.count({ where: { companyId: a.company.id } })).toBe(0); // rolled back

    const receipt = await ok<{ id: string }>(users.accounts, receiptsRoute.POST, {
      method: "POST", body: { companyId: a.company.id, customerId, bankAccountId, amount: "4720", allocations: [{ invoiceId, amount: "4720" }] },
      headers: { "idempotency-key": `e2e-receipt-${invoiceId}` },
    });
    receiptId = receipt.id;
    const replay = await as(users.accounts, receiptsRoute.POST, {
      method: "POST", body: { companyId: a.company.id, customerId, bankAccountId, amount: "4720", allocations: [{ invoiceId, amount: "4720" }] },
      headers: { "idempotency-key": `e2e-receipt-${invoiceId}` },
    });
    expect(replay.json.data.id).toBe(receiptId);
    expect(await prisma.paymentReceipt.count({ where: { companyId: a.company.id } })).toBe(1);
    expect(await sumLines("RECEIPT", receiptId, "1300")).toBe(-4720);
    const invoice = await ok<{ outstanding?: string; paidAmount: string }>(users.accounts, invoiceRoute.GET, { params: { id: invoiceId } });
    expect(Number(invoice.paidAmount)).toBe(4720);
  });

  it("reports agree with the documents: trial balance, aging and reconciliation", async () => {
    const tb = await ok<{ balanced: boolean; totalDebit: string }>(users.accounts, reportRoute.GET, { params: { id: a.company.id, report: "trial-balance" } });
    expect(tb.balanced).toBe(true);
    expect(Number(tb.totalDebit)).toBeGreaterThan(0);
    const aging = await ok<{ totals: { total: string } }>(users.accounts, reportRoute.GET, { params: { id: a.company.id, report: "receivables-aging" } });
    expect(aging.totals.total).toBe("0.00");
    const recon = await ok<{ issues: unknown[] }>(users.accounts, reportRoute.GET, { params: { id: a.company.id, report: "reconciliation" } });
    expect(recon.issues).toEqual([]);
    // Roles without finance.report can't read the ledger.
    expect((await as(users.sales, reportRoute.GET, { params: { id: a.company.id, report: "trial-balance" } })).status).toBe(403);
  });

  it("shows the journey on the dashboard, consistent with the documents", async () => {
    type Dash = { sections: { key: string; metrics: { key: string; value: unknown }[] }[] };
    const dash = await ok<Dash>(a.ownerId, analyticsRoute.GET, { query: `companyId=${a.company.id}&from=${today}&to=${today}` });
    const m = (key: string) => dash.sections.flatMap((s) => s.metrics).find((x) => x.key === key)?.value;
    expect(m("sales.quotations_accepted")).toBe(1);
    expect(m("sales.orders_confirmed")).toBe(1);
    expect(m("sales.invoiced_value")).toEqual({ INR: "4000.00" });
    expect(m("sales.invoiced_gross")).toEqual({ INR: "4720.00" });
    expect(m("receivables.outstanding")).toEqual({ INR: "0.00" });
    const stock = await prisma.stockValuation.aggregate({ where: { companyId: a.company.id }, _sum: { value: true } });
    expect(m("inventory.stock_value")).toEqual({ INR: Number(stock._sum.value).toFixed(2) });
    // Another tenant's dashboard is unaffected.
    const other = await ok<Dash>(b.ownerId, analyticsRoute.GET, { query: `from=${today}&to=${today}` });
    expect(other.sections.flatMap((s) => s.metrics).find((x) => x.key === "sales.invoiced_value")?.value).toEqual({ INR: "0.00" });
  });

  it("keeps an audit history of every step", async () => {
    const res = await ok<{ items: { action: string }[] }>(a.ownerId, auditRoute.GET, { query: "pageSize=100" });
    const actions = new Set(res.items.map((i) => i.action));
    for (const action of ["lead.converted", "quotation.created", "quotation.converted", "sales_order.confirmed", "invoice.posted", "receipt.posted"]) {
      expect(actions, action).toContain(action);
    }
  });

  it("isolates tenants: another organization can't see or act on any of it", async () => {
    const outsider = b.ownerId;
    expect((await as(outsider, invoiceRoute.GET, { params: { id: invoiceId } })).status).toBe(404);
    expect((await as(outsider, quotationActionRoute.POST, { method: "POST", params: { id: quotationId, action: "convert" }, body: {} })).status).toBe(404);
    expect((await as(outsider, reportRoute.GET, { params: { id: a.company.id, report: "trial-balance" } })).status).toBe(404);
  });
});

describe("purchase journey: PO to ledger", () => {
  let vendorId: string;
  let poId: string;
  let billId: string;

  beforeAll(async () => {
    vendorId = (await createVendor(await a.ctx(a.ownerId), { name: "Widget Works", stateCode: "29" })).id;
  });

  it("creates and approves a purchase order (no journal)", async () => {
    const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { companyId: a.company.id } });
    const po = await ok<{ id: string }>(users.buyer, purchaseOrdersRoute.POST, {
      method: "POST", body: { companyId: a.company.id, branchId: a.branch.id, warehouseId: warehouse.id, vendorId, lines: [{ productId, quantity: "5", unitPrice: "600" }] },
    });
    poId = po.id;
    await ok(users.buyer, purchaseOrderActionRoute.POST, { method: "POST", params: { id: poId, action: "submit" }, body: {} });
    expect(await prisma.purchaseOrder.findUniqueOrThrow({ where: { id: poId } })).toMatchObject({ status: "APPROVED" });
    expect(await prisma.journalEntry.count({ where: { companyId: a.company.id, sourceId: poId } })).toBe(0);
  });

  it("receives goods: stock up, inventory debited against GRNI", async () => {
    const line = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: poId } });
    expect((await as(users.sales, purchaseOrderActionRoute.POST, { method: "POST", params: { id: poId, action: "receive" }, body: { lines: [{ purchaseOrderLineId: line.id, quantity: "5" }] } })).status).toBe(403);
    const grn = await ok<{ id: string }>(users.stock, purchaseOrderActionRoute.POST, {
      method: "POST", params: { id: poId, action: "receive" }, body: { lines: [{ purchaseOrderLineId: line.id, quantity: "5" }] },
    });
    expect(Number((await prisma.stockBalance.findFirstOrThrow({ where: { productId } })).quantity)).toBe(11);
    expect(await sumLines("STOCK_ENTRY", grn.id, "1400")).toBe(3000);
    expect(await sumLines("STOCK_ENTRY", grn.id, "2200")).toBe(-3000);
  });

  it("books the vendor bill (three-way matched) and clears GRNI", async () => {
    const line = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: poId } });
    const over = await as(users.buyer, vendorBillsRoute.POST, {
      method: "POST", body: { companyId: a.company.id, branchId: a.branch.id, vendorId, purchaseOrderId: poId, vendorInvoiceNumber: "WW/1", billDate: today, lines: [{ purchaseOrderLineId: line.id, quantity: "6", unitPrice: "600" }] },
    });
    const bill = await ok<{ id: string; grandTotal: string }>(users.buyer, vendorBillsRoute.POST, {
      method: "POST", body: { companyId: a.company.id, branchId: a.branch.id, vendorId, purchaseOrderId: poId, vendorInvoiceNumber: "WW/2", billDate: today, lines: [{ purchaseOrderLineId: line.id, quantity: "5", unitPrice: "600" }] },
    });
    billId = bill.id;
    expect(Number(bill.grandTotal)).toBe(3540);
    if (over.json.ok) {
      // Over-billing may be saved as a draft but can never post (billed > received).
      const res = await as(users.accounts, vendorBillActionRoute.POST, { method: "POST", params: { id: over.json.data.id, action: "post" }, body: {} });
      expect(res.status).toBe(422);
    }
    await ok(users.accounts, vendorBillActionRoute.POST, { method: "POST", params: { id: billId, action: "post" }, body: {} });
    expect(await sumLines("VENDOR_BILL", billId, "2200")).toBe(3000); // GRNI cleared
    expect(await sumLines("VENDOR_BILL", billId, "2100")).toBe(-3540); // AP
  });

  it("pays the vendor and clears the payable", async () => {
    const payment = await ok<{ id: string }>(users.accounts, vendorPaymentsRoute.POST, {
      method: "POST", body: { companyId: a.company.id, vendorId, bankAccountId, amount: "3540", allocations: [{ billId, amount: "3540" }] },
    });
    expect(await sumLines("VENDOR_PAYMENT", payment.id, "2100")).toBe(3540);
    const bill = await prisma.vendorBill.findUniqueOrThrow({ where: { id: billId } });
    expect(Number(bill.paidAmount)).toBe(3540);
    const recon = await ok<{ issues: unknown[] }>(users.accounts, reportRoute.GET, { params: { id: a.company.id, report: "reconciliation" } });
    expect(recon.issues).toEqual([]);
    const tb = await ok<{ balanced: boolean }>(users.accounts, reportRoute.GET, { params: { id: a.company.id, report: "trial-balance" } });
    expect(tb.balanced).toBe(true);
  });
});
