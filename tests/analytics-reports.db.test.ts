import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { prisma } from "@/lib/db/prisma";
import type { AccessContext } from "@/lib/access";
import { processQueue } from "@/lib/queue";
import { createCompany } from "@/features/companies/service";
import { createProduct } from "@/features/catalog/service";
import { createCustomer } from "@/features/customers/service";
import { createVendor } from "@/features/purchasing/vendors";
import { createPurchaseOrder, transitionPurchaseOrder } from "@/features/purchasing/purchase-orders";
import { createVendorBill, postVendorBill } from "@/features/purchasing/bills";
import { receivePurchaseOrder } from "@/features/inventory/entries";
import { createQuotation, transitionQuotation } from "@/features/sales/quotations";
import { createInvoice, createReceipt, postInvoice } from "@/features/finance/receivables";
import { setupFinance } from "@/features/finance/setup";
import { payablesAging, receivablesAging } from "@/features/finance/reports";
import { serviceReport } from "@/features/service/ticket-reports";
import { getDashboard, listMetricDefinitions, METRICS } from "@/features/analytics/metrics";
import { getMis } from "@/features/analytics/mis";
import { buildReportQuery, executeReport, parseDefinition, runReport } from "@/features/reports/builder";
import { createSavedReport, listSavedReports, runSavedReport, updateSavedReport } from "@/features/reports/saved";
import { csvCell, generateExport, getExportDownload, purgeExpiredExports, requestExport } from "@/features/reports/exports";
import { removeObject } from "@/lib/storage/objects";
import * as runRoute from "@/app/api/v1/reports/run/route";
import * as analyticsRoute from "@/app/api/v1/analytics/route";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";
import { call, signInAs } from "./helpers/http";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));
const uploads: { path: string; body: string }[] = [];
vi.mock("@/lib/storage/objects", () => ({
  putObject: vi.fn(async (_bucket: string, path: string, body: Buffer) => {
    uploads.push({ path, body: body.toString("utf8") });
  }),
  signedObjectUrl: vi.fn(async (_bucket: string, path: string, sec: number) => ({ signedUrl: `https://signed.test/${path}`, expiresAt: new Date(Date.now() + sec * 1000).toISOString() })),
  removeObject: vi.fn(),
}));

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const today = ymd(new Date());
const yesterday = ymd(new Date(Date.now() - 86_400_000));
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const fyStart = (() => {
  const d = new Date();
  return `${d.getUTCMonth() + 1 >= 4 ? d.getUTCFullYear() : d.getUTCFullYear() - 1}-04-01`;
})();

let a: OrgFixture;
let b: OrgFixture;
let owner: AccessContext;
let company2: { id: string };
let branch2: { id: string };
let customerId: string;
let productId: string;
let vendorId: string;
let gst18: string;

const metric = (dash: Awaited<ReturnType<typeof getDashboard>>, key: string) =>
  dash.sections.flatMap((s) => s.metrics).find((m) => m.key === key)?.value;

beforeAll(async () => {
  a = await createOrg("Analytics Co");
  b = await createOrg("Analytics Other");
  owner = await a.ctx(a.ownerId);
  await prisma.company.update({ where: { id: a.company.id }, data: { stateCode: "29" } });
  company2 = await createCompany(owner, { code: "AN2", name: "Second Co", stateCode: "29" });
  branch2 = await prisma.branch.findFirstOrThrow({ where: { companyId: company2.id } });
  owner = await a.ctx(a.ownerId); // pick up the new company
  gst18 = (await prisma.taxRate.findFirstOrThrow({ where: { organizationId: a.org.id, name: "GST 18%" } })).id;
  const nos = (await prisma.uom.findFirstOrThrow({ where: { organizationId: a.org.id, code: "NOS" } })).id;
  customerId = (await createCustomer(owner, { name: "Acme Buyer", stateCode: "29", ignoreDuplicates: true })).id;
  productId = (await createProduct(owner, { sku: "AN-1", name: "Gadget", uomId: nos, taxRateId: gst18, salesPrice: "1000", purchasePrice: "400" })).id;
  vendorId = (await createVendor(owner, { name: "Parts Supplier", stateCode: "29" })).id;
  await setupFinance(owner, a.company.id, { accountingStartDate: fyStart });

  // Other tenant: data that must never be counted for org A.
  const bOwner = await b.ctx(b.ownerId);
  const bCustomer = (await createCustomer(bOwner, { name: "Foreign Buyer", stateCode: "29", ignoreDuplicates: true })).id;
  const bInv = await createInvoice(bOwner, { companyId: b.company.id, branchId: b.branch.id, customerId: bCustomer, lines: [{ description: "x", quantity: "1", unitPrice: "99999" }] });
  await postInvoice(bOwner, bInv.id);
});
afterAll(cleanupFixtures);

describe("dashboard metrics equal the underlying records", () => {
  beforeAll(async () => {
    // Quotations: accepted, rejected, draft.
    const quote = async () => createQuotation(owner, { companyId: a.company.id, branchId: a.branch.id, customerId, lines: [{ productId, quantity: "2" }] });
    const accepted = await quote();
    for (const step of ["submit", "send", "accept"]) await transitionQuotation(owner, accepted.id, step as never, {});
    const rejected = await quote();
    for (const step of ["submit", "send"]) await transitionQuotation(owner, rejected.id, step as never, {});
    await transitionQuotation(owner, rejected.id, "reject", { reason: "Too expensive" });
    await quote(); // draft

    // Invoices: posted today, posted overdue (dated 40 days ago), draft, and one in company 2.
    const inv = (extra: Record<string, unknown> = {}, cid = a.company.id, bid = a.branch.id, price = "1000") =>
      createInvoice(owner, { companyId: cid, branchId: bid, customerId, lines: [{ description: "Service", quantity: "1", unitPrice: price, taxRateId: gst18 }], ...extra });
    const posted = await postInvoice(owner, (await inv()).id);
    await postInvoice(owner, (await inv({ invoiceDate: ymd(daysAgo(40)), dueDate: ymd(daysAgo(35)) }, a.company.id, a.branch.id, "500")).id);
    await inv({}, a.company.id, a.branch.id, "777"); // draft
    await postInvoice(owner, (await inv({}, company2.id, branch2.id, "300")).id);
    const bank = await prisma.bankAccount.findFirstOrThrow({ where: { companyId: a.company.id, kind: "BANK" } });
    await createReceipt(owner, { companyId: a.company.id, customerId, bankAccountId: bank.id, amount: "400", allocations: [{ invoiceId: posted.id, amount: "400" }] });

    // Purchase order for 10 @ 400, 4 received; bill for the 4.
    const warehouse = await prisma.warehouse.findFirstOrThrow({ where: { companyId: a.company.id } });
    const po = await createPurchaseOrder(owner, { companyId: a.company.id, branchId: a.branch.id, warehouseId: warehouse.id, vendorId, lines: [{ productId, quantity: "10", unitPrice: "400" }] });
    await transitionPurchaseOrder(owner, po.id, "submit", {});
    const line = await prisma.purchaseOrderLine.findFirstOrThrow({ where: { purchaseOrderId: po.id } });
    await receivePurchaseOrder(owner, po.id, { lines: [{ purchaseOrderLineId: line.id, quantity: "4" }] });
    const bill = await createVendorBill(owner, { companyId: a.company.id, branchId: a.branch.id, vendorId, purchaseOrderId: po.id, vendorInvoiceNumber: "PS/1", billDate: today, lines: [{ purchaseOrderLineId: line.id, quantity: "4" }] });
    await postVendorBill(owner, bill.id);

    // Tickets: resolved late, resolved on time, resolved last month (out of range), open urgent.
    const ticket = (n: string, data: Record<string, unknown>) =>
      prisma.ticket.create({ data: { organizationId: a.org.id, companyId: a.company.id, number: n, subject: n, ...data } });
    await ticket("T-1", { status: "RESOLVED", createdAt: daysAgo(0.5), resolvedAt: new Date(), resolutionDueAt: daysAgo(0.25) });
    await ticket("T-2", { status: "RESOLVED", createdAt: daysAgo(0.25), resolvedAt: new Date(), resolutionDueAt: new Date(Date.now() + 86_400_000) });
    await ticket("T-3", { status: "CLOSED", createdAt: daysAgo(60), resolvedAt: daysAgo(45), resolutionDueAt: daysAgo(50) });
    await ticket("T-4", { status: "OPEN", priority: "URGENT" });

    // HR: employee, approved leave covering today, a rejected one, attendance.
    const emp = await prisma.employee.create({ data: { organizationId: a.org.id, companyId: a.company.id, branchId: a.branch.id, employeeNumber: "E1", firstName: "Asha", fullName: "Asha K", joiningDate: new Date("2024-01-01"), status: "ACTIVE" } });
    const type = await prisma.leaveType.create({ data: { organizationId: a.org.id, companyId: a.company.id, code: "CL", name: "Casual", annualQuota: "12" } });
    const leave = (status: "APPROVED" | "REJECTED", days: string) =>
      prisma.leaveRequest.create({ data: { organizationId: a.org.id, employeeId: emp.id, leaveTypeId: type.id, startDate: new Date(`${today}T00:00:00Z`), endDate: new Date(`${today}T00:00:00Z`), days, status, createdById: a.ownerId } });
    await leave("APPROVED", "1");
    await leave("REJECTED", "3");
    await prisma.attendanceRecord.createMany({ data: [
      { organizationId: a.org.id, employeeId: emp.id, date: new Date(`${today}T00:00:00Z`), status: "ON_LEAVE" },
      { organizationId: a.org.id, employeeId: emp.id, date: new Date(`${yesterday}T00:00:00Z`), status: "PRESENT" },
    ] });

    // Project: 3 tasks (1 done, 1 cancelled), 5 h logged today.
    const project = await prisma.project.create({ data: { organizationId: a.org.id, companyId: a.company.id, code: "P1", name: "Rollout", managerId: a.ownerId, status: "ACTIVE", budget: "10000", hourlyRate: "500" } });
    await prisma.projectTask.createMany({ data: ["DONE", "TODO", "CANCELLED"].map((status, i) => ({ organizationId: a.org.id, projectId: project.id, title: `t${i}`, status, createdById: a.ownerId })) });
    await prisma.timeEntry.create({ data: { organizationId: a.org.id, projectId: project.id, userId: a.ownerId, date: new Date(`${today}T00:00:00Z`), hours: "5", billable: true } });

    // Leads + follow-ups.
    const lead = await prisma.lead.create({ data: { organizationId: a.org.id, fullName: "Lead One", status: "NEW" } });
    await prisma.leadFollowUp.createMany({ data: [
      { organizationId: a.org.id, leadId: lead.id, title: "call", dueAt: daysAgo(3), status: "PENDING" },
      { organizationId: a.org.id, leadId: lead.id, title: "done", dueAt: daysAgo(1), status: "COMPLETED" },
    ] });
  });

  it("sales: quotation conversion, orders and posted invoices only", async () => {
    const d = await getDashboard(owner, { from: today, to: today, companyId: a.company.id });
    expect(metric(d, "sales.quotations_created")).toBe(3);
    expect(metric(d, "sales.quotations_accepted")).toBe(1);
    expect(metric(d, "sales.quotation_conversion_rate")).toBe(50);
    const accepted = await prisma.quotation.findFirstOrThrow({ where: { companyId: a.company.id, status: "ACCEPTED" } });
    expect(metric(d, "sales.quotations_accepted_value")).toEqual({ INR: accepted.grandTotal.toFixed(2) });
    // Posted today in company 1: 1000 taxable (the 40-day-old one and the draft are outside / excluded).
    expect(metric(d, "sales.invoiced_value")).toEqual({ INR: "1000.00" });
    const wide = await getDashboard(owner, { from: ymd(daysAgo(60)), to: today, companyId: a.company.id });
    const posted = await prisma.salesInvoice.aggregate({ where: { companyId: a.company.id, status: "POSTED" }, _sum: { taxableTotal: true } });
    expect(metric(wide, "sales.invoiced_value")).toEqual({ INR: posted._sum.taxableTotal!.toFixed(2) });
    // All companies: company 2's 300 is added (same currency).
    const all = await getDashboard(owner, { from: today, to: today });
    expect(metric(all, "sales.invoiced_value")).toEqual({ INR: "1300.00" });
  });

  it("date range boundaries are inclusive and exclusive of neighbours", async () => {
    const inv = await prisma.salesInvoice.findFirstOrThrow({ where: { companyId: a.company.id, status: "POSTED", taxableTotal: 500 } });
    const day = ymd(inv.invoiceDate);
    const prev = ymd(new Date(inv.invoiceDate.getTime() - 86_400_000));
    const next = ymd(new Date(inv.invoiceDate.getTime() + 86_400_000));
    expect(metric(await getDashboard(owner, { from: day, to: day, companyId: a.company.id }), "sales.invoiced_value")).toEqual({ INR: "500.00" });
    expect(metric(await getDashboard(owner, { from: prev, to: prev, companyId: a.company.id }), "sales.invoiced_value")).toEqual({ INR: "0.00" });
    expect(metric(await getDashboard(owner, { from: next, to: next, companyId: a.company.id }), "sales.invoiced_value")).toEqual({ INR: "0.00" });
    await expect(getDashboard(owner, { from: today, to: yesterday })).rejects.toBeInstanceOf(ZodError);
  });

  it("receivables and payables equal the finance aging report", async () => {
    const d = await getDashboard(owner, { companyId: a.company.id });
    const ar = await receivablesAging(owner, a.company.id, {});
    const ap = await payablesAging(owner, a.company.id, {});
    expect(metric(d, "receivables.outstanding")).toEqual({ INR: ar.totals.total });
    expect(metric(d, "payables.outstanding")).toEqual({ INR: ap.totals.total });
    const buckets = metric(d, "receivables.aging") as Record<string, Record<string, string>>;
    for (const k of ar.buckets) expect(buckets[k].INR).toBe(ar.totals[k as keyof typeof ar.totals]);
    // 1180 − 400 paid + 590 overdue (500 + 18% GST)
    expect(ar.totals.total).toBe("1370.00");
    expect(metric(d, "receivables.overdue")).toEqual({ INR: "590.00" });
  });

  it("purchasing: open commitment and receipts", async () => {
    const d = await getDashboard(owner, { from: today, to: today, companyId: a.company.id });
    expect(metric(d, "purchasing.open_commitment")).toEqual({ INR: "2400.00" }); // 6 open × 400
    expect(metric(d, "purchasing.receipts_value")).toEqual({ INR: "1600.00" }); // 4 × 400
    expect(metric(d, "purchasing.open_orders")).toBe(1);
  });

  it("inventory, service, HR, projects and leads", async () => {
    const d = await getDashboard(owner, { from: today, to: today, companyId: a.company.id });
    const valuation = await prisma.stockValuation.aggregate({ where: { companyId: a.company.id }, _sum: { value: true } });
    expect(metric(d, "inventory.stock_value")).toEqual({ INR: valuation._sum.value!.toFixed(2) });
    expect(metric(d, "inventory.moves_by_type")).toEqual([{ type: "GOODS_RECEIPT", inQty: "4", outQty: "0", moves: 1 }]);

    expect(metric(d, "service.resolved")).toBe(2);
    expect(metric(d, "service.sla_breach_rate")).toBe(50);
    expect(metric(d, "service.open_by_priority")).toEqual({ URGENT: 1 });
    const sr = await serviceReport(owner, { companyId: a.company.id, from: `${today}T00:00:00Z`, to: new Date().toISOString() });
    expect(metric(d, "service.sla_breach_rate")).toBe(sr.resolved.slaBreachRate);

    expect(metric(d, "hr.leave_days_by_type")).toEqual([expect.objectContaining({ code: "CL", days: "1", requests: 1 })]);
    expect(metric(d, "hr.on_leave_today")).toBe(1);
    expect(metric(d, "hr.attendance_by_status")).toEqual({ ON_LEAVE: 1 });

    expect(metric(d, "projects.overall_progress")).toBe(50);
    expect(metric(d, "projects.hours_logged")).toEqual({ total: "5", billable: "5", nonBillable: "0" });
    expect(metric(d, "projects.active")).toEqual([expect.objectContaining({ code: "P1", progress: 50, actualCost: "2500.00", budgetUsedPercent: 25 })]);

    expect(metric(d, "leads.new")).toBe(1);
    expect(metric(d, "leads.followups_overdue")).toBe(1);
    expect(metric(d, "leads.followups_completed")).toBe(1);
  });

  it("company scope: a member scoped to company 2 never sees company 1", async () => {
    const m = await a.addMember("viewer", [{ companyId: company2.id }]);
    const ctx = await a.ctx(m.userId);
    const d = await getDashboard(ctx, { from: today, to: today });
    expect(metric(d, "sales.invoiced_value")).toEqual({ INR: "300.00" });
    expect(metric(d, "purchasing.open_commitment")).toEqual({ INR: "0.00" });
    await expect(getDashboard(ctx, { companyId: a.company.id })).rejects.toMatchObject({ status: 404 });
  });

  it("sections without permission are omitted; no dashboard.view is 403", async () => {
    const hr = await a.ctx((await a.addMember("hr_manager")).userId);
    const keys = (await getDashboard(hr, {})).sections.map((s) => s.key);
    expect(keys).toContain("hr");
    expect(keys).not.toContain("sales");
    expect(keys).not.toContain("receivables");
    const tech = await a.ctx((await a.addMember("technician")).userId);
    await expect(getDashboard(tech, {})).rejects.toMatchObject({ status: 403 });
    expect(listMetricDefinitions(owner).length).toBe(METRICS.length);
  });

  it("tenant isolation over HTTP", async () => {
    await signInAs(a.ownerId);
    const res = await call(analyticsRoute.GET, { query: `from=${today}&to=${today}` });
    expect(res.status).toBe(200);
    const value = res.json.data.sections.flatMap((s: { metrics: { key: string; value: unknown }[] }) => s.metrics).find((m: { key: string }) => m.key === "sales.invoiced_value").value;
    expect(value).toEqual({ INR: "1300.00" }); // org B's 99999 never counted
  });

  it("MIS: documented lines, ledger figures when finance is on, omitted otherwise", async () => {
    const mis = await getMis(owner, { companyId: a.company.id, from: today, to: today });
    const line = (k: string) => mis.lines.find((l) => l.key === k);
    expect(line("revenue.invoiced")).toMatchObject({ value: "1000.00", source: expect.stringContaining("POSTED") });
    expect(line("ledger.revenue")?.value).toBe("1000.00");
    expect(mis.lines.every((l) => l.source.length > 0)).toBe(true);
    expect(mis.topCustomers.rows[0]).toMatchObject({ name: "Acme Buyer", amount: "1000.00" });
    expect(mis.vendorSpend.rows[0]).toMatchObject({ name: "Parts Supplier", amount: "1600.00" });
    const bankLine = mis.lines.find((l) => l.label.startsWith("Bank:"));
    expect(bankLine?.value).toBe("400.00");
    const off = await getMis(owner, { companyId: company2.id, from: today, to: today });
    expect(off.omitted.map((o) => o.key)).toEqual(["cogs", "gross_margin", "cash_bank"]);
    expect(off.lines.find((l) => l.key === "revenue.invoiced")?.value).toBe("300.00");
  });
});

describe("report builder", () => {
  const run = (def: Record<string, unknown>) => runReport(owner, def);

  it("rejects unknown entities, fields, operators and aggregates (422)", async () => {
    await expect(run({ entity: "users" })).rejects.toMatchObject({ status: 422 });
    await expect(run({ entity: "customers", columns: ["password"] })).rejects.toMatchObject({ status: 422 });
    await expect(run({ entity: "customers", filters: [{ field: "name", op: "regex", value: "x" }] })).rejects.toMatchObject({ status: 422 });
    await expect(run({ entity: "customers", filters: [{ field: "name", op: "gt", value: "x" }] })).rejects.toMatchObject({ status: 422 });
    await expect(run({ entity: "customers", aggregates: [{ fn: "sum", field: "name" }] })).rejects.toMatchObject({ status: 422 });
    await expect(run({ entity: "customers", aggregates: [{ fn: "median", field: "creditLimit" }] })).rejects.toBeInstanceOf(ZodError);
    await expect(run({ entity: "customers", sql: "SELECT 1" })).rejects.toBeInstanceOf(ZodError);
    await expect(run({ entity: "customers", groupBy: ["name", "type", "status", "code"] })).rejects.toBeInstanceOf(ZodError);
    await signInAs(a.ownerId);
    const res = await call(runRoute.POST, { method: "POST", body: { entity: "customers", aggregates: [{ fn: "drop", field: "name" }] } });
    expect(res.status).toBe(422);
    expect(res.json.code).toBe("VALIDATION_ERROR");
  });

  it("treats injection-looking values as data and never accepts identifiers from users", async () => {
    const r = await run({ entity: "customers", filters: [{ field: "name", op: "eq", value: "x' OR 1=1 --" }] });
    expect(r.rowCount).toBe(0);
    const like = await run({ entity: "customers", filters: [{ field: "name", op: "contains", value: "%" }] });
    expect(like.rowCount).toBe(0);
    await expect(run({ entity: "customers", columns: [`name" FROM customers; --`] })).rejects.toMatchObject({ status: 422 });
    await expect(run({ entity: "customers", sort: [{ field: "1; DROP TABLE customers", dir: "asc" }] })).rejects.toMatchObject({ status: 422 });
    const { sql } = buildReportQuery(owner, parseDefinition({ entity: "customers", filters: [{ field: "name", op: "eq", value: "Robert'); DROP TABLE x;--" }] }));
    expect(sql.sql).not.toContain("DROP");
    expect(sql.values).toContain("Robert'); DROP TABLE x;--");
  });

  it("keeps tenants apart and applies company scope", async () => {
    const names = (await run({ entity: "customers", columns: ["name"], limit: 1000 })).rows.map((r) => r.name);
    expect(names).toContain("Acme Buyer");
    expect(names).not.toContain("Foreign Buyer");
    const scoped = await a.ctx((await a.addMember("admin", [{ companyId: company2.id }])).userId);
    const invoices = await executeReport(scoped, parseDefinition({ entity: "sales_invoices", columns: ["company", "taxableTotal"], filters: [{ field: "status", op: "eq", value: "POSTED" }] }));
    expect(invoices.rows).toEqual([{ company: "AN2", taxableTotal: "300.00" }]);
  });

  it("groups and aggregates in the database", async () => {
    const r = await run({ entity: "sales_invoices", groupBy: ["status"], aggregates: [{ fn: "count" }, { fn: "sum", field: "taxableTotal" }], sort: [{ field: "status", dir: "asc" }] });
    const posted = await prisma.salesInvoice.aggregate({ where: { organizationId: a.org.id, status: "POSTED" }, _sum: { taxableTotal: true }, _count: true });
    expect(r.rows.find((x) => x.status === "POSTED")).toEqual({ status: "POSTED", count: posted._count, sum_taxableTotal: posted._sum.taxableTotal!.toFixed(2) });
    expect(r.rows.find((x) => x.status === "DRAFT")).toMatchObject({ count: 1 });
  });

  it("enforces row limits and the entity permission", async () => {
    await expect(run({ entity: "quotations", limit: 1001 })).rejects.toBeInstanceOf(ZodError);
    const r = await run({ entity: "quotations", limit: 2 });
    expect(r).toMatchObject({ rowCount: 2, truncated: true, limit: 2 });
    const hr = await a.ctx((await a.addMember("hr_manager")).userId);
    await expect(runReport(hr, { entity: "employees" })).rejects.toMatchObject({ status: 403 }); // no report.build
    await expect(executeReport(hr, parseDefinition({ entity: "sales_invoices" }))).rejects.toMatchObject({ status: 403 });
  });

  it("maps a statement timeout to QUERY_TIMEOUT", async () => {
    await expect(
      executeReport(owner, parseDefinition({ entity: "customers" }), { timeoutMs: 50, beforeQuery: (tx) => tx.$queryRaw`SELECT pg_sleep(0.5)` }),
    ).rejects.toMatchObject({ code: "QUERY_TIMEOUT", status: 422 });
  });

  it("saves, shares and re-runs definitions", async () => {
    const saved = await createSavedReport(owner, { name: "Posted invoices", definition: { entity: "sales_invoices", columns: ["number", "grandTotal"], filters: [{ field: "status", op: "eq", value: "POSTED" }] } });
    const viewer = await a.ctx((await a.addMember("accountant")).userId);
    expect((await listSavedReports(viewer, {})).items.map((r) => r.id)).not.toContain(saved.id);
    await updateSavedReport(owner, saved.id, { isShared: true });
    expect((await listSavedReports(viewer, {})).items.map((r) => r.id)).toContain(saved.id);
    expect((await runSavedReport(viewer, saved.id)).rowCount).toBeGreaterThan(0);
    await expect(updateSavedReport(viewer, saved.id, { name: "mine" })).rejects.toMatchObject({ status: 403 });
    const hr = await a.ctx((await a.addMember("hr_manager")).userId); // no invoice.view
    await expect(runSavedReport(hr, saved.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("exports", () => {
  it("neutralizes spreadsheet formulas and quotes cells", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")", true)).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell("+1", true)).toBe("'+1");
    expect(csvCell("-5.00", false)).toBe("-5.00");
    expect(csvCell("a,b", true)).toBe(`"a,b"`);
    expect(csvCell(null, true)).toBe("");
  });

  it("generates once, re-checks permissions and serves only the requester", async () => {
    await createCustomer(owner, { name: "=cmd|' /C calc'!A0", stateCode: "29", ignoreDuplicates: true });
    const admin = await a.addMember("admin");
    const adminCtx = await a.ctx(admin.userId);
    const exp = await requestExport(adminCtx, { definition: { entity: "customers", columns: ["name", "creditLimit"] } });
    expect(exp.status).toBe("PENDING");
    expect(await prisma.backgroundJob.count({ where: { key: `export.generate:${exp.id}` } })).toBe(1);

    await processQueue({ types: ["export.generate"] });
    const done = await prisma.dataExport.findUniqueOrThrow({ where: { id: exp.id } });
    expect(done).toMatchObject({ status: "COMPLETED", storagePath: `exports/${a.org.id}/${exp.id}.csv` });
    expect(done.expiresAt!.getTime() - done.completedAt!.getTime()).toBe(7 * 86_400_000);
    const file = uploads.find((u) => u.path === done.storagePath)!;
    expect(file.body).toContain(`\r\n'=cmd|' /C calc'!A0,`);
    expect(file.body).not.toContain("Foreign Buyer");
    expect(done.rowCount).toBe(file.body.trim().split("\r\n").length - 1);

    // Idempotent: a second run is a no-op.
    const before = uploads.length;
    expect(await generateExport({ exportId: exp.id })).toMatchObject({ skipped: "COMPLETED" });
    expect(uploads.length).toBe(before);

    // Only the requester gets a signed URL.
    expect((await getExportDownload(adminCtx, exp.id)).url).toContain(done.storagePath);
    await expect(getExportDownload(owner, exp.id)).rejects.toMatchObject({ status: 404 });
    const outsider = await b.ctx(b.ownerId);
    await expect(getExportDownload(outsider, exp.id)).rejects.toMatchObject({ status: 404 });

    // Permission revoked between request and generation → FAILED, nothing uploaded.
    const second = await requestExport(adminCtx, { definition: { entity: "customers" } });
    await prisma.organizationMember.update({ where: { id: admin.memberId }, data: { roleId: a.roles.get("viewer")! } });
    await processQueue({ types: ["export.generate"] });
    const failed = await prisma.dataExport.findUniqueOrThrow({ where: { id: second.id } });
    expect(failed).toMatchObject({ status: "FAILED", storagePath: null });
    expect(failed.error).toMatch(/data\.export/);
    expect(uploads.some((u) => u.path.includes(second.id))).toBe(false);
    await expect(requestExport(await a.ctx(admin.userId), { definition: { entity: "customers" } })).rejects.toMatchObject({ status: 403 });
  });

  it("requires the entity permission to request", async () => {
    const hr = await a.ctx((await a.addMember("hr_manager")).userId);
    await expect(requestExport(hr, { definition: { entity: "employees" } })).rejects.toMatchObject({ status: 403 }); // no data.export
    await expect(requestExport(owner, { definition: { entity: "nope" } })).rejects.toMatchObject({ status: 422 });
  });
});

describe("export expiry", () => {
  it("removes expired files once and marks the export EXPIRED", async () => {
    const row = await prisma.dataExport.create({
      data: { organizationId: a.org.id, entity: "customers", status: "COMPLETED", storagePath: `exports/${a.org.id}/old.csv`, requestedById: a.ownerId, expiresAt: new Date(Date.now() - 1000) },
    });
    const [r1, r2] = await Promise.all([purgeExpiredExports(), purgeExpiredExports()]);
    expect(r1.purged + r2.purged).toBeGreaterThanOrEqual(1);
    expect(vi.mocked(removeObject).mock.calls.filter((c) => c[1] === row.storagePath)).toHaveLength(1);
    expect((await prisma.dataExport.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("EXPIRED");
  });
});
