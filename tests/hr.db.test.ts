import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db/prisma";
import type { AccessContext } from "@/lib/access";
import { createCompany } from "@/features/companies/service";
import { createDepartment, createDesignation, createHoliday, createShift } from "@/features/hr/org";
import { createEmployee, getEmployee, listEmployees, transitionEmployee, updateEmployee } from "@/features/hr/employees";
import { decideCorrection, getAttendance, punch, recordAttendance, requestCorrection } from "@/features/hr/attendance";
import { allocateLeave, applyLeave, createLeaveType, leaveCalendar, listLeaveBalances, transitionLeaveRequest } from "@/features/hr/leave";
import * as leaveRequestsRoute from "@/app/api/v1/leave-requests/route";
import * as leaveActionRoute from "@/app/api/v1/leave-requests/[id]/[action]/route";
import { cleanupFixtures, createOrg, type OrgFixture } from "./helpers/fixtures";
import { call, signInAs } from "./helpers/http";

vi.mock("@/lib/auth/supabase-user", () => ({ getSupabaseAuthUser: vi.fn() }));

let a: OrgFixture;
let b: OrgFixture;
let owner: AccessContext;
let hr: AccessContext;
let mgr: AccessContext;
let emp: AccessContext;
let viewer: AccessContext;
let users: { hr: string; mgr: string; emp: string };
let manager: { id: string };
let worker: { id: string };
let hrEmployee: { id: string };
let casual: { id: string };
let lop: { id: string };

// 2027-03-01 is a Monday; 2027-03-03 is made a holiday below.
const YEAR = 2027;

const balanceOf = async (employeeId: string, leaveTypeId: string) =>
  prisma.leaveBalance.findUniqueOrThrow({ where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year: YEAR } } });

beforeAll(async () => {
  a = await createOrg("HR Co");
  b = await createOrg("Other HR Co");
  owner = await a.ctx(a.ownerId);
  const hrMember = await a.addMember("hr_manager");
  const mgrMember = await a.addMember("sales_manager");
  const empMember = await a.addMember("sales_executive");
  const viewerMember = await a.addMember("viewer");
  users = { hr: hrMember.userId, mgr: mgrMember.userId, emp: empMember.userId };
  [hr, mgr, emp, viewer] = await Promise.all([a.ctx(users.hr), a.ctx(users.mgr), a.ctx(users.emp), a.ctx(viewerMember.userId)]);

  const base = { companyId: a.company.id, joiningDate: "2026-01-01", status: "ACTIVE" };
  manager = await createEmployee(hr, { ...base, firstName: "Meera", lastName: "Manager", userId: users.mgr });
  worker = await createEmployee(hr, { ...base, firstName: "Eshan", lastName: "Employee", userId: users.emp, managerId: manager.id });
  hrEmployee = await createEmployee(hr, { ...base, firstName: "Hari", userId: users.hr, managerId: manager.id });

  await createHoliday(hr, { companyId: a.company.id, date: `${YEAR}-03-03`, name: "Festival" });
  casual = await createLeaveType(hr, { companyId: a.company.id, code: "cl", name: "Casual leave", annualQuota: "10", carryForwardMax: "5" });
  lop = await createLeaveType(hr, { companyId: a.company.id, code: "LOP", name: "Loss of pay", annualQuota: "0", isPaid: false, allowNegative: true });
  await allocateLeave(hr, { companyId: a.company.id, year: YEAR });
});
afterAll(cleanupFixtures);

describe("employees", () => {
  it("numbers employees per company and records the joining event", async () => {
    const rows = await prisma.employee.findMany({ where: { companyId: a.company.id }, orderBy: { employeeNumber: "asc" } });
    expect(rows.map((r) => r.employeeNumber)).toEqual(["EMP-00001", "EMP-00002", "EMP-00003"]);
    expect(await prisma.employmentEvent.count({ where: { employeeId: worker.id, type: "JOINED" } })).toBe(1);
    const page = await listEmployees(hr, { q: "eshan" });
    expect(page.items.map((e) => e.id)).toEqual([worker.id]);
  });

  it("rejects reporting loops, bad input and unknown references", async () => {
    await expect(updateEmployee(hr, manager.id, { managerId: worker.id })).rejects.toMatchObject({ status: 422 });
    await expect(updateEmployee(hr, manager.id, { managerId: manager.id })).rejects.toMatchObject({ status: 422 });
    await expect(createEmployee(hr, { companyId: a.company.id, joiningDate: "2026-01-01" })).rejects.toMatchObject({ name: "ZodError" });
    await expect(createEmployee(hr, { companyId: a.company.id, firstName: "X", joiningDate: "2026-01-01", departmentId: "nope" })).rejects.toMatchObject({ status: 422 });
  });

  it("denies writes without permission (403) and hides other tenants and companies (404)", async () => {
    await expect(createEmployee(viewer, { companyId: a.company.id, firstName: "No", joiningDate: "2026-01-01" })).rejects.toMatchObject({ status: 403 });
    await expect(createEmployee(emp, { companyId: a.company.id, firstName: "No", joiningDate: "2026-01-01" })).rejects.toMatchObject({ status: 403 });
    // Own record is visible to the employee; others are not.
    expect((await getEmployee(emp, worker.id)).id).toBe(worker.id);
    await expect(getEmployee(emp, manager.id)).rejects.toMatchObject({ status: 404 });

    const other = await b.ctx(b.ownerId);
    await expect(getEmployee(other, worker.id)).rejects.toMatchObject({ status: 404 });
    await expect(transitionEmployee(other, worker.id, "exit", { exitDate: "2026-12-31" })).rejects.toMatchObject({ status: 404 });
    await expect(createEmployee(other, { companyId: a.company.id, firstName: "X", joiningDate: "2026-01-01" })).rejects.toMatchObject({ status: 404 });

    const second = await createCompany(owner, { code: "HR2", name: "Second HR Co" });
    const scopedHr = await a.ctx((await a.addMember("hr_manager", [{ companyId: second.id }])).userId);
    await expect(getEmployee(scopedHr, worker.id)).rejects.toMatchObject({ status: 404 });
    expect((await listEmployees(scopedHr, {})).total).toBe(0);
    await expect(createDepartment(scopedHr, { companyId: a.company.id, code: "X", name: "X" })).rejects.toMatchObject({ status: 404 });
  });

  it("runs the lifecycle with events, and blocks invalid transitions", async () => {
    const dept = await createDepartment(hr, { companyId: a.company.id, code: "ops", name: "Operations" });
    const senior = await createDesignation(hr, { name: "Senior Associate", level: 3 });
    const e = await createEmployee(hr, { companyId: a.company.id, firstName: "Lia", joiningDate: "2026-02-01" });
    expect(e.status).toBe("ONBOARDING");
    await expect(transitionEmployee(hr, e.id, "confirm", { confirmationDate: "2026-08-01" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await transitionEmployee(hr, e.id, "activate", {});
    await transitionEmployee(hr, e.id, "confirm", { confirmationDate: "2026-08-01" });
    await transitionEmployee(hr, e.id, "transfer", { departmentId: dept.id, effectiveDate: "2026-09-01" });
    await transitionEmployee(hr, e.id, "promote", { designationId: senior.id, effectiveDate: "2026-10-01" });
    await expect(transitionEmployee(emp, e.id, "notice", { exitDate: "2026-12-31", reason: "x" })).rejects.toMatchObject({ status: 403 });
    await transitionEmployee(hr, e.id, "notice", { exitDate: "2026-12-31", reason: "Relocating" });
    const exited = await transitionEmployee(hr, e.id, "exit", {});
    expect(exited).toMatchObject({ status: "EXITED", exitReason: "Relocating", departmentId: dept.id, designationId: senior.id });
    expect(exited.exitDate?.toISOString().slice(0, 10)).toBe("2026-12-31");
    const events = await prisma.employmentEvent.findMany({ where: { employeeId: e.id }, orderBy: { createdAt: "asc" } });
    expect(events.map((ev) => ev.type)).toEqual(["ONBOARDING", "JOINED", "CONFIRMED", "TRANSFERRED", "PROMOTED", "NOTICE", "EXITED"]);
    await expect(transitionEmployee(hr, e.id, "exit", {})).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(updateEmployee(hr, e.id, { phone: "1" })).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await prisma.auditLog.count({ where: { entity: "employee", entityId: e.id } })).toBe(7);
  });

  it("refuses to exit a manager with active reports", async () => {
    await expect(transitionEmployee(hr, manager.id, "exit", { exitDate: "2026-12-31" })).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});

describe("leave", () => {
  it("allocates quota and counts days excluding weekly offs and holidays", async () => {
    expect((await balanceOf(worker.id, casual.id)).accrued.toString()).toBe("10");
    // Mon 1st to Sun 7th: Wed 3rd is a holiday, Sat/Sun are weekly offs → 4 days.
    const req = await applyLeave(emp, { leaveTypeId: casual.id, startDate: `${YEAR}-03-01`, endDate: `${YEAR}-03-07`, reason: "Trip" });
    expect(req.days.toString()).toBe("4");
    expect(req.status).toBe("PENDING");
    expect((await balanceOf(worker.id, casual.id)).pending.toString()).toBe("4");

    const mine = await listLeaveBalances(emp, { year: YEAR });
    expect(mine.find((b) => b.leaveTypeId === casual.id)?.available.toString()).toBe("6");

    // Approve deducts: pending → used.
    await expect(transitionLeaveRequest(emp, req.id, "approve", {})).rejects.toMatchObject({ status: 403 });
    const approved = await transitionLeaveRequest(mgr, req.id, "approve", {});
    expect(approved.status).toBe("APPROVED");
    let bal = await balanceOf(worker.id, casual.id);
    expect([bal.pending.toString(), bal.used.toString()]).toEqual(["0", "4"]);
    await expect(transitionLeaveRequest(mgr, req.id, "approve", {})).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(transitionLeaveRequest(mgr, req.id, "reject", { reason: "late" })).rejects.toMatchObject({ code: "INVALID_STATE" });

    const cal = await leaveCalendar(mgr, { from: `${YEAR}-03-01`, to: `${YEAR}-03-31` });
    expect(cal.leaves.map((l) => l.id)).toContain(req.id);
    expect(cal.holidays.map((h) => h.name)).toContain("Festival");

    // Cancelling approved leave restores the balance.
    const cancelled = await transitionLeaveRequest(emp, req.id, "cancel", {});
    expect(cancelled.status).toBe("CANCELLED");
    bal = await balanceOf(worker.id, casual.id);
    expect([bal.pending.toString(), bal.used.toString()]).toEqual(["0", "0"]);
    await expect(transitionLeaveRequest(emp, req.id, "cancel", {})).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(await prisma.auditLog.count({ where: { entity: "leave_request", entityId: req.id } })).toBe(3);
  });

  it("counts half days and rejects overlaps", async () => {
    const half = await applyLeave(emp, { leaveTypeId: casual.id, startDate: `${YEAR}-04-05`, endDate: `${YEAR}-04-06`, halfDayStart: true });
    expect(half.days.toString()).toBe("1.5");
    await expect(applyLeave(emp, { leaveTypeId: casual.id, startDate: `${YEAR}-04-06`, endDate: `${YEAR}-04-07` })).rejects.toMatchObject({ code: "OVERLAP" });
    await expect(applyLeave(emp, { leaveTypeId: casual.id, startDate: `${YEAR}-04-10`, endDate: `${YEAR}-04-11` })).rejects.toMatchObject({ status: 422 }); // weekend only
    await expect(applyLeave(emp, { leaveTypeId: casual.id, startDate: `${YEAR}-04-07`, endDate: `${YEAR}-04-06` })).rejects.toMatchObject({ name: "ZodError" });
    const rejected = await transitionLeaveRequest(mgr, half.id, "reject", { reason: "Quarter close" });
    expect(rejected.status).toBe("REJECTED");
    expect((await balanceOf(worker.id, casual.id)).pending.toString()).toBe("0");
  });

  it("refuses insufficient balance (422) and persists nothing, unless the type allows negative", async () => {
    const before = await prisma.leaveRequest.count({ where: { employeeId: worker.id } });
    await expect(
      applyLeave(emp, { leaveTypeId: casual.id, startDate: `${YEAR}-05-03`, endDate: `${YEAR}-05-18` }),
    ).rejects.toMatchObject({ status: 422, code: "INSUFFICIENT_BALANCE" });
    expect(await prisma.leaveRequest.count({ where: { employeeId: worker.id } })).toBe(before);
    expect((await balanceOf(worker.id, casual.id)).pending.toString()).toBe("0");

    const unpaid = await applyLeave(emp, { leaveTypeId: lop.id, startDate: `${YEAR}-05-03`, endDate: `${YEAR}-05-04` });
    await transitionLeaveRequest(hr, unpaid.id, "approve", {});
    expect((await balanceOf(worker.id, lop.id)).used.toString()).toBe("2");
  });

  it("forbids self-approval even for leave approvers, and hides requests from unrelated staff", async () => {
    const own = await applyLeave(hr, { leaveTypeId: casual.id, startDate: `${YEAR}-06-07`, endDate: `${YEAR}-06-07` });
    await expect(transitionLeaveRequest(hr, own.id, "approve", {})).rejects.toMatchObject({ status: 403 });
    const outsider = await a.ctx((await a.addMember("sales_executive")).userId);
    await expect(transitionLeaveRequest(outsider, own.id, "approve", {})).rejects.toMatchObject({ status: 404 });
    expect((await transitionLeaveRequest(mgr, own.id, "approve", {})).status).toBe("APPROVED");
    const other = await b.ctx(b.ownerId);
    await expect(transitionLeaveRequest(other, own.id, "cancel", {})).rejects.toMatchObject({ status: 404 });
  });

  it("cancels pending leave when an employee exits", async () => {
    const e = await createEmployee(hr, { companyId: a.company.id, firstName: "Temp", joiningDate: "2026-01-01", status: "ACTIVE" });
    await allocateLeave(hr, { companyId: a.company.id, year: YEAR, leaveTypeId: casual.id });
    const req = await applyLeave(hr, { employeeId: e.id, leaveTypeId: casual.id, startDate: `${YEAR}-07-05`, endDate: `${YEAR}-07-06` });
    expect((await balanceOf(e.id, casual.id)).pending.toString()).toBe("2");
    await transitionEmployee(hr, e.id, "exit", { exitDate: "2026-12-31", reason: "Contract end" });
    expect((await prisma.leaveRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("CANCELLED");
    expect((await balanceOf(e.id, casual.id)).pending.toString()).toBe("0");
  });
});

describe("attendance", () => {
  it("applies an approved correction with audit history; requesters cannot approve their own", async () => {
    const shift = await createShift(hr, { companyId: a.company.id, name: "General", startTime: "09:00", endTime: "18:00", graceMinutes: 10 });
    await updateEmployee(hr, worker.id, { shiftId: shift.id });
    const [rec] = await recordAttendance(hr, {
      date: "2026-09-07",
      entries: [{ employeeId: worker.id, status: "PRESENT", checkIn: "2026-09-07T09:30:00Z", checkOut: "2026-09-07T17:00:00Z" }],
    });
    expect([rec.workedMinutes, rec.lateMinutes]).toEqual([450, 30]); // org timezone is UTC

    const corr = await requestCorrection(emp, { attendanceId: rec.id, reason: "Badge reader was down", proposed: { checkIn: "2026-09-07T09:00:00Z" } });
    await expect(requestCorrection(emp, { attendanceId: rec.id, reason: "again", proposed: { notes: "x" } })).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(decideCorrection(emp, corr.id, "approve", {})).rejects.toMatchObject({ status: 403 });
    await expect(decideCorrection(mgr, corr.id, "approve", {})).rejects.toMatchObject({ status: 403 });
    const approved = await decideCorrection(hr, corr.id, "approve", { note: "Verified with security" });
    expect(approved.status).toBe("APPROVED");
    await expect(decideCorrection(hr, corr.id, "reject", { reason: "x" })).rejects.toMatchObject({ code: "INVALID_STATE" });

    const after = await getAttendance(emp, rec.id);
    expect(after.checkIn?.toISOString()).toBe("2026-09-07T09:00:00.000Z");
    expect([after.workedMinutes, after.lateMinutes]).toEqual([480, 0]);
    const history = await prisma.auditLog.findMany({ where: { entity: "attendance", entityId: rec.id }, orderBy: { createdAt: "asc" } });
    expect(history.map((h) => h.action)).toEqual(["attendance.recorded", "attendance.correction_requested", "attendance.corrected"]);
    expect(history[2].previous).toMatchObject({ checkIn: "2026-09-07T09:30:00.000Z", lateMinutes: 30 });
    expect(history[2].userId).toBe(users.hr);

    // HR (attendance.record) requests a correction: HR cannot approve it; the owner can.
    const byHr = await requestCorrection(hr, { attendanceId: rec.id, reason: "Mark half day", proposed: { status: "HALF_DAY" } });
    await expect(decideCorrection(hr, byHr.id, "approve", {})).rejects.toMatchObject({ status: 403 });
    await decideCorrection(owner, byHr.id, "approve", {});
    expect((await getAttendance(hr, rec.id)).status).toBe("HALF_DAY");
  });

  it("creates a placeholder for a missed day and lets the requester withdraw", async () => {
    const corr = await requestCorrection(emp, { date: "2026-09-08", reason: "Forgot to punch", proposed: { status: "PRESENT" } });
    const rec = await getAttendance(emp, corr.attendanceId);
    expect(rec.status).toBe("ABSENT");
    await expect(decideCorrection(mgr, corr.id, "cancel", {})).rejects.toMatchObject({ status: 404 });
    expect((await decideCorrection(emp, corr.id, "cancel", {})).status).toBe("CANCELLED");
    expect((await getAttendance(emp, rec.id)).status).toBe("ABSENT");
  });

  it("reads HH:MM as local time in the organization's timezone", async () => {
    await prisma.organization.update({ where: { id: a.org.id }, data: { timezone: "Asia/Kolkata" } });
    try {
      const [rec] = await recordAttendance(hr, { date: "2026-09-10", entries: [{ employeeId: worker.id, status: "PRESENT", checkIn: "09:05", checkOut: "18:00" }] });
      expect(rec.checkIn?.toISOString()).toBe("2026-09-10T03:35:00.000Z");
      expect([rec.workedMinutes, rec.lateMinutes]).toEqual([535, 0]);
    } finally {
      await prisma.organization.update({ where: { id: a.org.id }, data: { timezone: "UTC" } });
    }
  });

  it("self check-in/out once per day", async () => {
    const inRow = await punch(emp, "in");
    expect(inRow.status).toBe("PRESENT");
    await expect(punch(emp, "in")).rejects.toMatchObject({ code: "INVALID_STATE" });
    const outRow = await punch(emp, "out");
    expect(outRow.checkOut).not.toBeNull();
    await expect(punch(emp, "out")).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(punch(viewer, "in")).rejects.toMatchObject({ status: 403 });
  });

  it("rolls back a bulk record when one entry is invalid", async () => {
    const early = await createEmployee(hr, { companyId: a.company.id, firstName: "Early", joiningDate: "2025-01-01", status: "ACTIVE" });
    await expect(
      recordAttendance(hr, {
        date: "2025-12-15",
        entries: [
          { employeeId: early.id, status: "PRESENT" },
          { employeeId: hrEmployee.id, status: "PRESENT" }, // before joining
        ],
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(await prisma.attendanceRecord.count({ where: { employeeId: early.id } })).toBe(0);
    await expect(recordAttendance(emp, { date: "2026-09-09", entries: [{ employeeId: worker.id, status: "PRESENT" }] })).rejects.toMatchObject({ status: 403 });
  });
});

describe("routes", () => {
  it("applies leave once per Idempotency-Key and maps errors", async () => {
    await signInAs(users.emp);
    const send = () =>
      call(leaveRequestsRoute.POST, {
        method: "POST",
        body: { leaveTypeId: casual.id, startDate: `${YEAR}-08-02`, endDate: `${YEAR}-08-03` },
        headers: { "idempotency-key": "leave-retry-1" },
      });
    const first = await send();
    const retry = await send();
    expect(first.status).toBe(201);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(retry.json.data.id).toBe(first.json.data.id);
    expect(await prisma.leaveRequest.count({ where: { employeeId: worker.id, startDate: new Date(`${YEAR}-08-02`) } })).toBe(1);
    expect((await balanceOf(worker.id, casual.id)).pending.toString()).toBe("2");

    const invalid = await call(leaveRequestsRoute.POST, { method: "POST", body: { leaveTypeId: casual.id } });
    expect(invalid.status).toBe(422);
    expect(invalid.json.code).toBe("VALIDATION_ERROR");

    const self = await call(leaveActionRoute.POST, { method: "POST", params: { id: first.json.data.id, action: "approve" } });
    expect(self.status).toBe(403);
    const unknown = await call(leaveActionRoute.POST, { method: "POST", params: { id: first.json.data.id, action: "explode" } });
    expect(unknown.status).toBe(404);
  });
});
