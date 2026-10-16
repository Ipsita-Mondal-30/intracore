import { z } from "zod";
import { ApprovalStatus, AttendanceStatus, EmployeeStatus, TaskStatus, type AttendanceRecord, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate } from "@/lib/api/list";
import { createSystemNotification } from "@/lib/notifications/create";
import { zDay } from "@/features/hr/org";
import { localParts, orgTimezone } from "@/features/hr/attendance";
import { countLeaveDays } from "@/features/hr/leave";
import { notFound, type PortalContext } from "@/features/portal/context";

/**
 * Employee self-service portal, pinned to the account's employee record. Reads: own
 * profile (no exit reason, no salary structure), own attendance, own leave, own payslips
 * from APPROVED payroll runs, tasks assigned to the portal user. Writes (check-in/out,
 * apply/cancel leave) follow the same rules as hr/attendance.ts punch() and hr/leave.ts
 * applyLeave()/cancel, re-implemented here because those take an internal AccessContext.
 * Keep the two in step: day counting is shared (countLeaveDays, localParts).
 */

function employeeOf(p: PortalContext) {
  if (!p.employeeId) throw new AppError("FORBIDDEN", "Portal account has no employee", 403);
  return { organizationId: p.organizationId, employeeId: p.employeeId };
}

async function activeEmployee(db: Prisma.TransactionClient, p: PortalContext) {
  const { organizationId, employeeId } = employeeOf(p);
  const e = await db.employee.findFirst({
    where: { id: employeeId, organizationId },
    select: { id: true, fullName: true, companyId: true, shiftId: true, status: true, shift: { select: { startTime: true, graceMinutes: true } }, manager: { select: { userId: true } } },
  });
  if (!e) throw notFound("Employee");
  if (e.status === EmployeeStatus.EXITED) throw new AppError("INVALID_STATE", "Your employee record is closed", 422);
  return e;
}

export async function getProfile(p: PortalContext) {
  const { organizationId, employeeId } = employeeOf(p);
  const e = await prisma.employee.findFirst({
    where: { id: employeeId, organizationId },
    select: {
      id: true,
      employeeNumber: true,
      fullName: true,
      workEmail: true,
      phone: true,
      employmentType: true,
      status: true,
      joiningDate: true,
      confirmationDate: true,
      company: { select: { name: true } },
      branch: { select: { name: true } },
      department: { select: { name: true } },
      designation: { select: { name: true } },
      manager: { select: { fullName: true } },
      shift: { select: { name: true, startTime: true, endTime: true, workDays: true } },
    },
  });
  if (!e) throw notFound("Employee");
  return e;
}

// ─── Attendance ───────────────────────────────────────────────────────────────

export async function listAttendance(p: PortalContext, query: unknown = {}) {
  const q = listQuerySchema.extend({ from: zDay.optional(), to: zDay.optional() }).parse(query);
  const where: Prisma.AttendanceRecordWhereInput = { ...employeeOf(p), date: q.from || q.to ? { gte: q.from, lte: q.to } : undefined };
  return paginate(q, () =>
    Promise.all([
      prisma.attendanceRecord.findMany({
        where,
        select: { id: true, date: true, status: true, checkIn: true, checkOut: true, workedMinutes: true, lateMinutes: true },
        ...listArgs(q, ["date"], "date"),
      }),
      prisma.attendanceRecord.count({ where }),
    ]),
  );
}

/** Same as attendance.ts derive(): worked minutes and lateness against the shift start + grace. */
function derive(checkIn: Date | null, checkOut: Date | null, shift: { startTime: string; graceMinutes: number } | null, timeZone: string) {
  const workedMinutes = checkIn && checkOut ? Math.round((checkOut.getTime() - checkIn.getTime()) / 60_000) : null;
  let lateMinutes: number | null = null;
  if (checkIn && shift) {
    const [h, m] = shift.startTime.split(":").map(Number);
    const late = localParts(checkIn, timeZone).minutes - (h * 60 + m);
    lateMinutes = late > shift.graceMinutes ? late : 0;
  }
  return { workedMinutes, lateMinutes };
}

/** Self check-in / check-out for today in the organization's timezone. */
export async function punch(p: PortalContext, kind: "in" | "out") {
  const timeZone = await orgTimezone(p.organizationId);
  const now = new Date();
  const { day } = localParts(now, timeZone);
  return prisma.$transaction(async (tx) => {
    const me = await activeEmployee(tx, p);
    const existing = await tx.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: me.id, date: day } } });
    if (existing) await tx.$queryRaw`SELECT 1 FROM "attendance_records" WHERE "id" = ${existing.id} FOR UPDATE`;
    let row: AttendanceRecord;
    if (kind === "in") {
      if (existing?.checkIn) throw new AppError("INVALID_STATE", "You have already checked in today", 422);
      const values = { status: AttendanceStatus.PRESENT, checkIn: now, checkOut: null, ...derive(now, null, me.shift, timeZone), source: "SYSTEM" };
      row = existing
        ? await tx.attendanceRecord.update({ where: { id: existing.id }, data: values })
        : await tx.attendanceRecord.create({ data: { ...values, organizationId: p.organizationId, employeeId: me.id, date: day } });
    } else {
      if (!existing?.checkIn) throw new AppError("INVALID_STATE", "Check in first", 422);
      if (existing.checkOut) throw new AppError("INVALID_STATE", "You have already checked out today", 422);
      row = await tx.attendanceRecord.update({ where: { id: existing.id }, data: { checkOut: now, ...derive(existing.checkIn, now, me.shift, timeZone) } });
    }
    const snap = (r: AttendanceRecord) => ({ status: r.status, checkIn: r.checkIn, checkOut: r.checkOut, workedMinutes: r.workedMinutes, lateMinutes: r.lateMinutes });
    await audit(tx, p, { action: `attendance.check_${kind}`, entity: "attendance", entityId: row.id, companyId: me.companyId, previous: existing ? snap(existing) : undefined, next: { ...snap(row), via: "portal" } });
    return { id: row.id, date: row.date, ...snap(row) };
  });
}

// ─── Leave ────────────────────────────────────────────────────────────────────

const available = (b: { opening: Prisma.Decimal; accrued: Prisma.Decimal; adjusted: Prisma.Decimal; used: Prisma.Decimal; pending: Prisma.Decimal }) =>
  b.opening.add(b.accrued).add(b.adjusted).sub(b.used).sub(b.pending);

export async function listLeaveBalances(p: PortalContext, year = new Date().getUTCFullYear()) {
  const rows = await prisma.leaveBalance.findMany({
    where: { ...employeeOf(p), year },
    select: { opening: true, accrued: true, adjusted: true, used: true, pending: true, year: true, leaveType: { select: { id: true, code: true, name: true, isPaid: true } } },
    orderBy: { leaveType: { code: "asc" } },
  });
  return rows.map((b) => ({ ...b, available: available(b).toString() }));
}

export async function listLeaveTypes(p: PortalContext) {
  const { organizationId, employeeId } = employeeOf(p);
  const e = await prisma.employee.findFirst({ where: { id: employeeId, organizationId }, select: { companyId: true } });
  if (!e) throw notFound("Employee");
  return prisma.leaveType.findMany({ where: { companyId: e.companyId, isActive: true }, select: { id: true, code: true, name: true, isPaid: true }, orderBy: { code: "asc" } });
}

const requestSelect = {
  id: true,
  startDate: true,
  endDate: true,
  halfDayStart: true,
  halfDayEnd: true,
  days: true,
  reason: true,
  status: true,
  decidedAt: true,
  decisionNote: true,
  createdAt: true,
  leaveType: { select: { code: true, name: true } },
} as const;

export async function listLeaveRequests(p: PortalContext, query: unknown = {}) {
  const q = listQuerySchema.extend({ status: z.nativeEnum(ApprovalStatus).optional() }).parse(query);
  const where: Prisma.LeaveRequestWhereInput = { ...employeeOf(p), status: q.status };
  return paginate(q, () =>
    Promise.all([
      prisma.leaveRequest.findMany({ where, select: requestSelect, ...listArgs(q, ["createdAt", "startDate"], "createdAt") }),
      prisma.leaveRequest.count({ where }),
    ]),
  );
}

const applySchema = z
  .object({
    leaveTypeId: z.string().min(1),
    startDate: zDay,
    endDate: zDay,
    halfDayStart: z.boolean().default(false),
    halfDayEnd: z.boolean().default(false),
    reason: z.string().trim().max(1000).optional(),
  })
  .refine((d) => d.endDate >= d.startDate, { message: "End date must be on or after the start date", path: ["endDate"] })
  .refine((d) => d.startDate.getUTCFullYear() === d.endDate.getUTCFullYear(), { message: "Split leave that crosses a year end into two requests", path: ["endDate"] })
  .refine((d) => !(d.halfDayStart && d.halfDayEnd && d.endDate.getTime() === d.startDate.getTime()), { message: "For a single half day, tick only the first half-day box", path: ["halfDayEnd"] });

async function lockBalance(tx: Prisma.TransactionClient, organizationId: string, employeeId: string, leaveTypeId: string, year: number) {
  const key = { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } };
  const { id } = await tx.leaveBalance.upsert({ where: key, create: { organizationId, employeeId, leaveTypeId, year }, update: {}, select: { id: true } });
  await tx.$queryRaw`SELECT 1 FROM "leave_balances" WHERE "id" = ${id} FOR UPDATE`;
  return tx.leaveBalance.findUniqueOrThrow({ where: { id } });
}

/** Apply for own leave: same day counting, overlap and balance rules as hr/leave.ts applyLeave(). */
export async function applyLeave(p: PortalContext, input: unknown) {
  const data = applySchema.parse(input);
  const { organizationId, employeeId } = employeeOf(p);
  const { request, managerUserId, employeeName } = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "employees" WHERE "id" = ${employeeId} FOR UPDATE`;
    const employee = await activeEmployee(tx, p);
    const type = await tx.leaveType.findFirst({ where: { id: data.leaveTypeId, companyId: employee.companyId, isActive: true } });
    if (!type) throw new AppError("INVALID_REFERENCE", "Leave type not found", 422);
    const days = await countLeaveDays(tx, employee, data.startDate, data.endDate, data.halfDayStart, data.halfDayEnd);
    if (days.lte(0)) throw new AppError("VALIDATION_ERROR", "The selected dates have no working days", 422);
    const overlap = await tx.leaveRequest.findFirst({
      where: { employeeId, status: { in: [ApprovalStatus.PENDING, ApprovalStatus.APPROVED] }, startDate: { lte: data.endDate }, endDate: { gte: data.startDate } },
    });
    if (overlap) throw new AppError("OVERLAP", `Overlaps an existing ${overlap.status.toLowerCase()} leave request`, 422);
    const balance = await lockBalance(tx, organizationId, employeeId, type.id, data.startDate.getUTCFullYear());
    const free = available(balance);
    if (!type.allowNegative && free.lt(days)) {
      throw new AppError("INSUFFICIENT_BALANCE", `Only ${free.toString()} day(s) of ${type.name} available; ${days.toString()} requested`, 422, { available: free.toString(), requested: days.toString() });
    }
    await tx.leaveBalance.update({ where: { id: balance.id }, data: { pending: { increment: days } } });
    const request = await tx.leaveRequest.create({
      data: { organizationId, employeeId, leaveTypeId: type.id, startDate: data.startDate, endDate: data.endDate, halfDayStart: data.halfDayStart, halfDayEnd: data.halfDayEnd, days, reason: data.reason, createdById: p.userId },
      select: requestSelect,
    });
    await audit(tx, p, { action: "leave_request.applied", entity: "leave_request", entityId: request.id, companyId: employee.companyId, next: { status: request.status, days, startDate: data.startDate, endDate: data.endDate, leaveType: type.code, via: "portal" } });
    return { request, managerUserId: employee.manager?.userId ?? null, employeeName: employee.fullName };
  });
  if (managerUserId && managerUserId !== p.userId) {
    await createSystemNotification({
      organizationId,
      userId: managerUserId,
      type: "LEAVE_REQUESTED",
      title: `${employeeName} applied for ${request.days.toString()} day(s) of ${request.leaveType.name}`,
      body: `${request.startDate.toISOString().slice(0, 10)} to ${request.endDate.toISOString().slice(0, 10)}`,
      data: { href: `/hr/leave/${request.id}` },
    }).catch(() => null);
  }
  return request;
}

/** Cancel own request: PENDING any time, APPROVED only before it starts (as in leave.ts). */
export async function cancelLeave(p: PortalContext, id: string, input: unknown) {
  const { reason } = z.object({ reason: z.string().trim().max(1000).optional() }).parse(input ?? {});
  const { organizationId, employeeId } = employeeOf(p);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "leave_requests" WHERE "id" = ${id} FOR UPDATE`;
    const req = await tx.leaveRequest.findFirst({ where: { id, organizationId, employeeId }, include: { employee: { select: { companyId: true } } } });
    if (!req) throw notFound("Leave request");
    if (req.status !== ApprovalStatus.PENDING && req.status !== ApprovalStatus.APPROVED) throw new AppError("INVALID_STATE", `Cannot cancel a leave request that is ${req.status}`, 422);
    const today = new Date(new Date().toISOString().slice(0, 10));
    if (req.status === ApprovalStatus.APPROVED && req.startDate <= today) throw new AppError("INVALID_STATE", "Leave that has started can only be cancelled by a leave approver", 422);
    const balance = await lockBalance(tx, organizationId, employeeId, req.leaveTypeId, req.startDate.getUTCFullYear());
    await tx.leaveBalance.update({ where: { id: balance.id }, data: req.status === ApprovalStatus.PENDING ? { pending: { decrement: req.days } } : { used: { decrement: req.days } } });
    const row = await tx.leaveRequest.update({ where: { id }, data: { status: ApprovalStatus.CANCELLED, approverId: p.userId, decidedAt: new Date(), decisionNote: reason ?? null }, select: requestSelect });
    await audit(tx, p, { action: "leave_request.cancel", entity: "leave_request", entityId: id, companyId: req.employee.companyId, previous: { status: req.status }, next: { status: row.status, reason, days: req.days, via: "portal" } });
    return row;
  });
}

// ─── Payslips and tasks ───────────────────────────────────────────────────────

const payslipSelect = {
  id: true,
  workingDays: true,
  paidDays: true,
  unpaidDays: true,
  grossEarnings: true,
  totalDeductions: true,
  netPay: true,
  run: { select: { period: true, approvedAt: true, company: { select: { name: true } } } },
} as const;

/** Own payslips from APPROVED runs only (draft/calculated runs may still change). */
export function listPayslips(p: PortalContext) {
  return prisma.payslip.findMany({ where: { ...employeeOf(p), run: { status: "APPROVED" } }, select: payslipSelect, orderBy: { run: { period: "desc" } } });
}

export async function getPayslip(p: PortalContext, id: string) {
  const slip = await prisma.payslip.findFirst({ where: { id, ...employeeOf(p), run: { status: "APPROVED" } }, select: { ...payslipSelect, employerContributions: true, lines: true } });
  if (!slip) throw notFound("Payslip");
  return slip;
}

/** Tasks assigned to this portal user: general tasks and project tasks. */
export async function listMyTasks(p: PortalContext) {
  const [tasks, projectTasks] = await Promise.all([
    prisma.task.findMany({
      where: { organizationId: p.organizationId, assignedUserId: p.userId, status: { not: TaskStatus.CANCELLED } },
      select: { id: true, title: true, description: true, dueAt: true, priority: true, status: true, completedAt: true },
      orderBy: [{ status: "asc" }, { dueAt: "asc" }],
      take: 200,
    }),
    prisma.projectTask.findMany({
      where: { organizationId: p.organizationId, assigneeId: p.userId, status: { not: "CANCELLED" } },
      select: { id: true, title: true, description: true, dueDate: true, priority: true, status: true, completedAt: true, project: { select: { code: true, name: true } } },
      orderBy: [{ status: "asc" }, { dueDate: "asc" }],
      take: 200,
    }),
  ]);
  return { tasks, projectTasks };
}
