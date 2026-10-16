import { createHash } from "crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import * as quotationsRoute from "@/app/api/portal/[portal]/quotations/route";
import * as quotationRoute from "@/app/api/portal/[portal]/quotations/[id]/route";
import * as invoicesRoute from "@/app/api/portal/[portal]/invoices/route";
import * as invoiceRoute from "@/app/api/portal/[portal]/invoices/[id]/route";
import * as ticketsRoute from "@/app/api/portal/[portal]/tickets/route";
import * as ticketRoute from "@/app/api/portal/[portal]/tickets/[id]/route";
import * as ticketActionRoute from "@/app/api/portal/[portal]/tickets/[id]/[action]/route";
import * as catalogRoute from "@/app/api/portal/[portal]/catalog/route";
import * as orderRequestsRoute from "@/app/api/portal/[portal]/order-requests/route";
import * as vendorPosRoute from "@/app/api/portal/vendor/purchase-orders/route";
import * as vendorPoRoute from "@/app/api/portal/vendor/purchase-orders/[id]/route";
import * as vendorReceiptsRoute from "@/app/api/portal/vendor/receipts/route";
import * as vendorBillsRoute from "@/app/api/portal/vendor/bills/route";
import * as profileRoute from "@/app/api/portal/employee/profile/route";
import * as payslipsRoute from "@/app/api/portal/employee/payslips/route";
import * as payslipRoute from "@/app/api/portal/employee/payslips/[id]/route";
import * as attendanceActionRoute from "@/app/api/portal/employee/attendance/[action]/route";
import * as leaveRequestsRoute from "@/app/api/portal/employee/leave/requests/route";
import * as leaveCancelRoute from "@/app/api/portal/employee/leave/requests/[id]/cancel/route";
import * as jobsRoute from "@/app/api/portal/technician/jobs/route";
import * as visitRoute from "@/app/api/portal/technician/visits/[id]/route";
import * as visitActionRoute from "@/app/api/portal/technician/visits/[id]/[action]/route";
import * as acceptRoute from "@/app/api/portal/accept/route";
import * as invitationsRoute from "@/app/api/v1/portal-invitations/route";
import * as revokeRoute from "@/app/api/v1/portal-invitations/[id]/revoke/route";
import * as accountsRoute from "@/app/api/v1/portal-accounts/route";
import * as accountActionRoute from "@/app/api/v1/portal-accounts/[id]/[action]/route";
import * as customersRoute from "@/app/api/v1/customers/route";
import { cleanupFixtures, createOrg, createUser, type OrgFixture } from "./helpers/fixtures";
import { call, signInAs } from "./helpers/http";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));

let a: OrgFixture;
let b: OrgFixture;
const ids: Record<string, string> = {};
const users: Record<string, string> = {};

const C = { portal: "customer" };
const D = { portal: "dealer" };
const money = { subtotal: 1000, taxableTotal: 1000, grandTotal: 1000 };

async function account(kind: string, party: { customerId?: string; vendorId?: string; employeeId?: string }, org = a, userId?: string) {
  const id = userId ?? (await createUser(kind.toLowerCase()));
  await prisma.portalAccount.create({ data: { organizationId: org.org.id, userId: id, kind, ...party } });
  return id;
}

beforeAll(async () => {
  a = await createOrg("Portal A");
  b = await createOrg("Portal B");
  const org = { organizationId: a.org.id };
  const co = { ...org, companyId: a.company.id, branchId: a.branch.id };
  const by = { createdById: a.ownerId };
  const uom = await prisma.uom.findFirstOrThrow({ where: org });
  const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { companyId: a.company.id } });

  // Customers, dealer and catalog
  ids.c1 = (await prisma.customer.create({ data: { ...org, name: "Cust One", ...by } })).id;
  ids.c2 = (await prisma.customer.create({ data: { ...org, name: "Cust Two", ...by } })).id;
  ids.dealer = (await prisma.customer.create({ data: { ...org, name: "Dealer", isDealer: true, ...by } })).id;
  const product = (sku: string) => prisma.product.create({ data: { ...org, sku, name: sku, uomId: uom.id, salesPrice: 500, purchasePrice: 300, ...by } });
  ids.p1 = (await product("P1")).id;
  ids.p2 = (await product("P2")).id;
  await prisma.customerPrice.create({ data: { ...org, customerId: ids.dealer, productId: ids.p1, unitPrice: 420 } });
  await prisma.customerPrice.create({ data: { ...org, customerId: ids.c2, productId: ids.p2, unitPrice: 999 } });

  // Quotations: visible, draft, other customer's
  const quote = (customerId: string, number: string, status: "SENT" | "DRAFT") =>
    prisma.quotation.create({ data: { ...co, ...by, customerId, number, status, validUntil: new Date("2099-01-01"), notes: "INTERNAL-NOTE", ...money } });
  ids.q1 = (await quote(ids.c1, "QT-1", "SENT")).id;
  ids.qDraft = (await quote(ids.c1, "QT-2", "DRAFT")).id;
  ids.q2 = (await quote(ids.c2, "QT-3", "SENT")).id;

  // Invoices
  const invoice = (customerId: string, number: string | null, status: "POSTED" | "DRAFT") =>
    prisma.salesInvoice.create({ data: { ...co, ...by, customerId, number, status, invoiceDate: new Date(), dueDate: new Date(), paidAmount: 400, notes: "INTERNAL-NOTE", ...money } });
  ids.inv1 = (await invoice(ids.c1, "INV/1", "POSTED")).id;
  ids.invDraft = (await invoice(ids.c1, null, "DRAFT")).id;
  ids.inv2 = (await invoice(ids.c2, "INV/2", "POSTED")).id;

  // Tickets with internal + public messages
  ids.t1 = (await prisma.ticket.create({ data: { ...org, companyId: a.company.id, number: "TKT-1", subject: "Broken", customerId: ids.c1 } })).id;
  ids.t2 = (await prisma.ticket.create({ data: { ...org, companyId: a.company.id, number: "TKT-2", subject: "Other", customerId: ids.c2 } })).id;
  await prisma.ticketMessage.createMany({
    data: [
      { ...org, ticketId: ids.t1, body: "We are on it", visibility: "PUBLIC" },
      { ...org, ticketId: ids.t1, body: "SECRET internal note", visibility: "INTERNAL" },
    ],
  });

  // Vendors, POs, receipt
  ids.v1 = (await prisma.vendor.create({ data: { ...org, name: "Vendor One", ...by } })).id;
  ids.v2 = (await prisma.vendor.create({ data: { ...org, name: "Vendor Two", ...by } })).id;
  const po = (vendorId: string, number: string, status: "APPROVED" | "DRAFT") =>
    prisma.purchaseOrder.create({
      data: {
        ...co, ...by, warehouseId: warehouse.id, vendorId, number, status, approvedAt: status === "APPROVED" ? new Date() : null, notes: "INTERNAL-NOTE", ...money,
        lines: { create: { productId: ids.p1, description: "P1", quantity: 10, unitPrice: 100, grossAmount: 1000, discountAmount: 0, taxableAmount: 1000, taxAmount: 0, lineTotal: 1000 } },
      },
      include: { lines: true },
    });
  const po1 = await po(ids.v1, "PO-1", "APPROVED");
  ids.po1 = po1.id;
  ids.po1Line = po1.lines[0].id;
  ids.poDraft = (await po(ids.v1, "PO-2", "DRAFT")).id;
  ids.po2 = (await po(ids.v2, "PO-3", "APPROVED")).id;
  await prisma.stockEntry.create({
    data: {
      ...co, ...by, number: "GRN-1", type: "GOODS_RECEIPT", status: "POSTED", purchaseOrderId: ids.po1, vendorId: ids.v1, targetWarehouseId: warehouse.id, postedAt: new Date(),
      lines: { create: { productId: ids.p1, quantity: 4, baseQuantity: 4, unitCost: 77.77, purchaseOrderLineId: ids.po1Line } },
    },
  });

  // Employees, payroll, leave
  const emp = (n: string) => prisma.employee.create({ data: { ...org, companyId: a.company.id, employeeNumber: n, firstName: n, fullName: n, joiningDate: new Date("2020-01-01"), status: "ACTIVE", exitReason: "SECRET" } });
  ids.e1 = (await emp("E1")).id;
  ids.e2 = (await emp("E2")).id;
  const run = (period: string, status: string) => prisma.payrollRun.create({ data: { ...org, companyId: a.company.id, period, status, ...by } });
  const slip = (runId: string, employeeId: string) =>
    prisma.payslip.create({ data: { ...org, runId, employeeId, workingDays: 30, paidDays: 30, unpaidDays: 0, grossEarnings: 5000, totalDeductions: 0, netPay: 5000, lines: [] } });
  const approved = await run("2026-01", "APPROVED");
  const draft = await run("2026-02", "CALCULATED");
  ids.slip1 = (await slip(approved.id, ids.e1)).id;
  ids.slipDraft = (await slip(draft.id, ids.e1)).id;
  ids.slip2 = (await slip(approved.id, ids.e2)).id;
  ids.leaveType = (await prisma.leaveType.create({ data: { ...org, companyId: a.company.id, code: "CL", name: "Casual", annualQuota: 12, allowNegative: true } })).id;

  // Technicians and visits
  users.tech = (await a.addMember("technician")).userId;
  const otherTech = (await a.addMember("technician")).userId;
  const visit = (technicianId: string) =>
    prisma.serviceVisit.create({ data: { ...org, companyId: a.company.id, technicianId, scheduledStart: new Date(Date.now() + 3600_000), scheduledEnd: new Date(Date.now() + 7200_000) } });
  ids.visit1 = (await visit(users.tech)).id;
  ids.visit2 = (await visit(otherTech)).id;

  // Portal accounts
  users.c1 = await account("CUSTOMER", { customerId: ids.c1 });
  users.dealer = await account("DEALER", { customerId: ids.dealer });
  users.v1 = await account("VENDOR", { vendorId: ids.v1 });
  users.e1 = await account("EMPLOYEE", { employeeId: ids.e1 });
  await account("TECHNICIAN", {}, a, users.tech);
  users.suspended = await account("CUSTOMER", { customerId: ids.c2 });
  await prisma.portalAccount.updateMany({ where: { userId: users.suspended }, data: { status: "SUSPENDED" } });

  // Org B: a customer with a quotation, and a portal account for it
  ids.bCust = (await prisma.customer.create({ data: { organizationId: b.org.id, name: "B cust", createdById: b.ownerId } })).id;
  ids.bQuote = (
    await prisma.quotation.create({
      data: { organizationId: b.org.id, companyId: b.company.id, branchId: b.branch.id, customerId: ids.bCust, number: "QT-B", status: "SENT", validUntil: new Date("2099-01-01"), createdById: b.ownerId },
    })
  ).id;
});
afterAll(cleanupFixtures);

describe("customer portal", () => {
  it("lists only the customer's non-draft quotations, without internal fields", async () => {
    await signInAs(users.c1);
    const res = await call(quotationsRoute.GET, { params: C });
    expect(res.status).toBe(200);
    expect(res.json.data.items.map((q: { id: string }) => q.id)).toEqual([ids.q1]);
    const one = await call(quotationRoute.GET, { params: { ...C, id: ids.q1 } });
    expect(one.status).toBe(200);
    expect(JSON.stringify(one.json)).not.toContain("INTERNAL-NOTE");
    expect(one.json.data).not.toHaveProperty("createdById");
  });

  it("answers 404 for drafts, other customers' and other tenants' records", async () => {
    await signInAs(users.c1);
    for (const id of [ids.qDraft, ids.q2, ids.bQuote]) expect((await call(quotationRoute.GET, { params: { ...C, id } })).status).toBe(404);
    expect((await call(invoiceRoute.GET, { params: { ...C, id: ids.inv2 } })).status).toBe(404);
    expect((await call(invoiceRoute.GET, { params: { ...C, id: ids.invDraft } })).status).toBe(404);
    expect((await call(ticketRoute.GET, { params: { ...C, id: ids.t2 } })).status).toBe(404);
  });

  it("shows posted invoices with outstanding amounts", async () => {
    await signInAs(users.c1);
    const res = await call(invoicesRoute.GET, { params: C });
    expect(res.json.data.items).toHaveLength(1);
    expect(res.json.data.items[0]).toMatchObject({ id: ids.inv1, outstanding: "600.00" });
    expect(JSON.stringify(res.json)).not.toContain("INTERNAL-NOTE");
    const one = await call(invoiceRoute.GET, { params: { ...C, id: ids.inv1 } });
    expect(one.json.data).toMatchObject({ number: "INV/1", outstanding: "600.00" });
  });

  it("never returns INTERNAL ticket messages; replies are public customer messages", async () => {
    await signInAs(users.c1);
    const res = await call(ticketRoute.GET, { params: { ...C, id: ids.t1 } });
    expect(res.status).toBe(200);
    expect(res.json.data.messages.map((m: { body: string }) => m.body)).toEqual(["We are on it"]);
    expect(JSON.stringify(res.json)).not.toContain("SECRET");

    const reply = await call(ticketActionRoute.POST, { method: "POST", params: { ...C, id: ids.t1, action: "reply" }, body: { body: "Thanks" } });
    expect(reply.status).toBe(200);
    const stored = await prisma.ticketMessage.findUniqueOrThrow({ where: { id: reply.json.data.id } });
    expect(stored).toMatchObject({ authorType: "CUSTOMER", visibility: "PUBLIC", authorUserId: users.c1 });
    expect((await call(ticketActionRoute.POST, { method: "POST", params: { ...C, id: ids.t2, action: "reply" }, body: { body: "x" } })).status).toBe(404);
    // feedback only after resolve
    expect((await call(ticketActionRoute.POST, { method: "POST", params: { ...C, id: ids.t1, action: "feedback" }, body: { rating: 5 } })).status).toBe(422);
  });

  it("creates a portal ticket for its own customer; foreign assets are rejected", async () => {
    await signInAs(users.c1);
    const res = await call(ticketsRoute.POST, { method: "POST", params: C, body: { subject: "Need help", priority: "HIGH" } });
    expect(res.status).toBe(201);
    const t = await prisma.ticket.findUniqueOrThrow({ where: { id: res.json.data.id } });
    expect(t).toMatchObject({ customerId: ids.c1, source: "PORTAL", status: "NEW", companyId: a.company.id, createdById: null });
    const foreignAsset = await prisma.asset.create({ data: { organizationId: a.org.id, companyId: a.company.id, tag: "AS-X", name: "X", customerId: ids.c2 } });
    expect((await call(ticketsRoute.POST, { method: "POST", params: C, body: { subject: "x", assetId: foreignAsset.id } })).status).toBe(404);
  });

  it("customer cannot use the dealer portal or dealer endpoints", async () => {
    await signInAs(users.c1);
    expect((await call(quotationsRoute.GET, { params: D })).status).toBe(403);
    expect((await call(catalogRoute.GET, { params: C })).status).toBe(404);
  });
});

describe("dealer portal", () => {
  it("sees only its authorized products and prices, never cost or list price", async () => {
    await signInAs(users.dealer);
    const res = await call(catalogRoute.GET, { params: D });
    expect(res.status).toBe(200);
    expect(res.json.data).toHaveLength(1);
    expect(res.json.data[0]).toMatchObject({ unitPrice: "420", product: { id: ids.p1, sku: "P1" } });
    const text = JSON.stringify(res.json);
    for (const key of ["purchasePrice", "salesPrice", "999"]) expect(text).not.toContain(key);
  });

  it("order request creates a DRAFT quotation at the dealer price; unauthorized products are rejected", async () => {
    await signInAs(users.dealer);
    expect((await call(orderRequestsRoute.POST, { method: "POST", params: D, body: { lines: [{ productId: ids.p2, quantity: 1 }] } })).status).toBe(422);
    const res = await call(orderRequestsRoute.POST, { method: "POST", params: D, body: { lines: [{ productId: ids.p1, quantity: 2 }], remarks: "urgent" } });
    expect(res.status).toBe(201);
    const q = await prisma.quotation.findUniqueOrThrow({ where: { id: res.json.data.id }, include: { lines: true } });
    expect(q.status).toBe("DRAFT");
    expect(q.customerId).toBe(ids.dealer);
    expect(q.notes).toContain("Portal request");
    expect(q.lines[0].unitPrice.toString()).toBe("420");
    // Draft stays out of the quotation list but appears among the dealer's requests
    expect((await call(quotationsRoute.GET, { params: D })).json.data.items).toHaveLength(0);
    expect((await call(orderRequestsRoute.GET, { params: D })).json.data.map((r: { id: string }) => r.id)).toContain(q.id);
  });
});

describe("vendor portal", () => {
  it("sees only its issued purchase orders", async () => {
    await signInAs(users.v1);
    const res = await call(vendorPosRoute.GET);
    expect(res.json.data.items.map((p: { id: string }) => p.id)).toEqual([ids.po1]);
    expect(JSON.stringify(res.json)).not.toContain("INTERNAL-NOTE");
    expect((await call(vendorPoRoute.GET, { params: { id: ids.po2 } })).status).toBe(404);
    expect((await call(vendorPoRoute.GET, { params: { id: ids.poDraft } })).status).toBe(404);
  });

  it("sees receipt quantities but never valuation", async () => {
    await signInAs(users.v1);
    const res = await call(vendorReceiptsRoute.GET);
    expect(res.json.data.items).toHaveLength(1);
    expect(res.json.data.items[0].lines[0].quantity).toBe("4");
    expect(JSON.stringify(res.json)).not.toMatch(/unitCost|77\.77/);
  });

  it("submits an invoice as a DRAFT bill; duplicates conflict; foreign POs are 404", async () => {
    await signInAs(users.v1);
    const body = { purchaseOrderId: ids.po1, vendorInvoiceNumber: "V-001", billDate: "2026-10-01", lines: [{ purchaseOrderLineId: ids.po1Line, quantity: 4 }] };
    const res = await call(vendorBillsRoute.POST, { method: "POST", body });
    expect(res.status).toBe(201);
    const bill = await prisma.vendorBill.findUniqueOrThrow({ where: { id: res.json.data.id } });
    expect(bill).toMatchObject({ status: "DRAFT", vendorId: ids.v1, purchaseOrderId: ids.po1 });
    expect(bill.grandTotal.toString()).toBe("400");
    expect((await call(vendorBillsRoute.POST, { method: "POST", body })).status).toBe(409);
    expect((await call(vendorBillsRoute.POST, { method: "POST", body: { ...body, purchaseOrderId: ids.po2, vendorInvoiceNumber: "V-2" } })).status).toBe(404);
    const list = await call(vendorBillsRoute.GET);
    expect(list.json.data.items.map((b: { id: string }) => b.id)).toEqual([bill.id]);
  });
});

describe("employee portal", () => {
  it("sees own profile without private fields and only approved own payslips", async () => {
    await signInAs(users.e1);
    const profile = await call(profileRoute.GET);
    expect(profile.json.data.id).toBe(ids.e1);
    expect(JSON.stringify(profile.json)).not.toContain("SECRET");
    const slips = await call(payslipsRoute.GET);
    expect(slips.json.data.map((s: { id: string }) => s.id)).toEqual([ids.slip1]);
    expect((await call(payslipRoute.GET, { params: { id: ids.slipDraft } })).status).toBe(404);
    expect((await call(payslipRoute.GET, { params: { id: ids.slip2 } })).status).toBe(404);
  });

  it("checks in and out once a day", async () => {
    await signInAs(users.e1);
    expect((await call(attendanceActionRoute.POST, { method: "POST", params: { action: "check-out" } })).status).toBe(422);
    expect((await call(attendanceActionRoute.POST, { method: "POST", params: { action: "check-in" } })).status).toBe(200);
    expect((await call(attendanceActionRoute.POST, { method: "POST", params: { action: "check-in" } })).status).toBe(422);
    expect((await call(attendanceActionRoute.POST, { method: "POST", params: { action: "check-out" } })).status).toBe(200);
  });

  it("applies for and cancels own leave", async () => {
    await signInAs(users.e1);
    const res = await call(leaveRequestsRoute.POST, { method: "POST", body: { leaveTypeId: ids.leaveType, startDate: "2099-03-02", endDate: "2099-03-03" } });
    expect(res.status).toBe(201);
    expect(res.json.data.days).toBe("2");
    const cancel = await call(leaveCancelRoute.POST, { method: "POST", params: { id: res.json.data.id }, body: {} });
    expect(cancel.json.data.status).toBe("CANCELLED");
    const balance = await prisma.leaveBalance.findFirstOrThrow({ where: { employeeId: ids.e1, leaveTypeId: ids.leaveType } });
    expect(balance.pending.toString()).toBe("0");
  });
});

describe("technician portal", () => {
  it("sees and works only own visits", async () => {
    await signInAs(users.tech);
    const jobs = await call(jobsRoute.GET);
    expect(jobs.json.data.visits.map((v: { id: string }) => v.id)).toEqual([ids.visit1]);
    expect((await call(visitRoute.GET, { params: { id: ids.visit2 } })).status).toBe(404);
    expect((await call(visitActionRoute.POST, { method: "POST", params: { id: ids.visit2, action: "start" } })).status).toBe(404);
    expect((await call(visitActionRoute.POST, { method: "POST", params: { id: ids.visit1, action: "complete" }, body: { notes: "x" } })).status).toBe(422);
    expect((await call(visitActionRoute.POST, { method: "POST", params: { id: ids.visit1, action: "start" } })).status).toBe(200);
    const done = await call(visitActionRoute.POST, { method: "POST", params: { id: ids.visit1, action: "complete" }, body: { notes: "Replaced fan", workDone: "Fan" } });
    expect(done.json.data.status).toBe("COMPLETED");
  });
});

describe("portal access boundaries", () => {
  it("401 signed out, 403 without an account of that kind or when suspended", async () => {
    await signInAs(null);
    expect((await call(quotationsRoute.GET, { params: C })).status).toBe(401);
    await signInAs(users.suspended);
    expect((await call(quotationsRoute.GET, { params: C })).status).toBe(403);
    await signInAs(users.c1);
    expect((await call(vendorPosRoute.GET)).status).toBe(403);
    expect((await call(payslipsRoute.GET)).status).toBe(403);
    expect((await call(jobsRoute.GET)).status).toBe(403);
  });

  it("a portal-only user is rejected by internal /api/v1 routes", async () => {
    for (const u of [users.c1, users.v1, users.e1]) {
      await signInAs(u);
      const res = await call(customersRoute.GET);
      expect(res.status).toBe(403);
      expect((await call(accountsRoute.GET)).status).toBe(403);
    }
  });

  it("cross-tenant: naming another organization grants nothing", async () => {
    await signInAs(users.c1);
    const res = await call(quotationsRoute.GET, { params: C, query: `portalOrg=${b.org.id}` });
    expect(res.status).toBe(403);
  });
});

describe("invitations and account administration", () => {
  const invite = (body: Record<string, unknown>) => call(invitationsRoute.POST, { method: "POST", body });

  it("requires portal.manage", async () => {
    const rep = await a.addMember("sales_executive");
    await signInAs(rep.userId);
    expect((await invite({ email: "x@test.local", kind: "CUSTOMER", customerId: ids.c1 })).status).toBe(403);
    expect((await call(invitationsRoute.GET)).status).toBe(403);
    expect((await call(accountsRoute.GET)).status).toBe(403);
  });

  it("validates the party per kind and tenant", async () => {
    await signInAs(a.ownerId);
    expect((await invite({ email: "x@test.local", kind: "DEALER", customerId: ids.c1 })).status).toBe(422); // not a dealer
    expect((await invite({ email: "x@test.local", kind: "CUSTOMER", customerId: ids.bCust })).status).toBe(404); // other tenant
    expect((await invite({ email: "x@test.local", kind: "VENDOR" })).status).toBe(422);
    expect((await invite({ email: "nobody@test.local", kind: "TECHNICIAN" })).status).toBe(422); // not a member
  });

  it("stores only the token hash; accept checks email, is single use and idempotent", async () => {
    const invitee = await createUser("invitee");
    const email = (await prisma.user.findUniqueOrThrow({ where: { id: invitee } })).email;
    await signInAs(a.ownerId);
    const res = await invite({ email: email.toUpperCase(), kind: "CUSTOMER", customerId: ids.c1 });
    expect(res.status).toBe(201);
    const token = new URL(res.json.data.acceptUrl).searchParams.get("token")!;
    const row = await prisma.portalInvitation.findUniqueOrThrow({ where: { id: res.json.data.invitation.id } });
    expect(row.tokenHash).toBe(createHash("sha256").update(token).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(token);

    const stranger = await createUser("stranger");
    await signInAs(stranger);
    expect((await call(acceptRoute.POST, { method: "POST", body: { token } })).json.code).toBe("EMAIL_MISMATCH");

    await signInAs(invitee);
    const ok = await call(acceptRoute.POST, { method: "POST", body: { token } });
    expect(ok.status).toBe(200);
    expect(ok.json.data.account).toMatchObject({ kind: "CUSTOMER", status: "ACTIVE" });
    const again = await call(acceptRoute.POST, { method: "POST", body: { token } });
    expect(again.json.data).toMatchObject({ alreadyAccepted: true, account: { id: ok.json.data.account.id } });
    expect((await call(quotationsRoute.GET, { params: C })).status).toBe(200);

    // Used by someone else (simulated) → rejected
    await prisma.portalInvitation.update({ where: { id: row.id }, data: { acceptedUserId: stranger } });
    expect((await call(acceptRoute.POST, { method: "POST", body: { token } })).json.code).toBe("INVITATION_USED");
  });

  it("rejects revoked, expired and unknown tokens", async () => {
    const invitee = await createUser("invitee2");
    const email = (await prisma.user.findUniqueOrThrow({ where: { id: invitee } })).email;
    await signInAs(a.ownerId);
    const res = await invite({ email, kind: "VENDOR", vendorId: ids.v2 });
    const token = new URL(res.json.data.acceptUrl).searchParams.get("token")!;
    expect((await call(revokeRoute.POST, { method: "POST", params: { id: res.json.data.invitation.id } })).json.data.state).toBe("REVOKED");
    await signInAs(invitee);
    expect((await call(acceptRoute.POST, { method: "POST", body: { token } })).json.code).toBe("INVITATION_REVOKED");

    await signInAs(a.ownerId);
    const res2 = await invite({ email, kind: "VENDOR", vendorId: ids.v2 });
    const token2 = new URL(res2.json.data.acceptUrl).searchParams.get("token")!;
    await prisma.portalInvitation.update({ where: { id: res2.json.data.invitation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await signInAs(invitee);
    expect((await call(acceptRoute.POST, { method: "POST", body: { token: token2 } })).json.code).toBe("INVITATION_EXPIRED");
    expect((await call(acceptRoute.POST, { method: "POST", body: { token: "x".repeat(40) } })).status).toBe(404);
    await signInAs(null);
    expect((await call(acceptRoute.POST, { method: "POST", body: { token: token2 } })).status).toBe(401);
  });

  it("suspends and reactivates accounts (tenant-scoped)", async () => {
    await signInAs(a.ownerId);
    const acc = await prisma.portalAccount.findFirstOrThrow({ where: { userId: users.v1 } });
    expect((await call(accountActionRoute.POST, { method: "POST", params: { id: acc.id, action: "suspend" } })).json.data.status).toBe("SUSPENDED");
    await signInAs(users.v1);
    expect((await call(vendorPosRoute.GET)).status).toBe(403);
    await signInAs(b.ownerId);
    expect((await call(accountActionRoute.POST, { method: "POST", params: { id: acc.id, action: "reactivate" } })).status).toBe(404);
    await signInAs(a.ownerId);
    expect((await call(accountActionRoute.POST, { method: "POST", params: { id: acc.id, action: "reactivate" } })).json.data.status).toBe("ACTIVE");
  });
});

describe("every portal read query is valid", () => {
  // Shared `select` constants escape Prisma's excess-property checks, so run each read once.
  it("runs all read services for each kind", async () => {
    const { getPortalContext } = await import("@/features/portal/context");
    const cust = await import("@/features/portal/customer");
    const dealer = await import("@/features/portal/dealer");
    const vendor = await import("@/features/portal/vendor");
    const emp = await import("@/features/portal/employee");
    const tech = await import("@/features/portal/technician");
    const admin = await import("@/features/portal/admin");

    await signInAs(users.c1);
    const c = await getPortalContext("CUSTOMER");
    const order = await prisma.salesOrder.create({ data: { organizationId: a.org.id, companyId: a.company.id, branchId: a.branch.id, number: "SO-1", customerId: ids.c1, status: "CONFIRMED", createdById: a.ownerId } });
    await Promise.all([
      cust.listOrders(c), cust.getOrder(c, order.id), cust.listPayments(c), cust.listTickets(c), cust.listAssets(c), cust.listContracts(c),
      cust.listServiceHistory(c), cust.ticketCompanies(c), cust.ticketCategories(c),
    ]);
    await signInAs(users.dealer);
    await dealer.listOrderRequests(await getPortalContext("DEALER"));
    await signInAs(users.v1);
    const v = await getPortalContext("VENDOR");
    await Promise.all([vendor.getPurchaseOrder(v, ids.po1), vendor.listPayments(v), vendor.listGoodsReceipts(v), vendor.listBills(v)]);
    await signInAs(users.e1);
    const e = await getPortalContext("EMPLOYEE");
    await Promise.all([emp.listAttendance(e), emp.listLeaveBalances(e), emp.listLeaveTypes(e), emp.listLeaveRequests(e), emp.getPayslip(e, ids.slip1), emp.listMyTasks(e)]);
    await signInAs(users.tech);
    const t = await getPortalContext("TECHNICIAN");
    const job = await prisma.installationJob.create({
      data: { organizationId: a.org.id, companyId: a.company.id, number: "INS-1", customerId: ids.c1, technicianId: users.tech, status: "SCHEDULED", createdById: a.ownerId, checklist: { create: [{ label: "Mount", required: true }] } },
      include: { checklist: true },
    });
    await tech.listJobs(t, { open: "false" });
    await tech.getInstallation(t, job.id);
    await expect(tech.transitionInstallation(t, job.id, "complete", {})).rejects.toMatchObject({ status: 422 });
    await tech.transitionInstallation(t, job.id, "start", {});
    await expect(tech.transitionInstallation(t, job.id, "complete", {})).rejects.toMatchObject({ code: "CHECKLIST_INCOMPLETE" });
    await tech.updateChecklistItem(t, job.id, job.checklist[0].id, { done: true });
    expect((await tech.transitionInstallation(t, job.id, "complete", {})).status).toBe("COMPLETED");

    const ctx = await a.ctx(a.ownerId);
    await Promise.all([admin.listPortalInvitations(ctx), admin.listPortalAccounts(ctx), admin.portalInviteOptions(ctx)]);
  });
});
