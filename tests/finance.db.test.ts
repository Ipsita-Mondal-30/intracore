import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { gstinCheckChar } from "@/lib/gst";
import type { AccessContext } from "@/lib/access";
import { createCompany, updateCompany } from "@/features/companies/service";
import { createProduct } from "@/features/catalog/service";
import { createCustomer } from "@/features/customers/service";
import { createVendor } from "@/features/purchasing/vendors";
import { createPurchaseOrder, transitionPurchaseOrder } from "@/features/purchasing/purchase-orders";
import { approveVendorBill, cancelVendorBill, createVendorBill, postVendorBill } from "@/features/purchasing/bills";
import { createStockEntry, deliverSalesOrder, receivePurchaseOrder } from "@/features/inventory/entries";
import { confirmSalesOrder, createSalesOrder } from "@/features/sales/orders";
import { addTaxRateVersion, listFiscalYears, setPeriodStatus, setupFinance } from "@/features/finance/setup";
import { MAPPING_KEYS } from "@/features/finance/ledger";
import {
  allocateCredit,
  cancelInvoice,
  cancelReceipt,
  createCreditNote,
  createInvoice,
  createInvoiceFromSalesOrder,
  createReceipt,
  postCreditNote,
  postInvoice,
  remindOverdueInvoices,
} from "@/features/finance/receivables";
import { createDebitNote, createVendorPayment, postDebitNote } from "@/features/finance/payables";
import { createExpenseClaim, transitionExpenseClaim } from "@/features/finance/expenses";
import { createTransfer, getCashbook, importBankStatement, reconcileBankTransaction, suggestMatches } from "@/features/finance/bank";
import { createManualJournal, postManualJournal, reversePostedJournal } from "@/features/finance/journals";
import {
  balanceSheet,
  customerStatement,
  financeReconciliation,
  profitAndLoss,
  receivablesAging,
  trialBalance,
} from "@/features/finance/reports";
import { gstr1, gstr3b } from "@/features/finance/gst-reports";
import { buildEInvoice, registerEInvoice } from "@/features/finance/einvoice";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));

const gstin = (state: string, pan: string) => {
  const first14 = `${state}${pan}1Z`;
  return `${first14}${gstinCheckChar(first14)}`;
};
const SELLER = gstin("29", "AAACS1234K");
const B2B_BUYER = gstin("29", "AABCB5678L");
const INTERSTATE_BUYER = gstin("27", "AACCM9012N");

let a: OrgFixture;
let b: OrgFixture;
let owner: AccessContext;
let gst5: string;
let gst18: string;
let nos: string;
let buyer: { id: string };
let interBuyer: { id: string };
let consumer: { id: string };
let vendorId: string;
let bank: { id: string; accountId: string };
let cash: { id: string; accountId: string };

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const todayStr = ymd(new Date());
const fyStart = (() => {
  const d = new Date();
  const y = d.getUTCMonth() + 1 >= 4 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${y}-04-01`;
})();

const journalOf = (sourceType: string, sourceId: string, sourceEvent = "post") =>
  prisma.journalEntry.findFirst({ where: { companyId: a.company.id, sourceType, sourceId, sourceEvent }, include: { lines: { include: { account: true } } } });

const net = (lines: { account: { code: string }; debit: unknown; credit: unknown }[], code: string) =>
  lines.filter((l) => l.account.code === code).reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0);

async function invoice(customerId: string, lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) {
  const draft = await createInvoice(owner, { companyId: a.company.id, branchId: a.branch.id, customerId, lines, ...extra });
  return postInvoice(owner, draft.id);
}

beforeAll(async () => {
  a = await createOrg("Finance Co");
  b = await createOrg("Other Finance Co");
  owner = await a.ctx(a.ownerId);
  await prisma.company.update({ where: { id: a.company.id }, data: { stateCode: "29", gstin: SELLER, address: "1 MG Road, Bengaluru" } });
  gst5 = (await prisma.taxRate.findFirstOrThrow({ where: { organizationId: a.org.id, name: "GST 5%" } })).id;
  gst18 = (await prisma.taxRate.findFirstOrThrow({ where: { organizationId: a.org.id, name: "GST 18%" } })).id;
  nos = (await prisma.uom.findFirstOrThrow({ where: { organizationId: a.org.id, code: "NOS" } })).id;
  buyer = await createCustomer(owner, { name: "B2B Buyer", gstin: B2B_BUYER, stateCode: "29", billingAddress: "Whitefield", ignoreDuplicates: true });
  interBuyer = await createCustomer(owner, { name: "Mumbai Buyer", gstin: INTERSTATE_BUYER, stateCode: "27", billingAddress: "Andheri", ignoreDuplicates: true });
  consumer = await createCustomer(owner, { name: "Walk-in", type: "INDIVIDUAL", stateCode: "29", ignoreDuplicates: true });
  vendorId = (await createVendor(owner, { name: "Steel Supplier", stateCode: "29" })).id;

  const setup = await setupFinance(owner, a.company.id, { accountingStartDate: fyStart });
  expect(setup).toMatchObject({ enabled: true, accountingStartDate: fyStart });
  bank = await prisma.bankAccount.findFirstOrThrow({ where: { companyId: a.company.id, kind: "BANK" } });
  cash = await prisma.bankAccount.findFirstOrThrow({ where: { companyId: a.company.id, kind: "CASH" } });
});
afterAll(cleanupFixtures);

describe("setup", () => {
  it("creates the chart, mappings, fiscal year with 12 open periods, and refuses a second setup", async () => {
    const years = await listFiscalYears(owner, a.company.id);
    expect(years).toHaveLength(1);
    expect(years[0].periods).toHaveLength(12);
    expect(years[0].periods.every((p) => p.status === "OPEN")).toBe(true);
    expect(await prisma.accountMapping.count({ where: { companyId: a.company.id } })).toBe(Object.keys(MAPPING_KEYS).length);
    await expect(setupFinance(owner, a.company.id, { accountingStartDate: fyStart })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});

describe("invoices and tax", () => {
  it("computes multi-rate intra-state GST, numbers on posting and posts a balanced journal once", async () => {
    const draft = await createInvoice(owner, {
      companyId: a.company.id, branchId: a.branch.id, customerId: buyer.id,
      lines: [
        { description: "Rice 25kg", quantity: "4", unitPrice: "1000", taxRateId: gst5 },
        { description: "Installation", quantity: "1", unitPrice: "2500", discountPercent: "10", taxRateId: gst18 },
      ],
    });
    expect(draft.number).toBeNull();
    expect([draft.taxableTotal.toFixed(2), draft.cgstTotal.toFixed(2), draft.sgstTotal.toFixed(2), draft.igstTotal.toFixed(2), draft.grandTotal.toFixed(2)])
      .toEqual(["6250.00", "302.50", "302.50", "0.00", "6855.00"]); // 4000@5% + 2250@18%

    const [p1, p2] = await Promise.all([postInvoice(owner, draft.id), postInvoice(owner, draft.id)]);
    expect(p1.number).toBe(p2.number);
    expect(p1.number).toMatch(/^INV\/\d{2}-\d{2}\/\d{5}$/);
    expect(p1.number!.length).toBeLessThanOrEqual(16);
    expect(await prisma.journalEntry.count({ where: { sourceType: "SALES_INVOICE", sourceId: draft.id } })).toBe(1);

    const j = (await journalOf("SALES_INVOICE", draft.id))!;
    expect(j.totalDebit.toFixed(2)).toBe("6855.00");
    expect(j.totalCredit.toFixed(2)).toBe("6855.00");
    expect([net(j.lines, "1300"), net(j.lines, "4000"), net(j.lines, "2300"), net(j.lines, "2310")]).toEqual([6855, -6250, -302.5, -302.5]);
  });

  it("charges IGST across states and validates GST data before posting", async () => {
    const inter = await invoice(interBuyer.id, [{ description: "Steel", quantity: "10", unitPrice: "500", taxRateId: gst18 }]);
    expect([inter.igstTotal.toFixed(2), inter.cgstTotal.toFixed(2), inter.grandTotal.toFixed(2)]).toEqual(["900.00", "0.00", "5900.00"]);

    const badGstin = await createCustomer(owner, { name: "Typo GSTIN", gstin: "29AABCB5678L1ZA", stateCode: "29", ignoreDuplicates: true });
    const draft = await createInvoice(owner, { companyId: a.company.id, branchId: a.branch.id, customerId: badGstin.id, lines: [{ description: "x", quantity: "1", unitPrice: "100", taxRateId: gst18 }] });
    await expect(postInvoice(owner, draft.id)).rejects.toThrow(/check digit/);
  });

  it("uses the tax rate in force on the invoice date", async () => {
    const tax = await prisma.taxRate.create({
      data: { organizationId: a.org.id, name: "Test GST", rate: 12, versions: { create: { rate: 12, effectiveFrom: new Date("2017-07-01T00:00:00Z") } } },
    });
    await addTaxRateVersion(owner, tax.id, { rate: "18", effectiveFrom: todayStr });
    const before = new Date(Date.now() - 86_400_000 * 2);
    const old = await createInvoice(owner, { companyId: a.company.id, branchId: a.branch.id, customerId: buyer.id, invoiceDate: ymd(before), lines: [{ description: "x", quantity: "1", unitPrice: "100", taxRateId: tax.id }] });
    const now = await createInvoice(owner, { companyId: a.company.id, branchId: a.branch.id, customerId: buyer.id, lines: [{ description: "x", quantity: "1", unitPrice: "100", taxRateId: tax.id }] });
    expect([old.lines[0].taxRate.toString(), now.lines[0].taxRate.toString()]).toEqual(["12", "18"]);
  });

  it("invoices delivered goods only, and never more than delivered", async () => {
    const p = await createProduct(owner, { sku: "FIN-GOODS", name: "Pump", uomId: nos, taxRateId: gst18, salesPrice: "1000", purchasePrice: "600", hsnCode: "84137010" });
    await createStockEntry(owner, { companyId: a.company.id, type: "OPENING", targetWarehouseId: (await prisma.warehouse.findFirstOrThrow({ where: { companyId: a.company.id } })).id, lines: [{ productId: p.id, quantity: "10", unitCost: "600" }], post: true });
    const so = await createSalesOrder(owner, { companyId: a.company.id, branchId: a.branch.id, customerId: buyer.id, lines: [{ productId: p.id, quantity: "5" }] });
    await confirmSalesOrder(owner, so.id);
    await expect(createInvoiceFromSalesOrder(owner, so.id)).rejects.toThrow(/invoice once delivered/);
    const soLine = await prisma.salesOrderLine.findFirstOrThrow({ where: { salesOrderId: so.id } });
    await deliverSalesOrder(owner, so.id, { lines: [{ salesOrderLineId: soLine.id, quantity: "3" }] });

    const inv = await createInvoiceFromSalesOrder(owner, so.id);
    expect(inv.lines[0].quantity.toString()).toBe("3");
    expect(inv.lines[0].hsnCode).toBe("84137010");
    await postInvoice(owner, inv.id);
    expect((await prisma.salesOrderLine.findUniqueOrThrow({ where: { id: soLine.id } })).invoicedQty.toString()).toBe("3");
    await expect(
      createInvoice(owner, { companyId: a.company.id, branchId: a.branch.id, customerId: buyer.id, salesOrderId: so.id, lines: [{ salesOrderLineId: soLine.id, quantity: "1" }] }),
    ).rejects.toMatchObject({ code: "QUANTITY_EXCEEDED" });

    // Delivery posted COGS at moving-average cost (3 x 600).
    const delivery = await prisma.stockEntry.findFirstOrThrow({ where: { salesOrderId: so.id, type: "DELIVERY" } });
    const dj = (await journalOf("STOCK_ENTRY", delivery.id))!;
    expect([net(dj.lines, "5000"), net(dj.lines, "1400")]).toEqual([1800, -1800]);
  });
});

describe("receipts, allocation and credit notes", () => {
  it("handles partial payments, blocks overpayment and keeps unapplied money on account", async () => {
    const inv = await invoice(buyer.id, [{ description: "Service", quantity: "1", unitPrice: "10000", taxRateId: gst18 }]); // 11800
    const r1 = await createReceipt(owner, { companyId: a.company.id, customerId: buyer.id, bankAccountId: bank.id, amount: "5000", allocations: [{ invoiceId: inv.id, amount: "5000" }] });
    expect(r1.allocatedAmount.toString()).toBe("5000");
    expect((await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } })).paidAmount.toString()).toBe("5000");

    await expect(
      createReceipt(owner, { companyId: a.company.id, customerId: buyer.id, bankAccountId: bank.id, amount: "9000", allocations: [{ invoiceId: inv.id, amount: "9000" }] }),
    ).rejects.toMatchObject({ code: "OVERPAYMENT" });
    await expect(
      createReceipt(owner, { companyId: a.company.id, customerId: buyer.id, bankAccountId: bank.id, amount: "100", allocations: [{ invoiceId: inv.id, amount: "200" }] }),
    ).rejects.toMatchObject({ code: "OVERALLOCATED" });

    // Receive more than due: the extra stays on account, then settles a later invoice.
    const r2 = await createReceipt(owner, { companyId: a.company.id, customerId: buyer.id, bankAccountId: bank.id, amount: "8000", allocations: [{ invoiceId: inv.id, amount: "6800" }] });
    const paid = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } });
    expect(paid.paidAmount.toString()).toBe("11800");
    const later = await invoice(buyer.id, [{ description: "Extra", quantity: "1", unitPrice: "1000", taxRateId: gst18 }]); // 1180
    await allocateCredit(owner, { receiptId: r2.id, allocations: [{ invoiceId: later.id, amount: "1180" }] });
    await expect(allocateCredit(owner, { receiptId: r2.id, allocations: [{ invoiceId: later.id, amount: "1" }] })).rejects.toMatchObject({ code: "OVERPAYMENT" });
    const third = await invoice(buyer.id, [{ description: "More", quantity: "1", unitPrice: "100", taxRateId: gst18 }]);
    await expect(allocateCredit(owner, { receiptId: r2.id, allocations: [{ invoiceId: third.id, amount: "21" }] })).rejects.toMatchObject({ code: "OVERALLOCATED" }); // 20 left

    const rj = (await journalOf("RECEIPT", r1.id))!;
    expect([net(rj.lines, "1210"), net(rj.lines, "1300")]).toEqual([5000, -5000]);

    // A paid invoice cannot be cancelled; cancelling the receipt first re-opens it.
    await expect(cancelInvoice(owner, later.id, { reason: "x" })).rejects.toThrow(/credit note/);
    await cancelReceipt(owner, r1.id, { reason: "Bounced cheque" });
    expect((await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } })).paidAmount.toString()).toBe("6800");
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: rj.id } })).status).toBe("REVERSED");
  });

  it("serializes concurrent receipts so an invoice is never overpaid", async () => {
    const inv = await invoice(buyer.id, [{ description: "Race", quantity: "1", unitPrice: "1000", taxRateId: gst18 }]); // 1180
    const pay = () => createReceipt(owner, { companyId: a.company.id, customerId: buyer.id, bankAccountId: bank.id, amount: "1000", allocations: [{ invoiceId: inv.id, amount: "1000" }] });
    const results = await Promise.allSettled([pay(), pay()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } })).paidAmount.toString()).toBe("1000");
  });

  it("credits an invoice line, applies it to the balance and mirrors the journal", async () => {
    const inv = await invoice(buyer.id, [{ description: "Chairs", quantity: "10", unitPrice: "1000", taxRateId: gst18 }]); // 11800
    const line = await prisma.salesInvoiceLine.findFirstOrThrow({ where: { invoiceId: inv.id } });
    await expect(createCreditNote(owner, { invoiceId: inv.id, reason: "x", lines: [{ invoiceLineId: line.id, quantity: "11" }] })).rejects.toMatchObject({ code: "QUANTITY_EXCEEDED" });
    const note = await createCreditNote(owner, { invoiceId: inv.id, reason: "2 chairs damaged", lines: [{ invoiceLineId: line.id, quantity: "2" }] });
    expect(note.grandTotal.toFixed(2)).toBe("2360.00");
    const posted = await postCreditNote(owner, note.id);
    expect(posted.number).toMatch(/^CN\//);
    expect((await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inv.id } })).creditedAmount.toString()).toBe("2360");
    const cj = (await journalOf("CREDIT_NOTE", note.id))!;
    expect([net(cj.lines, "1300"), net(cj.lines, "4000"), net(cj.lines, "2300")]).toEqual([-2360, 2000, 180]);
    await expect(cancelInvoice(owner, inv.id, { reason: "x" })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("cancels an unsettled invoice by reversing its journal", async () => {
    const inv = await invoice(consumer.id, [{ description: "Oops", quantity: "1", unitPrice: "100", taxRateId: gst18 }]);
    await cancelInvoice(owner, inv.id, { reason: "Raised in error" });
    const j = (await journalOf("SALES_INVOICE", inv.id))!;
    expect(j.status).toBe("REVERSED");
    const reversal = await prisma.journalEntry.findFirstOrThrow({ where: { reversalOfId: j.id } });
    expect(reversal.totalDebit.toString()).toBe(j.totalCredit.toString());
  });
});

describe("ledger integrity", () => {
  it("rejects unbalanced journals in the service and in the database", async () => {
    const accounts = await prisma.account.findMany({ where: { companyId: a.company.id, code: { in: ["1100", "3000"] } } });
    const [cashAcct, capital] = [accounts.find((x) => x.code === "1100")!, accounts.find((x) => x.code === "3000")!];
    const draft = await createManualJournal(owner, {
      companyId: a.company.id, date: todayStr, memo: "Owner capital",
      lines: [{ accountId: cashAcct.id, debit: "500" }, { accountId: capital.id, credit: "400" }],
    });
    await expect(postManualJournal(owner, draft.id)).rejects.toMatchObject({ code: "UNBALANCED" });

    // Bypass the service: the deferred trigger still refuses an unbalanced posted journal.
    await expect(
      prisma.journalEntry.create({
        data: {
          organizationId: a.org.id, companyId: a.company.id, date: new Date(), status: "POSTED", sourceType: "MANUAL", totalDebit: 1, totalCredit: 2,
          lines: { create: [{ companyId: a.company.id, accountId: cashAcct.id, debit: 1 }, { companyId: a.company.id, accountId: capital.id, credit: 2 }] },
        },
      }),
    ).rejects.toThrow(/Unbalanced journal/);
  });

  it("makes posted journals immutable and corrects them by reversal", async () => {
    const accounts = await prisma.account.findMany({ where: { companyId: a.company.id, code: { in: ["1100", "3000"] } } });
    const [cashAcct, capital] = [accounts.find((x) => x.code === "1100")!, accounts.find((x) => x.code === "3000")!];
    const draft = await createManualJournal(owner, {
      companyId: a.company.id, date: todayStr, memo: "Capital introduced",
      lines: [{ accountId: cashAcct.id, debit: "50000" }, { accountId: capital.id, credit: "50000" }],
    });
    const posted = await postManualJournal(owner, draft.id);
    expect(posted.status).toBe("POSTED");
    const line = await prisma.journalLine.findFirstOrThrow({ where: { entryId: draft.id } });
    await expect(prisma.journalLine.update({ where: { id: line.id }, data: { debit: 1 } })).rejects.toThrow(/cannot be modified/);
    await expect(prisma.journalEntry.update({ where: { id: draft.id }, data: { memo: "edited" } })).rejects.toThrow(/cannot be modified/);
    await expect(prisma.journalEntry.delete({ where: { id: draft.id } })).rejects.toThrow(/cannot be deleted/);

    const reversal = await reversePostedJournal(owner, draft.id, { reason: "Wrong account" });
    expect(reversal.totalDebit.toString()).toBe("50000");
    const again = await reversePostedJournal(owner, draft.id, { reason: "retry" });
    expect(again.id).toBe(reversal.id);
  });

  it("enforces period close rules", async () => {
    const second = await createCompany(owner, { code: "PERIODS", name: "Period Test Co", stateCode: "29" });
    const ctx = await a.ctx(a.ownerId);
    await setupFinance(ctx, second.id, { accountingStartDate: fyStart });
    const periods = (await listFiscalYears(ctx, second.id))[0].periods;
    await expect(setPeriodStatus(ctx, periods[1].id, { status: "CLOSED" })).rejects.toThrow(/earlier periods/);
    await setPeriodStatus(ctx, periods[0].id, { status: "CLOSED" });

    const branch = await prisma.branch.findFirstOrThrow({ where: { companyId: second.id } });
    const inClosed = await createInvoice(ctx, { companyId: second.id, branchId: branch.id, customerId: buyer.id, invoiceDate: ymd(periods[0].startDate), lines: [{ description: "x", quantity: "1", unitPrice: "100", taxRateId: gst18 }] });
    await expect(postInvoice(ctx, inClosed.id)).rejects.toMatchObject({ code: "PERIOD_CLOSED" });
    expect((await prisma.salesInvoice.findUniqueOrThrow({ where: { id: inClosed.id } })).number).toBeNull(); // rollback kept numbering gapless

    const nextYear = await createInvoice(ctx, { companyId: second.id, branchId: branch.id, customerId: buyer.id, invoiceDate: `${Number(fyStart.slice(0, 4)) + 2}-06-01`, lines: [{ description: "x", quantity: "1", unitPrice: "100", taxRateId: gst18 }] });
    await expect(postInvoice(ctx, nextYear.id)).rejects.toMatchObject({ code: "NO_PERIOD" });

    await expect(setPeriodStatus(ctx, periods[0].id, { status: "OPEN" })).rejects.toThrow(/reason/);
    await setPeriodStatus(ctx, periods[0].id, { status: "OPEN", reason: "Late supplier bill" });
    await postInvoice(ctx, inClosed.id);
  });

  it("does not journal documents dated before the accounting start date", async () => {
    const third = await createCompany(owner, { code: "LATE", name: "Late Starter", stateCode: "29" });
    const ctx = await a.ctx(a.ownerId);
    await setupFinance(ctx, third.id, { accountingStartDate: todayStr });
    const branch = await prisma.branch.findFirstOrThrow({ where: { companyId: third.id } });
    const yesterday = ymd(new Date(Date.now() - 86_400_000));
    const old = await createInvoice(ctx, { companyId: third.id, branchId: branch.id, customerId: buyer.id, invoiceDate: yesterday, lines: [{ description: "x", quantity: "1", unitPrice: "100", taxRateId: gst18 }] });
    const posted = await postInvoice(ctx, old.id);
    expect(posted.journalEntryId).toBeNull();
    expect(posted.number).toBeTruthy();
  });
});

describe("payables", () => {
  it("approves bills over the threshold, clears GRNI with price variance and pays without overpaying", async () => {
    const p = await createProduct(owner, { sku: "FIN-RAW", name: "Steel rod", uomId: nos, taxRateId: gst18, purchasePrice: "100" });
    const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { companyId: a.company.id } });
    const po = await createPurchaseOrder(owner, { companyId: a.company.id, branchId: a.branch.id, warehouseId: warehouse.id, vendorId, lines: [{ productId: p.id, quantity: "10" }] });
    await transitionPurchaseOrder(owner, po.id, "submit", {});
    const poLine = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id } });
    const grn = await receivePurchaseOrder(owner, po.id, { lines: [{ purchaseOrderLineId: poLine.id, quantity: "10" }] });
    const gj = (await journalOf("STOCK_ENTRY", grn.id))!;
    expect([net(gj.lines, "1400"), net(gj.lines, "2200")]).toEqual([1000, -1000]);

    await updateCompany(owner, a.company.id, { settings: { purchase: { billApprovalAmount: 1000 } } });
    const clerk = await a.addMember("purchase_manager");
    const clerkCtx = await a.ctx(clerk.userId);
    // Vendor billed 105/unit instead of 100: 50 of price variance.
    const bill = await createVendorBill(clerkCtx, {
      companyId: a.company.id, branchId: a.branch.id, vendorId, purchaseOrderId: po.id, vendorInvoiceNumber: "SS/991", billDate: todayStr,
      lines: [{ purchaseOrderLineId: poLine.id, quantity: "10", unitPrice: "105" }],
    });
    expect(bill.grandTotal.toFixed(2)).toBe("1239.00");
    await expect(postVendorBill(clerkCtx, bill.id)).rejects.toMatchObject({ code: "APPROVAL_REQUIRED" });
    await expect(approveVendorBill(clerkCtx, bill.id)).rejects.toThrow(/you entered/);
    await approveVendorBill(owner, bill.id);
    await postVendorBill(clerkCtx, bill.id);
    const bj = (await journalOf("VENDOR_BILL", bill.id))!;
    expect([net(bj.lines, "2200"), net(bj.lines, "5200"), net(bj.lines, "1500"), net(bj.lines, "1510"), net(bj.lines, "2100")]).toEqual([1000, 50, 94.5, 94.5, -1239]);

    const payment = await createVendorPayment(owner, { companyId: a.company.id, vendorId, bankAccountId: bank.id, amount: "1000", allocations: [{ billId: bill.id, amount: "1000" }] });
    await expect(
      createVendorPayment(owner, { companyId: a.company.id, vendorId, bankAccountId: bank.id, amount: "500", allocations: [{ billId: bill.id, amount: "500" }] }),
    ).rejects.toMatchObject({ code: "OVERPAYMENT" });
    const pj = (await journalOf("VENDOR_PAYMENT", payment.id))!;
    expect([net(pj.lines, "2100"), net(pj.lines, "1210")]).toEqual([1000, -1000]);
    await expect(cancelVendorBill(owner, bill.id, { reason: "x" })).rejects.toThrow(/reverse them/);

    // Debit note for 1 defective rod settles part of the remaining 239.
    const billLine = await prisma.vendorBillLine.findFirstOrThrow({ where: { billId: bill.id } });
    const dn = await createDebitNote(owner, { billId: bill.id, reason: "Defective", lines: [{ billLineId: billLine.id, quantity: "1" }] });
    await postDebitNote(owner, dn.id);
    const settled = await prisma.vendorBill.findUniqueOrThrow({ where: { id: bill.id } });
    expect([settled.paidAmount.toString(), settled.debitedAmount.toString()]).toEqual(["1000", "123.9"]);
    await updateCompany(owner, a.company.id, { settings: { purchase: { billApprovalAmount: null } } });
  });
});

describe("expenses, bank and cash", () => {
  it("approves and pays expense claims with segregation of duties", async () => {
    const employee = await a.addMember("sales_executive");
    const empCtx = await a.ctx(employee.userId);
    const travel = await prisma.expenseCategory.findFirstOrThrow({ where: { companyId: a.company.id, name: "Travel" } });
    const claim = await createExpenseClaim(empCtx, { companyId: a.company.id, title: "Client visit", lines: [{ categoryId: travel.id, expenseDate: todayStr, description: "Cab", amount: "850" }] });
    await expect(transitionExpenseClaim(empCtx, claim.id, "approve", {})).rejects.toMatchObject({ status: 403 });
    await transitionExpenseClaim(empCtx, claim.id, "submit", {});
    const accountant = await a.addMember("accountant");
    const accCtx = await a.ctx(accountant.userId);
    await transitionExpenseClaim(accCtx, claim.id, "approve", {});
    const paid = await transitionExpenseClaim(accCtx, claim.id, "pay", { bankAccountId: cash.id });
    expect(paid.status).toBe("PAID");
    const approveJ = (await journalOf("EXPENSE_CLAIM", claim.id, "approve"))!;
    const payJ = (await journalOf("EXPENSE_CLAIM", claim.id, "pay"))!;
    expect([net(approveJ.lines, "5500"), net(approveJ.lines, "2400")]).toEqual([850, -850]);
    expect([net(payJ.lines, "2400"), net(payJ.lines, "1100")]).toEqual([850, -850]);
  });

  it("imports statements idempotently and reconciles against ledger lines", async () => {
    const receipt = await createReceipt(owner, { companyId: a.company.id, customerId: consumer.id, bankAccountId: bank.id, amount: "777.77", reference: "UTR123" });
    const csv = `Date,Narration,Ref,Deposit,Withdrawal\n${todayStr.split("-").reverse().join("/")},NEFT Walk-in,UTR123,777.77,\n${todayStr.split("-").reverse().join("/")},Bank charges,,,"59.00"\nnot-a-date,broken,,1,\n`;
    const input = { fileName: "stmt.csv", csv, columns: { date: "Date", description: "Narration", reference: "Ref", credit: "Deposit", debit: "Withdrawal" } };
    const first = await importBankStatement(owner, bank.id, input);
    const second = await importBankStatement(owner, bank.id, input);
    expect([first.imported, first.errors.length, second.imported, second.duplicates]).toEqual([2, 1, 0, 2]);
    expect(first.source).toBe("manual-import");

    const deposit = await prisma.bankTransaction.findFirstOrThrow({ where: { bankAccountId: bank.id, reference: "UTR123" } });
    const matches = await suggestMatches(owner, deposit.id);
    const receiptLine = matches.find((m) => m.entry.sourceId === receipt.id)!;
    expect(receiptLine).toBeTruthy();
    const charge = await prisma.bankTransaction.findFirstOrThrow({ where: { bankAccountId: bank.id, description: "Bank charges" } });
    await expect(reconcileBankTransaction(owner, charge.id, { journalLineId: receiptLine.id })).rejects.toMatchObject({ code: "AMOUNT_MISMATCH" });
    await reconcileBankTransaction(owner, deposit.id, { journalLineId: receiptLine.id });
    const book = await getCashbook(owner, bank.id, {});
    expect(book.lines.find((l) => l.id === receiptLine.id)?.reconciled).toBe(true);
  });

  it("transfers between accounts with a journal", async () => {
    const t = await createTransfer(owner, { fromBankAccountId: bank.id, toBankAccountId: cash.id, amount: "2000" });
    const j = (await journalOf("TRANSFER", t.id))!;
    expect([net(j.lines, "1100"), net(j.lines, "1210")]).toEqual([2000, -2000]);
    await expect(createTransfer(owner, { fromBankAccountId: bank.id, toBankAccountId: bank.id, amount: "1" })).rejects.toThrow(/different accounts/);
  });
});

describe("reports", () => {
  it("produce a balanced trial balance and balance sheet that agree with P&L and the documents", async () => {
    const tb = await trialBalance(owner, a.company.id, {});
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);

    const pl = await profitAndLoss(owner, a.company.id, { from: fyStart, to: `${Number(fyStart.slice(0, 4)) + 1}-03-31` });
    expect(Number(pl.netProfit)).toBeCloseTo(Number(pl.income.total) - Number(pl.expenses.total), 2);
    const bs = await balanceSheet(owner, a.company.id, { asOf: todayStr });
    expect(bs.balanced).toBe(true);
    expect(bs.equity.accumulatedProfit).toBe(pl.netProfit);

    const recon = await financeReconciliation(owner, a.company.id);
    expect(recon.issues).toEqual([]);
    expect(recon.controls.filter((c) => c.control !== "Inventory (stock valuation)").every((c) => c.matches)).toBe(true);
    expect(recon.controls.find((c) => c.control === "Inventory (stock valuation)")?.matches).toBe(true);
  });

  it("ages receivables and builds a statement that ends at the outstanding balance", async () => {
    const overdue = await invoice(consumer.id, [{ description: "Old work", quantity: "1", unitPrice: "1000", taxRateId: gst18 }], { invoiceDate: ymd(new Date(Date.now() - 50 * 86_400_000)), dueDate: ymd(new Date(Date.now() - 40 * 86_400_000)) });
    const aging = await receivablesAging(owner, a.company.id, {});
    const row = aging.rows.find((r) => r.partyId === consumer.id)!;
    expect(row["31_60"]).toBe("1180.00");

    const statement = await customerStatement(owner, a.company.id, consumer.id, {});
    const outstandingTotal = (await prisma.salesInvoice.findMany({ where: { customerId: consumer.id, companyId: a.company.id, status: "POSTED" } }))
      .reduce((s, i) => s + Number(i.grandTotal) - Number(i.paidAmount) - Number(i.creditedAmount), 0);
    const unapplied = Number(row.unappliedCredit);
    expect(Number(statement.closingBalance)).toBeCloseTo(outstandingTotal - unapplied, 2);

    const reminders = await remindOverdueInvoices();
    const again = await remindOverdueInvoices();
    expect(reminders.sent).toBeGreaterThan(0);
    expect(again.sent).toBe(0);
    expect(await prisma.notification.count({ where: { type: "invoice.overdue", data: { path: ["invoiceId"], equals: overdue.id } } })).toBe(1);
  });

  it("prepares GSTR-1 and GSTR-3B for the registration", async () => {
    const from = fyStart;
    const to = `${Number(fyStart.slice(0, 4)) + 1}-03-31`;
    const r1 = await gstr1(owner, a.company.id, { gstin: SELLER, from, to });
    expect(r1.b2b.some((x) => x.customerGstin === INTERSTATE_BUYER && x.rates[0].igst === "900.00")).toBe(true);
    expect(r1.b2cs.length).toBeGreaterThan(0);
    expect(r1.creditDebitNotes.length).toBeGreaterThan(0);
    expect(r1.documents.invoices.cancelled).toBeGreaterThan(0);
    expect(r1.hsnSummary.some((h) => h.hsn === "84137010")).toBe(true);
    expect(r1.disclaimer).toMatch(/Not filed/);

    const r3 = await gstr3b(owner, a.company.id, { gstin: SELLER, from, to });
    const out = r3["3.1(a) outward taxable supplies (net of credit notes)"];
    const itc = r3["4(A)(5) all other ITC (from posted vendor bills)"];
    expect(Number(out.cgst)).toBeGreaterThan(0);
    expect(Number(itc.cgst)).toBeGreaterThan(0);
    expect(Number(r3.netTaxBeforeSetOff.cgst)).toBeCloseTo(Number(out.cgst) - Number(itc.cgst), 2);
    await expect(gstr1(owner, a.company.id, { gstin: INTERSTATE_BUYER, from, to })).rejects.toMatchObject({ status: 404 });
  });

  it("builds an e-invoice payload but never claims registration without a provider", async () => {
    const inv = await prisma.salesInvoice.findFirstOrThrow({ where: { companyId: a.company.id, customerGstin: INTERSTATE_BUYER, status: "POSTED" } });
    const built = await buildEInvoice(owner, inv.id);
    expect(built.payload.BuyerDtls.Gstin).toBe(INTERSTATE_BUYER);
    expect(built.payload.ValDtls.TotInvVal).toBe(5900);
    expect(built.ready).toBe(false);
    await expect(registerEInvoice(owner, inv.id)).rejects.toMatchObject({ code: "NOT_CONFIGURED" });
  });
});

describe("tenant isolation", () => {
  it("keeps finance data invisible to other tenants", async () => {
    const other = await b.ctx(b.ownerId);
    const inv = await prisma.salesInvoice.findFirstOrThrow({ where: { companyId: a.company.id, status: "POSTED" } });
    await expect(postInvoice(other, inv.id)).rejects.toMatchObject({ status: 404 });
    await expect(trialBalance(other, a.company.id, {})).rejects.toMatchObject({ status: 404 });
    await expect(
      createReceipt(other, { companyId: b.company.id, customerId: buyer.id, bankAccountId: bank.id, amount: "1" }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(setupFinance(other, a.company.id, { accountingStartDate: fyStart })).rejects.toMatchObject({ status: 404 });
  });
});
