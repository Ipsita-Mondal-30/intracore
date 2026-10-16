import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { AccessContext } from "@/lib/access";
import { Decimal } from "@/lib/money";
import { setupFinance } from "@/features/finance/setup";
import {
  computePayslip,
  createPayrollRun,
  createSalaryComponent,
  createSalaryStructure,
  getPayrollRun,
  getPayslip,
  listPayslips,
  transitionPayrollRun,
  updateSalaryStructure,
  type RuleLine,
} from "@/features/hr/payroll";
import {
  createApplication,
  createCandidate,
  createJobOpening,
  getJobOpening,
  interviewAction,
  moveApplication,
  scheduleInterview,
  transitionJobOpening,
} from "@/features/hr/recruitment";
import { createGoal, createReviewCycle, listPerformanceReviews, submitPerformanceReview, transitionReviewCycle, updateGoal } from "@/features/hr/performance";
import * as runsRoute from "@/app/api/v1/payroll-runs/route";
import * as stageRoute from "@/app/api/v1/applications/[id]/stage/route";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";
import { call, signInAs } from "./helpers/http";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));

let a: OrgFixture;
let b: OrgFixture;
let owner: AccessContext;
let runner: AccessContext;
let approver: AccessContext;
let viewer: AccessContext;
let outsider: AccessContext; // sales role: no HR permissions
let comp: Record<string, string>;
let seq = 0;

async function employee(o: OrgFixture, extra: Partial<Prisma.EmployeeUncheckedCreateInput> = {}) {
  seq += 1;
  return prisma.employee.create({
    data: {
      organizationId: o.org.id,
      companyId: o.company.id,
      employeeNumber: `E${String(seq).padStart(4, "0")}`,
      firstName: `Emp${seq}`,
      fullName: `Emp ${seq}`,
      joiningDate: new Date("2020-01-01"),
      status: "ACTIVE",
      ...extra,
    },
  });
}

async function structure(ctx: AccessContext, employeeId: string, lines: Record<string, string>, effectiveFrom = "2020-01-01") {
  return createSalaryStructure(ctx, { employeeId, effectiveFrom, lines: Object.entries(lines).map(([code, value]) => ({ componentId: comp[code], value })) });
}

async function calculated(period: string) {
  const run = (await prisma.payrollRun.findUnique({ where: { companyId_period: { companyId: a.company.id, period } } })) ?? (await createPayrollRun(runner, { companyId: a.company.id, period }));
  const result = await transitionPayrollRun(runner, run.id, "calculate");
  return { run, skipped: result.skipped, slip: (employeeId: string) => prisma.payslip.findUniqueOrThrow({ where: { runId_employeeId: { runId: run.id, employeeId } } }) };
}

const amounts = (lines: unknown) => Object.fromEntries((lines as { code: string; amount: string }[]).map((l) => [l.code, l.amount]));

beforeAll(async () => {
  a = await createOrg("HR Co");
  b = await createOrg("Other HR Co");
  owner = await a.ctx(a.ownerId);
  runner = await a.ctx((await a.addMember("hr_manager")).userId);
  approver = await a.ctx((await a.addMember("hr_manager")).userId);
  viewer = await a.ctx((await a.addMember("viewer")).userId);
  outsider = await a.ctx((await a.addMember("sales_executive")).userId);

  comp = {};
  const defs = [
    { code: "BASIC", name: "Basic", kind: "EARNING", calcType: "FIXED", sortOrder: 1 },
    { code: "HRA", name: "House rent", kind: "EARNING", calcType: "PERCENT_OF_COMPONENT", baseComponentCode: "BASIC", sortOrder: 2 },
    { code: "FIXED_ALLOW", name: "Fixed allowance", kind: "EARNING", calcType: "FIXED", prorate: false, sortOrder: 3 },
    { code: "FUND", name: "Fund (user-defined)", kind: "DEDUCTION", calcType: "PERCENT_OF_COMPONENT", baseComponentCode: "BASIC", capAmount: "1800", sortOrder: 10 },
    { code: "LEVY", name: "Levy (user-defined)", kind: "DEDUCTION", calcType: "PERCENT_OF_GROSS", sortOrder: 20 },
    { code: "LOAN", name: "Loan recovery", kind: "DEDUCTION", calcType: "FIXED", sortOrder: 50 },
    { code: "FUND_ER", name: "Fund employer share", kind: "EMPLOYER_CONTRIBUTION", calcType: "PERCENT_OF_COMPONENT", baseComponentCode: "BASIC", sortOrder: 60 },
  ];
  for (const d of defs) comp[d.code] = (await createSalaryComponent(runner, { companyId: a.company.id, ...d })).id;
});
afterAll(cleanupFixtures);

describe("payroll configuration", () => {
  it("ships no components: every rule is user-defined", async () => {
    expect(await prisma.salaryComponent.count({ where: { organizationId: b.org.id } })).toBe(0);
  });

  it("validates component rules", async () => {
    await expect(createSalaryComponent(runner, { companyId: a.company.id, code: "BAD", name: "x", kind: "EARNING", calcType: "PERCENT_OF_GROSS" })).rejects.toMatchObject({ status: 422 });
    await expect(createSalaryComponent(runner, { companyId: a.company.id, code: "BAD", name: "x", kind: "EARNING", calcType: "PERCENT_OF_COMPONENT", baseComponentCode: "LOAN" })).rejects.toMatchObject({ status: 422 });
    await expect(createSalaryComponent(runner, { companyId: a.company.id, code: "BAD", name: "x", kind: "DEDUCTION", calcType: "PERCENT_OF_COMPONENT", baseComponentCode: "NOPE" })).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    await expect(createSalaryComponent(viewer, { companyId: a.company.id, code: "X", name: "x", kind: "EARNING" })).rejects.toMatchObject({ status: 403 });
    const e = await employee(a);
    await expect(structure(runner, e.id, { HRA: "100.5" })).rejects.toMatchObject({ status: 422 });
    await expect(createSalaryStructure(runner, { employeeId: e.id, effectiveFrom: "2021-01-01", lines: [{ componentId: comp.BASIC, value: "10.123" }] })).rejects.toMatchObject({ status: 422 });
    await expect(createSalaryStructure(runner, { employeeId: e.id, effectiveFrom: "2021-01-01", lines: [] })).rejects.toBeInstanceOf(ZodError);
    await prisma.employee.update({ where: { id: e.id }, data: { status: "EXITED", exitDate: new Date("2020-06-30") } });
  });
});

describe("calculation engine", () => {
  const rule = (r: Partial<RuleLine> & Pick<RuleLine, "code" | "kind" | "value">): RuleLine => ({
    name: r.code, calcType: "FIXED", baseComponentCode: null, prorate: true, capAmount: null, sortOrder: 0, ...r,
  });

  it("rounds each component half-up to 2 dp", () => {
    const slip = computePayslip(
      [rule({ code: "BASIC", kind: "EARNING", value: new Decimal("1000.01") }), rule({ code: "HALF", kind: "EARNING", calcType: "PERCENT_OF_COMPONENT", baseComponentCode: "BASIC", value: new Decimal(50) })],
      30, new Decimal(30),
    );
    expect(amounts(slip.lines)).toEqual({ BASIC: "1000.01", HALF: "500.01" }); // 500.005 → 500.01
    const prorated = computePayslip([rule({ code: "BASIC", kind: "EARNING", value: new Decimal(10000) })], 31, new Decimal(29));
    expect(prorated.grossEarnings.toFixed(2)).toBe("9354.84"); // 9354.8387…
  });

  it("rejects circular and dangling percentage rules", () => {
    const cyc = [
      rule({ code: "A", kind: "DEDUCTION", calcType: "PERCENT_OF_COMPONENT", baseComponentCode: "B", value: new Decimal(1) }),
      rule({ code: "B", kind: "DEDUCTION", calcType: "PERCENT_OF_COMPONENT", baseComponentCode: "A", value: new Decimal(1) }),
    ];
    expect(() => computePayslip(cyc, 30, new Decimal(30))).toThrow(/Circular/);
    expect(() => computePayslip([rule({ code: "A", kind: "DEDUCTION", calcType: "PERCENT_OF_COMPONENT", baseComponentCode: "Z", value: new Decimal(1) })], 30, new Decimal(30))).toThrow(/not in the salary structure/);
  });
});

describe("payroll runs", () => {
  let full: { id: string };
  let leaveTaker: { id: string };
  let zero: { id: string };
  let overDeducted: { id: string };
  let joiner: { id: string };
  let leaver: { id: string };
  let noStructure: { id: string };
  let onboarding: { id: string };

  beforeAll(async () => {
    full = await employee(a);
    await structure(runner, full.id, { BASIC: "30000", HRA: "40", FUND: "12", LEVY: "1", FUND_ER: "12" });
    leaveTaker = await employee(a);
    await structure(runner, leaveTaker.id, { BASIC: "30000", HRA: "40" });
    zero = await employee(a);
    await structure(runner, zero.id, { BASIC: "20000", LOAN: "500" });
    overDeducted = await employee(a);
    await structure(runner, overDeducted.id, { BASIC: "1000", LOAN: "1500" });
    joiner = await employee(a, { joiningDate: new Date("2023-03-16") });
    await structure(runner, joiner.id, { BASIC: "31000", FIXED_ALLOW: "1000" }, "2023-03-16");
    leaver = await employee(a, { status: "EXITED", exitDate: new Date("2023-03-10") });
    await structure(runner, leaver.id, { BASIC: "31000" });
    noStructure = await employee(a);
    onboarding = await employee(a, { status: "ONBOARDING" });
    await structure(runner, onboarding.id, { BASIC: "1" });

    const unpaid = await prisma.leaveType.create({ data: { organizationId: a.org.id, companyId: a.company.id, code: "LWP", name: "Leave without pay", annualQuota: 0, isPaid: false } });
    const paid = await prisma.leaveType.create({ data: { organizationId: a.org.id, companyId: a.company.id, code: "CL", name: "Casual", annualQuota: 12 } });
    const leave = (employeeId: string, leaveTypeId: string, startDate: string, endDate: string, days: string, status: "APPROVED" | "PENDING" = "APPROVED") =>
      prisma.leaveRequest.create({ data: { organizationId: a.org.id, employeeId, leaveTypeId, startDate: new Date(startDate), endDate: new Date(endDate), days, status, createdById: a.ownerId } });
    await leave(leaveTaker.id, unpaid.id, "2023-04-10", "2023-04-12", "3");
    await leave(leaveTaker.id, unpaid.id, "2023-04-27", "2023-04-28", "2", "PENDING"); // ignored
    await leave(leaveTaker.id, paid.id, "2023-04-25", "2023-04-25", "1");
    await leave(leaveTaker.id, unpaid.id, "2023-04-29", "2023-05-02", "4"); // 2 of 4 days fall in April
    const att = (date: string, status: "ABSENT" | "HALF_DAY") => prisma.attendanceRecord.create({ data: { organizationId: a.org.id, employeeId: leaveTaker.id, date: new Date(date), status } });
    await att("2023-04-20", "ABSENT");
    await att("2023-04-21", "HALF_DAY");
    await att("2023-04-25", "ABSENT"); // covered by approved paid leave → not unpaid
    await leave(zero.id, unpaid.id, "2023-02-01", "2023-02-28", "28");
  });

  it("full month: fixed, percent-of-component, cap, percent-of-gross and employer share", async () => {
    const { slip } = await calculated("2023-03");
    const s = await slip(full.id);
    expect([s.workingDays.toFixed(2), s.paidDays.toFixed(2), s.unpaidDays.toFixed(2)]).toEqual(["31.00", "31.00", "0.00"]);
    expect(amounts(s.lines)).toEqual({ BASIC: "30000.00", HRA: "12000.00", FUND: "1800.00", LEVY: "420.00", FUND_ER: "3600.00" });
    expect([s.grossEarnings.toFixed(2), s.totalDeductions.toFixed(2), s.netPay.toFixed(2), s.employerContributions.toFixed(2)]).toEqual(["42000.00", "2220.00", "39780.00", "3600.00"]);
  });

  it("joining and exiting mid-month prorate by calendar days; non-prorated earnings stay whole", async () => {
    const { slip } = await calculated("2023-03");
    const j = await slip(joiner.id);
    expect([j.paidDays.toFixed(2), j.unpaidDays.toFixed(2), j.grossEarnings.toFixed(2)]).toEqual(["16.00", "15.00", "17000.00"]); // 31000×16/31 + 1000
    const l = await slip(leaver.id);
    expect([l.paidDays.toFixed(2), l.grossEarnings.toFixed(2)]).toEqual(["10.00", "10000.00"]);
  });

  it("partial month: approved unpaid leave (pro rata across months), absences and half days", async () => {
    const { slip } = await calculated("2023-04");
    const s = await slip(leaveTaker.id);
    // 30 − (3 + 2/4×4 + 1 absent + 0.5 half day) = 23.5
    expect([s.paidDays.toFixed(2), s.unpaidDays.toFixed(2)]).toEqual(["23.50", "6.50"]);
    expect(amounts(s.lines)).toEqual({ BASIC: "23500.00", HRA: "9400.00" });
  });

  it("zero paid days and deductions above gross never make net pay negative", async () => {
    const { slip } = await calculated("2023-02");
    const z = await slip(zero.id);
    expect([z.paidDays.toFixed(2), z.grossEarnings.toFixed(2), z.totalDeductions.toFixed(2), z.netPay.toFixed(2)]).toEqual(["0.00", "0.00", "0.00", "0.00"]);
    const o = await slip(overDeducted.id);
    expect([o.grossEarnings.toFixed(2), o.totalDeductions.toFixed(2), o.netPay.toFixed(2)]).toEqual(["1000.00", "1000.00", "0.00"]);
    expect((o.lines as { code: string; computed?: string }[]).find((l) => l.code === "LOAN")!.computed).toBe("1500.00");
  });

  it("reports employees without a structure and onboarding employees as skipped", async () => {
    const { run, skipped } = await calculated("2023-05");
    expect(skipped.find((s) => s.employeeId === noStructure.id)?.reason).toMatch(/No salary structure/);
    expect(skipped.find((s) => s.employeeId === onboarding.id)?.reason).toMatch(/Onboarding/);
    expect(await prisma.payslip.count({ where: { runId: run.id, employeeId: { in: [noStructure.id, onboarding.id, joiner.id] } } })).toBe(1); // only joiner
    expect((await getPayrollRun(runner, run.id)).skipped.length).toBe(skipped.length);
  });

  it("blocks a second run for the same month; a cancelled month can be reopened", async () => {
    const run = await createPayrollRun(runner, { companyId: a.company.id, period: "2023-06" });
    await expect(createPayrollRun(runner, { companyId: a.company.id, period: "2023-06" })).rejects.toMatchObject({ code: "DUPLICATE", status: 409 });
    await transitionPayrollRun(runner, run.id, "calculate");
    await transitionPayrollRun(runner, run.id, "cancel");
    expect(await prisma.payslip.count({ where: { runId: run.id } })).toBe(0);
    const reopened = await createPayrollRun(runner, { companyId: a.company.id, period: "2023-06" });
    expect([reopened.id, reopened.status]).toEqual([run.id, "DRAFT"]);
  });

  it("approval: separate approver, payroll.approve required, then final and immutable", async () => {
    const { run } = await calculated("2023-07");
    await expect(transitionPayrollRun(runner, run.id, "approve")).rejects.toMatchObject({ status: 403 });
    await expect(transitionPayrollRun(viewer, run.id, "approve")).rejects.toMatchObject({ status: 403 });
    // approver recalculating would make them a preparer too
    const approved = await transitionPayrollRun(approver, run.id, "approve");
    expect([approved.status, approved.approvedById]).toEqual(["APPROVED", approver.userId]);
    for (const action of ["approve", "calculate", "cancel"] as const) {
      await expect(transitionPayrollRun(owner, run.id, action)).rejects.toMatchObject({ code: "INVALID_STATE" });
    }
    // not journaled: 2023 is before the accounting start date
    expect(await prisma.journalEntry.count({ where: { sourceType: "PAYROLL_RUN", sourceId: run.id } })).toBe(0);
    await expect(updateSalaryStructure(runner, (await prisma.salaryStructure.findFirstOrThrow({ where: { employeeId: full.id } })).id, { lines: [{ componentId: comp.BASIC, value: "1" }] }))
      .rejects.toMatchObject({ code: "INVALID_STATE" });

    const preparer = await createPayrollRun(runner, { companyId: a.company.id, period: "2023-08" });
    await transitionPayrollRun(approver, preparer.id, "calculate");
    await expect(transitionPayrollRun(approver, preparer.id, "approve")).rejects.toMatchObject({ status: 403 });
  });

  it("employees see only their own approved payslips", async () => {
    const linked = await employee(a, { userId: outsider.userId });
    await structure(runner, linked.id, { BASIC: "5000" });
    const { run, slip } = await calculated("2023-09");
    const own = await slip(linked.id);
    await expect(getPayslip(outsider, own.id)).rejects.toMatchObject({ status: 404 }); // not approved yet
    await transitionPayrollRun(approver, run.id, "approve");
    expect((await getPayslip(outsider, own.id)).netPay.toFixed(2)).toBe("5000.00");
    const mine = await listPayslips(outsider, {});
    expect(mine.items.map((p) => p.employeeId)).toEqual([linked.id]);
    await expect(getPayslip(outsider, (await slip(full.id)).id)).rejects.toMatchObject({ status: 404 });
  });

  it("posts Dr salary expense / Cr salaries payable on approval when journaled", async () => {
    const d = new Date();
    const fyYear = d.getUTCMonth() + 1 >= 4 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
    await setupFinance(owner, a.company.id, { accountingStartDate: `${fyYear}-04-01` });
    const period = `${fyYear}-04`;
    const { run } = await calculated(period);
    await transitionPayrollRun(approver, run.id, "approve");
    const totals = (await getPayrollRun(runner, run.id)).totals;
    const cost = totals.grossEarnings.add(totals.employerContributions).toFixed(2);
    const j = await prisma.journalEntry.findFirstOrThrow({ where: { sourceType: "PAYROLL_RUN", sourceId: run.id }, include: { lines: { include: { account: true } } } });
    expect(j.date.toISOString().slice(0, 10)).toBe(`${period}-30`);
    expect(j.lines.map((l) => [l.account.code, l.debit.toFixed(2), l.credit.toFixed(2)]).sort()).toEqual([["2500", "0.00", cost], ["5400", cost, "0.00"]]);
  });

  it("scope: other tenants and branch-limited members get 404, others 403", async () => {
    const run = await createPayrollRun(runner, { companyId: a.company.id, period: "2023-10" });
    const other = await b.ctx(b.ownerId);
    await expect(getPayrollRun(other, run.id)).rejects.toMatchObject({ status: 404 });
    await expect(transitionPayrollRun(other, run.id, "calculate")).rejects.toMatchObject({ status: 404 });
    const branchOnly = await a.ctx((await a.addMember("hr_manager", [{ companyId: a.company.id, branchId: a.branch.id }])).userId);
    await expect(getPayrollRun(branchOnly, run.id)).rejects.toMatchObject({ status: 404 });
    await expect(createPayrollRun(outsider, { companyId: a.company.id, period: "2023-11" })).rejects.toMatchObject({ status: 403 });
    await expect(createPayrollRun(viewer, { companyId: a.company.id, period: "2023-11" })).rejects.toMatchObject({ status: 403 });
  });

  it("rolls back a failed recalculation, keeping the previous payslips", async () => {
    const owner2 = await b.ctx(b.ownerId);
    const basic = await createSalaryComponent(owner2, { companyId: b.company.id, code: "BASIC", name: "Basic", kind: "EARNING" });
    const hra = await createSalaryComponent(owner2, { companyId: b.company.id, code: "HRA", name: "HRA", kind: "EARNING", calcType: "PERCENT_OF_COMPONENT", baseComponentCode: "BASIC" });
    const ok = await employee(b);
    await createSalaryStructure(owner2, { employeeId: ok.id, effectiveFrom: "2020-01-01", lines: [{ componentId: basic.id, value: "100" }] });
    const run = await createPayrollRun(owner2, { companyId: b.company.id, period: "2023-03" });
    await transitionPayrollRun(owner2, run.id, "calculate");
    const broken = await employee(b);
    await createSalaryStructure(owner2, { employeeId: broken.id, effectiveFrom: "2020-01-01", lines: [{ componentId: hra.id, value: "10" }] });
    await expect(transitionPayrollRun(owner2, run.id, "calculate")).rejects.toMatchObject({ code: "PAYROLL_RULE_ERROR", status: 422 });
    expect(await prisma.payslip.count({ where: { runId: run.id } })).toBe(1);
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe("CALCULATED");
  });

  it("route: validation 422, permission 403 and Idempotency-Key replay", async () => {
    await signInAs(runner.userId);
    expect((await call(runsRoute.POST, { method: "POST", body: { companyId: a.company.id, period: "2023-13" } })).status).toBe(422);
    const send = () => call(runsRoute.POST, { method: "POST", body: { companyId: a.company.id, period: "2024-01" }, headers: { "idempotency-key": "payroll-2024-01" } });
    const first = await send();
    const second = await send();
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(second.json.data.id).toBe(first.json.data.id);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect((await call(runsRoute.POST, { method: "POST", body: { companyId: a.company.id, period: "2024-01" } })).status).toBe(409);
    await signInAs(outsider.userId);
    expect((await call(runsRoute.POST, { method: "POST", body: { companyId: a.company.id, period: "2024-02" } })).status).toBe(403);
  });
});

describe("recruitment", () => {
  it("opening state machine, candidate dedupe, stage table and terminal stages", async () => {
    const opening = await createJobOpening(runner, { companyId: a.company.id, title: "Engineer" });
    const cand = await createCandidate(runner, { fullName: "Asha", email: "Asha@Example.com" });
    await expect(createCandidate(runner, { fullName: "Asha again", email: "asha@example.com" })).rejects.toMatchObject({ code: "DUPLICATE", status: 409 });
    await expect(createApplication(runner, { jobOpeningId: opening.id, candidateId: cand.id })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(transitionJobOpening(runner, opening.id, "hold")).rejects.toMatchObject({ code: "INVALID_STATE" });
    await transitionJobOpening(runner, opening.id, "open");
    const app = await createApplication(runner, { jobOpeningId: opening.id, candidateId: cand.id });
    await expect(createApplication(runner, { jobOpeningId: opening.id, candidateId: cand.id })).rejects.toMatchObject({ code: "P2002" });

    await expect(moveApplication(runner, app.id, { stage: "OFFER" })).rejects.toMatchObject({ code: "INVALID_STATE", status: 422 });
    await expect(moveApplication(runner, app.id, { stage: "REJECTED" })).rejects.toMatchObject({ status: 422 }); // reason required
    for (const stage of ["SCREENING", "INTERVIEW", "OFFER", "HIRED"]) await moveApplication(runner, app.id, { stage });
    await expect(moveApplication(runner, app.id, { stage: "REJECTED", reason: "late" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(scheduleInterview(runner, { applicationId: app.id, scheduledAt: "2030-01-01T10:00:00Z", interviewerIds: [approver.userId] })).rejects.toMatchObject({ code: "INVALID_STATE" });

    await expect(createJobOpening(viewer, { companyId: a.company.id, title: "x" })).rejects.toMatchObject({ status: 403 });
    await expect(getJobOpening(await b.ctx(b.ownerId), opening.id)).rejects.toMatchObject({ status: 404 });
  });

  it("interviews need active-member interviewers; only they give feedback, once", async () => {
    const opening = await createJobOpening(runner, { companyId: a.company.id, title: "Designer" });
    await transitionJobOpening(runner, opening.id, "open");
    const cand = await createCandidate(runner, { fullName: "Ravi", email: "ravi@example.com" });
    const app = await createApplication(runner, { jobOpeningId: opening.id, candidateId: cand.id });
    const at = "2030-01-02T10:00:00Z";
    await expect(scheduleInterview(runner, { applicationId: app.id, scheduledAt: at, interviewerIds: [b.ownerId] })).rejects.toMatchObject({ code: "INVALID_REFERENCE" });
    const iv = await scheduleInterview(runner, { applicationId: app.id, scheduledAt: at, interviewerIds: [outsider.userId] });
    const fb = { rating: 4, recommendation: "YES" };
    await expect(interviewAction(runner, iv.id, "feedback", fb)).rejects.toMatchObject({ status: 403 });
    await expect(interviewAction(outsider, iv.id, "feedback", { rating: 9, recommendation: "YES" })).rejects.toBeInstanceOf(ZodError);
    await interviewAction(outsider, iv.id, "feedback", fb); // interviewer without recruitment permissions
    await expect(interviewAction(outsider, iv.id, "feedback", fb)).rejects.toMatchObject({ status: 409 });
    await expect(interviewAction(outsider, iv.id, "complete", {})).rejects.toMatchObject({ status: 403 });
    await interviewAction(runner, iv.id, "complete", {});
    await expect(interviewAction(runner, iv.id, "cancel", {})).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("route: invalid stage transition answers 422", async () => {
    const opening = await createJobOpening(runner, { companyId: a.company.id, title: "Analyst" });
    await transitionJobOpening(runner, opening.id, "open");
    const cand = await createCandidate(runner, { fullName: "Meera" });
    const app = await createApplication(runner, { jobOpeningId: opening.id, candidateId: cand.id });
    await signInAs(runner.userId);
    const res = await call(stageRoute.POST, { method: "POST", params: { id: app.id }, body: { stage: "HIRED" } });
    expect([res.status, res.json.code]).toEqual([422, "INVALID_STATE"]);
  });
});

describe("performance", () => {
  it("cycle, goals and self/manager reviews with history", async () => {
    const staff = await employee(a, { userId: viewer.userId });
    const cycle = await createReviewCycle(runner, { companyId: a.company.id, name: "FY review", startDate: "2030-04-01", endDate: "2031-03-31" });
    await expect(transitionReviewCycle(runner, cycle.id, "close")).rejects.toMatchObject({ code: "INVALID_STATE" });
    const goal = await createGoal(runner, { employeeId: staff.id, cycleId: cycle.id, title: "Ship v2", targetValue: "100" });
    await updateGoal(viewer, goal.id, { currentValue: "40", status: "ON_TRACK" });
    await expect(updateGoal(viewer, goal.id, { title: "Easier" })).rejects.toBeInstanceOf(ZodError);
    await expect(updateGoal(outsider, goal.id, { currentValue: "50" })).rejects.toMatchObject({ status: 404 });

    await transitionReviewCycle(runner, cycle.id, "activate");
    const [review] = (await listPerformanceReviews(viewer, { cycleId: cycle.id, employeeId: staff.id })).items;
    expect(review.employeeId).toBe(staff.id);
    await expect(submitPerformanceReview(viewer, review.id, "manager", { rating: 5 })).rejects.toMatchObject({ status: 403 });
    await expect(submitPerformanceReview(runner, review.id, "self", { rating: 5 })).rejects.toMatchObject({ status: 403 });
    await submitPerformanceReview(viewer, review.id, "self", { rating: 4, comments: "Good year" });
    await expect(submitPerformanceReview(viewer, review.id, "self", { rating: 4 })).rejects.toMatchObject({ code: "INVALID_STATE" });
    const done = await submitPerformanceReview(runner, review.id, "manager", { rating: 3 });
    expect([done.status, done.selfRating, done.managerRating]).toEqual(["MANAGER_SUBMITTED", 4, 3]);

    await transitionReviewCycle(runner, cycle.id, "close");
    await expect(updateGoal(viewer, goal.id, { currentValue: "90" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    const history = await listPerformanceReviews(runner, { employeeId: staff.id });
    expect(history.items.map((r) => r.status)).toEqual(["CLOSED"]);
  });
});
