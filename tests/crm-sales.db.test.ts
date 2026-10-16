import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import { computeLine, dec } from "@/lib/money";
import { convertLead } from "@/features/leads/conversion";
import { findDuplicateLeads } from "@/lib/leads/duplicates";
import {
  createContact,
  createCustomer,
  getTimeline,
  logActivity,
  updateCrmSettings,
} from "@/features/customers/service";
import { changeOpportunityStage, createOpportunity, updateOpportunity } from "@/features/opportunities/service";
import { createProduct, setCustomerPrices } from "@/features/catalog/service";
import {
  convertQuotationToOrder,
  createQuotation,
  expireQuotations,
  getQuotation,
  listQuotations,
  reviseQuotation,
  transitionQuotation,
  updateQuotation,
} from "@/features/sales/quotations";
import { cancelSalesOrder, confirmSalesOrder, updateSalesOrder } from "@/features/sales/orders";
import { getCrmFunnel } from "@/features/crm/reports";
import { updateCompany, createBranch } from "@/features/companies/service";
import * as quotationsRoute from "@/app/api/v1/quotations/route";
import * as convertRoute from "@/app/api/v1/leads/[id]/convert/route";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";
import { call, signInAs } from "./helpers/http";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));

let a: OrgFixture;
let b: OrgFixture;
let manager: { userId: string };
let exec: { userId: string };
let gst18: string;
let nos: string;
let widget: { id: string };

async function makeLead(fields: Partial<{ fullName: string; company: string; email: string; phone: string; gstNo: string; assignedUserId: string }> = {}) {
  return prisma.lead.create({
    data: {
      organizationId: a.org.id,
      fullName: fields.fullName ?? "Ravi Kumar",
      firstName: (fields.fullName ?? "Ravi Kumar").split(" ")[0],
      lastName: (fields.fullName ?? "Ravi Kumar").split(" ")[1],
      company: fields.company,
      email: fields.email,
      phone: fields.phone ?? `9${Math.floor(Math.random() * 1e9)}`,
      gstNo: fields.gstNo,
      assignedUserId: fields.assignedUserId ?? a.ownerId,
    },
  });
}

beforeAll(async () => {
  a = await createOrg("Sales Co");
  b = await createOrg("Rival Co");
  manager = await a.addMember("sales_manager");
  exec = await a.addMember("sales_executive");
  await prisma.company.update({ where: { id: a.company.id }, data: { stateCode: "29" } });
  gst18 = (await prisma.taxRate.findFirstOrThrow({ where: { organizationId: a.org.id, name: "GST 18%" } })).id;
  nos = (await prisma.uom.findFirstOrThrow({ where: { organizationId: a.org.id, code: "NOS" } })).id;
  widget = await createProduct(await a.ctx(a.ownerId), {
    sku: "WID-1", name: "Widget", uomId: nos, taxRateId: gst18, salesPrice: "333.33", purchasePrice: "200",
  });
});
afterAll(cleanupFixtures);

describe("quotation maths", () => {
  it("rounds per line and splits GST by place of supply", () => {
    const line = { quantity: dec("3"), unitPrice: dec("333.33"), discountPercent: dec("10"), taxRate: dec("18") };
    const intra = computeLine(line, true);
    expect(intra.grossAmount.toFixed(2)).toBe("999.99");
    expect(intra.discountAmount.toFixed(2)).toBe("100.00");
    expect(intra.taxableAmount.toFixed(2)).toBe("899.99");
    expect([intra.cgstAmount.toFixed(2), intra.sgstAmount.toFixed(2), intra.igstAmount.toFixed(2)]).toEqual(["81.00", "81.00", "0.00"]);
    expect(intra.lineTotal.toFixed(2)).toBe("1061.99");
    const inter = computeLine(line, false);
    expect([inter.cgstAmount.toFixed(2), inter.igstAmount.toFixed(2), inter.lineTotal.toFixed(2)]).toEqual(["0.00", "162.00", "1061.99"]);
  });
});

describe("lead conversion", () => {
  it("creates customer, contact and opportunity in one transaction", async () => {
    const lead = await makeLead({ fullName: "Asha Rao", company: "Rao Traders", email: "asha@rao.test", gstNo: "29ABCDE1234F1Z5" });
    const ctx = await a.ctx(manager.userId);
    const result = await convertLead(ctx, lead.id, {});
    expect(result.alreadyConverted).toBe(false);

    const customer = await prisma.customer.findUniqueOrThrow({ where: { id: result.customerId } });
    expect(customer).toMatchObject({ name: "Rao Traders", gstin: "29ABCDE1234F1Z5", stateCode: "29", pan: "ABCDE1234F" });
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: result.contactId! } });
    expect(contact).toMatchObject({ customerId: customer.id, fullName: "Asha Rao", isPrimary: true });
    const updated = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } });
    expect(updated).toMatchObject({ status: "CONVERTED", convertedCustomerId: customer.id, convertedContactId: contact.id });
    const opp = await prisma.opportunity.findUniqueOrThrow({ where: { id: result.opportunityId! } });
    expect(opp.leadId).toBe(lead.id);

    // Customer timeline carries the lead's history.
    const timeline = await getTimeline(ctx, { customerId: customer.id });
    expect(timeline.some((e) => e.source === "lead" && e.type === "CONVERTED")).toBe(true);
  });

  it("is retry-safe: repeats and concurrent calls create nothing twice", async () => {
    const lead = await makeLead({ fullName: "Neha Singh", email: "neha@singh.test" });
    const ctx = await a.ctx(manager.userId);
    const [first, second] = await Promise.all([convertLead(ctx, lead.id, {}), convertLead(ctx, lead.id, {})]);
    expect(first.customerId).toBe(second.customerId);
    const again = await convertLead(ctx, lead.id, {});
    expect(again).toMatchObject({ customerId: first.customerId, alreadyConverted: true });
    expect(await prisma.customer.count({ where: { organizationId: a.org.id, email: "neha@singh.test" } })).toBe(1);
    expect(await prisma.opportunity.count({ where: { organizationId: a.org.id, leadId: lead.id } })).toBe(1);

    // Idempotent HTTP retry replays the stored response.
    await signInAs(manager.userId);
    const lead2 = await makeLead({ fullName: "Http Retry", email: "retry@http.test" });
    const send = () => call(convertRoute.POST, { method: "POST", params: { id: lead2.id }, body: {}, headers: { "idempotency-key": `conv-${lead2.id}` } });
    const r1 = await send();
    const r2 = await send();
    expect(r1.status).toBe(200);
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect(r2.json.data.customerId).toBe(r1.json.data.customerId);
  });

  it("stops on duplicate customers unless told to link or ignore", async () => {
    const ctx = await a.ctx(manager.userId);
    const existing = await createCustomer(ctx, { name: "Existing Ltd", email: "ops@existing.test" });
    const lead = await makeLead({ fullName: "Dup Lead", company: "Existing Ltd", email: "ops@existing.test" });

    await expect(convertLead(ctx, lead.id, {})).rejects.toMatchObject({
      status: 409,
      code: "DUPLICATE",
      details: [expect.objectContaining({ id: existing.id, matchedOn: ["email"] })],
    });
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: lead.id } })).convertedCustomerId).toBeNull();

    const linked = await convertLead(ctx, lead.id, { customerId: existing.id, createOpportunity: false });
    expect(linked).toMatchObject({ customerId: existing.id, opportunityId: null });
  });

  it("enforces permissions and lead visibility", async () => {
    const viewer = await a.addMember("viewer");
    const lead = await makeLead({ fullName: "Locked Lead" });
    await expect(convertLead(await a.ctx(viewer.userId), lead.id, {})).rejects.toMatchObject({ status: 403 });
    // Not assigned to the sales executive and they lack lead.view_all.
    await expect(convertLead(await a.ctx(exec.userId), lead.id, {})).rejects.toMatchObject({ status: 404 });
    // Another tenant cannot reach it at all.
    await expect(convertLead(await b.ctx(b.ownerId), lead.id, {})).rejects.toMatchObject({ status: 404 });
  });
});

describe("configurable duplicate detection", () => {
  it("follows the organization's matching rules for customers and leads", async () => {
    const ctx = await a.ctx(a.ownerId);
    await createCustomer(ctx, { name: "Rules Pvt Ltd", email: "rules@test.local", ignoreDuplicates: true });
    await expect(createCustomer(ctx, { name: "Other Name", email: "rules@test.local" })).rejects.toMatchObject({ code: "DUPLICATE" });

    await updateCrmSettings(ctx, { duplicates: { customer: ["name"], lead: ["phone"] } });
    const byEmail = await createCustomer(ctx, { name: "Other Name", email: "rules@test.local" });
    expect(byEmail.id).toBeTruthy();
    await expect(createCustomer(ctx, { name: "rules pvt ltd" })).rejects.toMatchObject({ code: "DUPLICATE" });

    await makeLead({ fullName: "Rule Lead", email: "rule-lead@test.local", phone: "9811111111" });
    expect(await findDuplicateLeads(a.org.id, { email: "rule-lead@test.local" })).toHaveLength(0);
    expect(await findDuplicateLeads(a.org.id, { phone: "9811111111" })).toHaveLength(1);
    await updateCrmSettings(ctx, {});
  });
});

describe("opportunities and interactions", () => {
  it("validates stage transitions", async () => {
    const ctx = await a.ctx(manager.userId);
    const customer = await createCustomer(ctx, { name: "Pipeline Co", ignoreDuplicates: true });
    const opp = await createOpportunity(ctx, { name: "Big deal", customerId: customer.id, amount: "50000" });
    expect(opp.probability).toBe(10);

    const moved = await changeOpportunityStage(ctx, opp.id, { stage: "NEGOTIATION" });
    expect(moved.probability).toBe(75);
    await expect(changeOpportunityStage(ctx, opp.id, { stage: "LOST" })).rejects.toThrow(/loss reason/);
    const lost = await changeOpportunityStage(ctx, opp.id, { stage: "LOST", lossReason: "Price" });
    expect(lost).toMatchObject({ stage: "LOST", probability: 0, lossReason: "Price" });
    expect(lost.closedAt).toBeInstanceOf(Date);
    await expect(changeOpportunityStage(ctx, opp.id, { stage: "WON" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(updateOpportunity(ctx, opp.id, { amount: "1" })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("rejects contacts of another customer and logs interactions on the timeline", async () => {
    const ctx = await a.ctx(manager.userId);
    const c1 = await createCustomer(ctx, { name: "Timeline One", ignoreDuplicates: true });
    const c2 = await createCustomer(ctx, { name: "Timeline Two", ignoreDuplicates: true });
    const contact2 = await createContact(ctx, { customerId: c2.id, firstName: "Meera" });
    await expect(createOpportunity(ctx, { name: "x", customerId: c1.id, contactId: contact2.id })).rejects.toMatchObject({
      code: "INVALID_REFERENCE",
    });

    await logActivity(ctx, { type: "CALL", subject: "Intro call", contactId: contact2.id, durationMin: 15 });
    const timeline = await getTimeline(ctx, { customerId: c2.id });
    expect(timeline[0]).toMatchObject({ source: "activity", type: "CALL", subject: "Intro call" });
    await expect(logActivity(ctx, { type: "NOTE", subject: "orphan" })).rejects.toThrow(/Link the interaction/);
  });
});

describe("quotations", () => {
  let customerId: string;

  beforeAll(async () => {
    const ctx = await a.ctx(a.ownerId);
    customerId = (await createCustomer(ctx, { name: "Quote Buyer", stateCode: "29", ignoreDuplicates: true })).id;
    await updateCompany(await a.ctx(a.ownerId), a.company.id, {
      settings: { quotation: { approvalDiscountPercent: 10, approvalAmount: 100000 } },
    });
  });

  const newQuote = async (userId: string, lines: unknown[], extra: Record<string, unknown> = {}) =>
    createQuotation(await a.ctx(userId), { companyId: a.company.id, branchId: a.branch.id, customerId, lines, ...extra });

  it("prices lines from customer prices, product defaults and place of supply", async () => {
    await setCustomerPrices(await a.ctx(a.ownerId), customerId, { prices: [{ productId: widget.id, unitPrice: "300" }] });
    const q = await newQuote(exec.userId, [{ productId: widget.id, quantity: "2" }]);
    expect(q.number).toMatch(/^QT-\d{5}$/);
    expect(q.lines[0]).toMatchObject({ description: "Widget", taxRateId: gst18 });
    expect(q.lines[0].unitPrice.toFixed(2)).toBe("300.00");
    expect(q.lines[0].cgstAmount.toFixed(2)).toBe("54.00"); // 600 x 9%, intra-state (29 = 29)
    expect(q.grandTotal.toFixed(2)).toBe("708.00");

    const inter = await newQuote(exec.userId, [{ productId: widget.id, quantity: "2" }], { placeOfSupplyState: "27" });
    expect(inter.lines[0].igstAmount.toFixed(2)).toBe("108.00");
    await setCustomerPrices(await a.ctx(a.ownerId), customerId, { prices: [{ productId: widget.id, unitPrice: null }] });
  });

  it("auto-approves within thresholds and routes larger discounts or values to approval", async () => {
    const small = await newQuote(exec.userId, [{ productId: widget.id, quantity: "1", discountPercent: "5" }]);
    const auto = await transitionQuotation(await a.ctx(exec.userId), small.id, "submit", {});
    expect(auto).toMatchObject({ status: "APPROVED", approvalRequired: false });

    const discounted = await newQuote(exec.userId, [{ productId: widget.id, quantity: "1", discountPercent: "15" }]);
    const pending = await transitionQuotation(await a.ctx(exec.userId), discounted.id, "submit", {});
    expect(pending).toMatchObject({ status: "PENDING_APPROVAL", approvalRequired: true });
    expect(pending.approvalReason).toMatch(/Discount 15% exceeds 10%/);

    const big = await newQuote(exec.userId, [{ description: "Turnkey project", quantity: "1", unitPrice: "200000" }]);
    expect((await transitionQuotation(await a.ctx(exec.userId), big.id, "submit", {})).approvalReason).toMatch(/Total/);

    // Executives cannot approve; the creator cannot approve their own quotation.
    await expect(transitionQuotation(await a.ctx(exec.userId), discounted.id, "approve", {})).rejects.toMatchObject({ status: 403 });
    const own = await newQuote(manager.userId, [{ productId: widget.id, quantity: "1", discountPercent: "20" }]);
    await transitionQuotation(await a.ctx(manager.userId), own.id, "submit", {});
    await expect(transitionQuotation(await a.ctx(manager.userId), own.id, "approve", {})).rejects.toThrow(/you created/);

    await expect(transitionQuotation(await a.ctx(manager.userId), discounted.id, "return", {})).rejects.toThrow(/Explain/);
    const returned = await transitionQuotation(await a.ctx(manager.userId), discounted.id, "return", { note: "Max 12%" });
    expect(returned).toMatchObject({ status: "DRAFT", approvalNote: "Max 12%" });
    await transitionQuotation(await a.ctx(exec.userId), discounted.id, "submit", {});
    const approved = await transitionQuotation(await a.ctx(manager.userId), discounted.id, "approve", { note: "ok" });
    expect(approved).toMatchObject({ status: "APPROVED", approvedById: manager.userId });
  });

  it("rejects invalid transitions and edits outside DRAFT", async () => {
    const ctx = await a.ctx(manager.userId);
    const q = await newQuote(manager.userId, [{ productId: widget.id, quantity: "1" }]);
    await expect(transitionQuotation(ctx, q.id, "send", {})).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(transitionQuotation(ctx, q.id, "accept", {})).rejects.toMatchObject({ code: "INVALID_STATE" });
    await transitionQuotation(ctx, q.id, "submit", {});
    await expect(updateQuotation(ctx, q.id, { notes: "late edit" })).rejects.toThrow(/revise it instead/);
    await expect(transitionQuotation(ctx, q.id, "reject", {})).rejects.toThrow(/rejection reason/);

    const rev = await reviseQuotation(ctx, q.id);
    expect(rev).toMatchObject({ number: q.number, revision: 2, status: "DRAFT", previousRevisionId: q.id });
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("SUPERSEDED");
    await expect(reviseQuotation(ctx, q.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect((await prisma.quotationLine.count({ where: { quotationId: rev.id } }))).toBe(1);
  });

  it("converts an accepted quotation to exactly one sales order and wins the opportunity", async () => {
    const ctx = await a.ctx(manager.userId);
    const opp = await createOpportunity(ctx, { name: "Quote deal", customerId, amount: "1000" });
    const q = await newQuote(manager.userId, [{ productId: widget.id, quantity: "4" }], { opportunityId: opp.id });
    await expect(convertQuotationToOrder(ctx, q.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await transitionQuotation(ctx, q.id, "submit", {});
    await transitionQuotation(ctx, q.id, "send", {});
    await transitionQuotation(ctx, q.id, "accept", {});
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: opp.id } })).stage).toBe("WON");

    const [one, two] = await Promise.all([convertQuotationToOrder(ctx, q.id), convertQuotationToOrder(ctx, q.id)]);
    expect(one.salesOrder.id).toBe(two.salesOrder.id);
    expect(await prisma.salesOrder.count({ where: { quotationId: q.id } })).toBe(1);
    const order = await prisma.salesOrder.findUniqueOrThrow({ where: { id: one.salesOrder.id }, include: { lines: true } });
    expect(order).toMatchObject({ status: "DRAFT", customerId, grandTotal: q.grandTotal });
    expect(order.number).toMatch(/^SO-/);
    expect(order.lines[0].quotationLineId).toBeTruthy();

    // Amend while confirmed (nothing delivered), then cancel with a reason.
    await confirmSalesOrder(ctx, order.id);
    const amended = await updateSalesOrder(ctx, order.id, { lines: [{ productId: widget.id, quantity: "5" }] });
    expect(amended.amendmentCount).toBe(1);
    await expect(cancelSalesOrder(ctx, order.id, {})).rejects.toThrow(/reason/);
    const cancelled = await cancelSalesOrder(ctx, order.id, { reason: "Customer withdrew" });
    expect(cancelled.status).toBe("CANCELLED");
    await expect(confirmSalesOrder(ctx, order.id)).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(updateSalesOrder(ctx, order.id, { notes: "x" })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("expires stale quotations via the job", async () => {
    const ctx = await a.ctx(manager.userId);
    const q = await newQuote(manager.userId, [{ productId: widget.id, quantity: "1" }]);
    await transitionQuotation(ctx, q.id, "submit", {});
    await prisma.quotation.update({ where: { id: q.id }, data: { validUntil: new Date("2020-01-01") } });
    await expireQuotations();
    expect((await prisma.quotation.findUniqueOrThrow({ where: { id: q.id } })).status).toBe("EXPIRED");
    await expect(transitionQuotation(ctx, q.id, "accept", {})).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("scopes quotations to the member's companies and branches", async () => {
    const ownerCtx = await a.ctx(a.ownerId);
    const blr = await createBranch(ownerCtx, a.company.id, { code: "BLR2", name: "Bengaluru 2" });
    const hoQuote = await newQuote(a.ownerId, [{ productId: widget.id, quantity: "1" }]);
    const branchMember = await a.addMember("sales_manager", [{ companyId: a.company.id, branchId: blr.id }]);
    const ctx = await a.ctx(branchMember.userId);

    await expect(getQuotation(ctx, hoQuote.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      createQuotation(ctx, { companyId: a.company.id, branchId: a.branch.id, customerId, lines: [{ productId: widget.id, quantity: "1" }] }),
    ).rejects.toMatchObject({ status: 404 });
    const mine = await createQuotation(ctx, { companyId: a.company.id, branchId: blr.id, customerId, lines: [{ productId: widget.id, quantity: "1" }] });
    const visible = await listQuotations(ctx, { pageSize: "100" });
    expect(visible.items.map((q) => q.id)).toEqual([mine.id]);

    // Other tenants cannot use our customers or products.
    await expect(
      createQuotation(await b.ctx(b.ownerId), { companyId: b.company.id, branchId: b.branch.id, customerId, lines: [{ productId: widget.id, quantity: "1" }] }),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("returns 401/422 at the HTTP layer", async () => {
    await signInAs(null);
    expect((await call(quotationsRoute.POST, { method: "POST", body: {} })).status).toBe(401);
    await signInAs(manager.userId);
    const res = await call(quotationsRoute.POST, {
      method: "POST",
      body: { companyId: a.company.id, branchId: a.branch.id, customerId, lines: [] },
    });
    expect(res.status).toBe(422);
    expect(res.json.details[0]).toMatchObject({ path: "lines", message: "Add at least one line" });
  });
});

describe("CRM funnel", () => {
  it("reports conversion, pipeline and win rate", async () => {
    const report = await getCrmFunnel(await a.ctx(manager.userId), {});
    expect(report.leads.created).toBeGreaterThan(0);
    expect(report.leads.converted).toBeGreaterThanOrEqual(3);
    expect(report.deals.won).toBeGreaterThanOrEqual(1);
    expect(report.deals.lost).toBeGreaterThanOrEqual(1);
    expect(report.deals.winRate).toBeGreaterThan(0);
    expect(report.pipeline.stages.map((s) => s.stage)).toEqual(["PROSPECTING", "QUALIFICATION", "PROPOSAL", "NEGOTIATION"]);
    await expect(getCrmFunnel(await a.ctx(exec.userId), {})).rejects.toMatchObject({ status: 403 });
  });
});
