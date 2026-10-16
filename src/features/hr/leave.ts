import { z } from "zod";
import { ApprovalStatus, EmployeeStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, can, companyScopeWhere, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate } from "@/lib/api/list";
import { Decimal, dec, zDecimal } from "@/lib/money";
import { createSystemNotification } from "@/lib/notifications/create";
import { HR_READ, assertAny, assertFullCompany, scopedCompanies, zDay } from "@/features/hr/org";
import { findMyEmployee, requireMyEmployee } from "@/features/hr/employees";

/**
 * Leave types, balances and requests.
 *   balance available = opening + accrued + adjusted − used − pending
 *   apply    → PENDING   (pending += days; 422 INSUFFICIENT_BALANCE unless the type allows negative)
 *   approve  → APPROVED  (pending −= days, used += days)
 *   reject   → REJECTED  (pending −= days)
 *   cancel   → CANCELLED (from PENDING: pending −= days; from APPROVED: used −= days)
 * Days exclude the employee's weekly offs (shift workDays, default Mon–Fri) and company
 * holidays; half days at either end count 0.5. Approver: the reporting manager or a
 * `leave.approve` holder, never the applicant.
 */

const R = ApprovalStatus;
const DEFAULT_WORK_DAYS = "1,2,3,4,5";
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const todayUtc = () => new Date(ymd(new Date()));
const available = (b: { opening: Decimal; accrued: Decimal; adjusted: Decimal; used: Decimal; pending: Decimal }) =>
  b.opening.add(b.accrued).add(b.adjusted).sub(b.used).sub(b.pending);

// ─── Leave types ──────────────────────────────────────────────────────────────

const typeSchema = z.object({
  companyId: z.string().min(1),
  code: z.string().trim().min(1).max(20).regex(/^[A-Za-z0-9_-]+$/, "Letters, digits, - and _ only").transform((s) => s.toUpperCase()),
  name: z.string().trim().min(1).max(80),
  annualQuota: zDecimal({ max: 366 }),
  carryForwardMax: zDecimal({ max: 366 }).default("0"),
  isPaid: z.boolean().default(true),
  allowNegative: z.boolean().default(false),
});

export async function listLeaveTypes(ctx: AccessContext, companyId?: string | null) {
  assertAny(ctx, HR_READ);
  return prisma.leaveType.findMany({
    where: { organizationId: ctx.organizationId, companyId: { in: scopedCompanies(ctx, companyId) } },
    orderBy: [{ companyId: "asc" }, { code: "asc" }],
  });
}

export async function createLeaveType(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "hr.administer");
  const data = typeSchema.parse(input);
  assertFullCompany(ctx, data.companyId);
  return prisma.$transaction(async (tx) => {
    const row = await tx.leaveType.create({ data: { ...data, organizationId: ctx.organizationId } });
    await audit(tx, ctx, { action: "leave_type.created", entity: "leave_type", entityId: row.id, companyId: row.companyId, next: row });
    return row;
  });
}

export async function updateLeaveType(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "hr.administer");
  const data = typeSchema
    .omit({ companyId: true, code: true })
    .extend({ carryForwardMax: zDecimal({ max: 366 }), isPaid: z.boolean(), allowNegative: z.boolean(), isActive: z.boolean() })
    .partial()
    .parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await tx.leaveType.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!before) throw new AppError("NOT_FOUND", "Leave type not found", 404);
    assertFullCompany(ctx, before.companyId);
    const diff = changes(before as Record<string, unknown>, data);
    if (!diff.changed) return before;
    const row = await tx.leaveType.update({ where: { id }, data });
    await audit(tx, ctx, { action: "leave_type.updated", entity: "leave_type", entityId: id, companyId: before.companyId, previous: diff.previous, next: diff.next });
    return row;
  });
}

// ─── Balances ─────────────────────────────────────────────────────────────────

/** Ensures the balance row exists, then locks it for the rest of the transaction. */
async function lockBalance(tx: Prisma.TransactionClient, organizationId: string, employeeId: string, leaveTypeId: string, year: number) {
  const key = { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } };
  const { id } = await tx.leaveBalance.upsert({ where: key, create: { organizationId, employeeId, leaveTypeId, year }, update: {}, select: { id: true } });
  await tx.$queryRaw`SELECT 1 FROM "leave_balances" WHERE "id" = ${id} FOR UPDATE`;
  return tx.leaveBalance.findUniqueOrThrow({ where: { id } });
}

/** Employees whose leave the caller may see: HR scope (leave.view/approve), self, direct reports. */
function employeeVisibility(ctx: AccessContext): Prisma.EmployeeWhereInput {
  const or: Prisma.EmployeeWhereInput[] = [{ userId: ctx.userId }, { manager: { is: { userId: ctx.userId } } }];
  if (can(ctx, "leave.view") || can(ctx, "leave.approve")) or.push(companyScopeWhere(ctx));
  return { organizationId: ctx.organizationId, OR: or };
}

export async function listLeaveBalances(ctx: AccessContext, query: unknown) {
  assertAny(ctx, ["leave.view", "leave.apply", "leave.approve"]);
  const q = z.object({ employeeId: z.string().optional(), year: z.coerce.number().int().min(2000).max(2100).optional() }).parse(query);
  const employeeId = q.employeeId ?? (await findMyEmployee(ctx))?.id;
  if (!employeeId) return [];
  const rows = await prisma.leaveBalance.findMany({
    where: { employeeId, year: q.year ?? new Date().getUTCFullYear(), employee: employeeVisibility(ctx) },
    include: { leaveType: { select: { id: true, code: true, name: true, isPaid: true, allowNegative: true } } },
    orderBy: { leaveType: { code: "asc" } },
  });
  return rows.map((b) => ({ ...b, available: available(b) }));
}

const balanceSchema = z.object({
  employeeId: z.string().min(1),
  leaveTypeId: z.string().min(1),
  year: z.coerce.number().int().min(2000).max(2100),
  opening: zDecimal({ max: 366 }).optional(),
  accrued: zDecimal({ max: 366 }).optional(),
  adjusted: zDecimal({ min: -366, max: 366 }).optional(),
  note: z.string().trim().max(500).optional(),
});

/** Sets opening / accrued / adjusted for one employee, leave type and year (audited). */
export async function setLeaveBalance(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "hr.administer");
  const data = balanceSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const employee = await tx.employee.findFirst({ where: { AND: [{ id: data.employeeId }, companyScopeWhere(ctx)] } });
    if (!employee) throw new AppError("NOT_FOUND", "Employee not found", 404);
    assertFullCompany(ctx, employee.companyId);
    const type = await tx.leaveType.findFirst({ where: { id: data.leaveTypeId, companyId: employee.companyId } });
    if (!type) throw new AppError("INVALID_REFERENCE", "Leave type not found in the employee's company", 422);
    const before = await lockBalance(tx, ctx.organizationId, employee.id, type.id, data.year);
    const patch = { opening: data.opening, accrued: data.accrued, adjusted: data.adjusted };
    const row = await tx.leaveBalance.update({ where: { id: before.id }, data: patch });
    await audit(tx, ctx, {
      action: "leave_balance.set",
      entity: "leave_balance",
      entityId: row.id,
      companyId: employee.companyId,
      previous: { opening: before.opening, accrued: before.accrued, adjusted: before.adjusted },
      next: { opening: row.opening, accrued: row.accrued, adjusted: row.adjusted, note: data.note },
    });
    return { ...row, available: available(row) };
  });
}

/**
 * Yearly allocation for a company: accrued = annual quota for every non-exited employee
 * and active leave type. New rows carry forward min(last year's available, carryForwardMax)
 * as opening. Re-running only re-applies the quota, so it is safe to retry.
 * ponytail: no pro-rating for mid-year joiners; adjust those with setLeaveBalance.
 */
export async function allocateLeave(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "hr.administer");
  const data = z.object({ companyId: z.string().min(1), year: z.coerce.number().int().min(2000).max(2100), leaveTypeId: z.string().optional() }).parse(input);
  assertFullCompany(ctx, data.companyId);
  return prisma.$transaction(async (tx) => {
    const [types, employees] = await Promise.all([
      tx.leaveType.findMany({ where: { companyId: data.companyId, isActive: true, id: data.leaveTypeId } }),
      tx.employee.findMany({ where: { companyId: data.companyId, status: { not: EmployeeStatus.EXITED } }, select: { id: true } }),
    ]);
    if (data.leaveTypeId && types.length === 0) throw new AppError("INVALID_REFERENCE", "Leave type not found", 422);
    let created = 0;
    let updated = 0;
    for (const type of types) {
      for (const e of employees) {
        const key = { employeeId_leaveTypeId_year: { employeeId: e.id, leaveTypeId: type.id, year: data.year } };
        const existing = await tx.leaveBalance.findUnique({ where: key });
        if (existing) {
          if (!existing.accrued.eq(type.annualQuota)) {
            await tx.leaveBalance.update({ where: { id: existing.id }, data: { accrued: type.annualQuota } });
            updated++;
          }
          continue;
        }
        const prev = await tx.leaveBalance.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId: e.id, leaveTypeId: type.id, year: data.year - 1 } } });
        const carry = prev ? Decimal.max(0, Decimal.min(available(prev), type.carryForwardMax)) : dec(0);
        await tx.leaveBalance.create({ data: { organizationId: ctx.organizationId, employeeId: e.id, leaveTypeId: type.id, year: data.year, opening: carry, accrued: type.annualQuota } });
        created++;
      }
    }
    await audit(tx, ctx, { action: "leave_balance.allocated", entity: "company", entityId: data.companyId, companyId: data.companyId, next: { year: data.year, leaveTypeId: data.leaveTypeId, created, updated } });
    return { created, updated };
  });
}

// ─── Requests ─────────────────────────────────────────────────────────────────

/** Working days between start and end (inclusive) for an employee, minus half days. */
export async function countLeaveDays(
  db: Prisma.TransactionClient,
  employee: { companyId: string; shiftId: string | null },
  start: Date,
  end: Date,
  halfDayStart = false,
  halfDayEnd = false,
) {
  const [shift, holidays] = await Promise.all([
    employee.shiftId ? db.shift.findUnique({ where: { id: employee.shiftId }, select: { workDays: true } }) : null,
    db.holiday.findMany({ where: { companyId: employee.companyId, date: { gte: start, lte: end } }, select: { date: true } }),
  ]);
  const workDays = new Set((shift?.workDays ?? DEFAULT_WORK_DAYS).split(","));
  const off = new Set(holidays.map((h) => ymd(h.date)));
  const working = (d: Date) => workDays.has(String(d.getUTCDay() || 7)) && !off.has(ymd(d));
  let days = new Decimal(0);
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86_400_000)) if (working(d)) days = days.add(1);
  if (halfDayStart && working(start)) days = days.sub(0.5);
  if (halfDayEnd && working(end) && end > start) days = days.sub(0.5);
  return days;
}

const applySchema = z
  .object({
    employeeId: z.string().min(1).optional(),
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

const requestInclude = {
  employee: { select: { id: true, fullName: true, employeeNumber: true, userId: true, companyId: true, branchId: true, departmentId: true, manager: { select: { id: true, fullName: true, userId: true } } } },
  leaveType: { select: { id: true, code: true, name: true, isPaid: true, allowNegative: true } },
} satisfies Prisma.LeaveRequestInclude;

/** Apply for leave: own (leave.apply) or on behalf of an employee in scope (leave.approve). */
export async function applyLeave(ctx: AccessContext, input: unknown) {
  const data = applySchema.parse(input);
  const me = await findMyEmployee(ctx);
  const onBehalf = data.employeeId && data.employeeId !== me?.id;
  assertCan(ctx, onBehalf ? "leave.approve" : "leave.apply");
  const employeeId = onBehalf ? data.employeeId! : (await requireMyEmployee(ctx)).id;

  const request = await prisma.$transaction(async (tx) => {
    // Locking the employee serialises applications, so the overlap check holds.
    await tx.$queryRaw`SELECT 1 FROM "employees" WHERE "id" = ${employeeId} FOR UPDATE`;
    const employee = await tx.employee.findFirst({ where: onBehalf ? { AND: [{ id: employeeId }, companyScopeWhere(ctx)] } : { id: employeeId, organizationId: ctx.organizationId } });
    if (!employee) throw new AppError("NOT_FOUND", "Employee not found", 404);
    if (employee.status === EmployeeStatus.EXITED) throw new AppError("INVALID_STATE", "Employee has exited", 422);
    const type = await tx.leaveType.findFirst({ where: { id: data.leaveTypeId, companyId: employee.companyId, isActive: true } });
    if (!type) throw new AppError("INVALID_REFERENCE", "Leave type not found", 422);

    const days = await countLeaveDays(tx, employee, data.startDate, data.endDate, data.halfDayStart, data.halfDayEnd);
    if (days.lte(0)) throw new AppError("VALIDATION_ERROR", "The selected dates have no working days", 422);
    const overlap = await tx.leaveRequest.findFirst({
      where: { employeeId, status: { in: [R.PENDING, R.APPROVED] }, startDate: { lte: data.endDate }, endDate: { gte: data.startDate } },
    });
    if (overlap) throw new AppError("OVERLAP", `Overlaps an existing ${overlap.status.toLowerCase()} leave request`, 422);

    const balance = await lockBalance(tx, ctx.organizationId, employeeId, type.id, data.startDate.getUTCFullYear());
    const free = available(balance);
    if (!type.allowNegative && free.lt(days)) {
      throw new AppError("INSUFFICIENT_BALANCE", `Only ${free.toString()} day(s) of ${type.name} available; ${days.toString()} requested`, 422, { available: free.toString(), requested: days.toString() });
    }
    await tx.leaveBalance.update({ where: { id: balance.id }, data: { pending: { increment: days } } });
    const created = await tx.leaveRequest.create({
      data: {
        organizationId: ctx.organizationId,
        employeeId,
        leaveTypeId: type.id,
        startDate: data.startDate,
        endDate: data.endDate,
        halfDayStart: data.halfDayStart,
        halfDayEnd: data.halfDayEnd,
        days,
        reason: data.reason,
        createdById: ctx.userId,
      },
      include: requestInclude,
    });
    await audit(tx, ctx, { action: "leave_request.applied", entity: "leave_request", entityId: created.id, companyId: employee.companyId, next: { status: created.status, days, startDate: data.startDate, endDate: data.endDate, leaveType: type.code } });
    return created;
  });

  const managerUser = request.employee.manager?.userId;
  if (managerUser && managerUser !== ctx.userId) {
    await createSystemNotification({
      organizationId: ctx.organizationId,
      userId: managerUser,
      type: "LEAVE_REQUESTED",
      title: `${request.employee.fullName} applied for ${request.days.toString()} day(s) of ${request.leaveType.name}`,
      body: `${ymd(request.startDate)} to ${ymd(request.endDate)}`,
      data: { href: `/hr/leave/${request.id}` },
    }).catch(() => null);
  }
  return request;
}

const actionSchemas = {
  approve: z.object({ note: z.string().trim().max(1000).optional() }),
  reject: z.object({ reason: z.string({ required_error: "A reason is required" }).trim().min(1, "A reason is required").max(1000) }),
  cancel: z.object({ reason: z.string().trim().max(1000).optional() }),
};
export type LeaveAction = keyof typeof actionSchemas;
export const LEAVE_ACTIONS = Object.keys(actionSchemas) as LeaveAction[];

export async function transitionLeaveRequest(ctx: AccessContext, id: string, action: LeaveAction, input: unknown) {
  const schema = actionSchemas[action];
  if (!schema) throw new AppError("NOT_FOUND", "Unknown action", 404);
  const body = schema.parse(input ?? {}) as { note?: string; reason?: string };

  const updated = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "leave_requests" WHERE "id" = ${id} FOR UPDATE`;
    const req = await tx.leaveRequest.findFirst({ where: { id, employee: employeeVisibility(ctx) }, include: requestInclude });
    if (!req) throw new AppError("NOT_FOUND", "Leave request not found", 404);
    const isApplicant = req.employee.userId === ctx.userId;
    const isManager = !!req.employee.manager?.userId && req.employee.manager.userId === ctx.userId;
    const isApprover = can(ctx, "leave.approve") && ctx.companies.has(req.employee.companyId);
    const expect = (...allowed: ApprovalStatus[]) => {
      if (!allowed.includes(req.status)) throw new AppError("INVALID_STATE", `Cannot ${action} a leave request that is ${req.status}`, 422);
    };

    let balanceChange: Prisma.LeaveBalanceUpdateInput;
    let status: ApprovalStatus;
    if (action === "approve" || action === "reject") {
      if (isApplicant) throw new AppError("FORBIDDEN", "You cannot decide your own leave request", 403);
      if (!isManager && !isApprover) throw new AppError("FORBIDDEN", "Only the reporting manager or a leave approver can decide", 403);
      expect(R.PENDING);
      status = action === "approve" ? R.APPROVED : R.REJECTED;
      balanceChange = action === "approve" ? { pending: { decrement: req.days }, used: { increment: req.days } } : { pending: { decrement: req.days } };
    } else {
      if (!isApplicant && !isApprover) throw new AppError("FORBIDDEN", "Only the applicant or a leave approver can cancel", 403);
      expect(R.PENDING, R.APPROVED);
      if (req.status === R.APPROVED && !isApprover && req.startDate <= todayUtc()) {
        throw new AppError("INVALID_STATE", "Leave that has started can only be cancelled by a leave approver", 422);
      }
      status = R.CANCELLED;
      balanceChange = req.status === R.PENDING ? { pending: { decrement: req.days } } : { used: { decrement: req.days } };
    }
    const balance = await lockBalance(tx, ctx.organizationId, req.employeeId, req.leaveTypeId, req.startDate.getUTCFullYear());
    await tx.leaveBalance.update({ where: { id: balance.id }, data: balanceChange });
    const row = await tx.leaveRequest.update({
      where: { id },
      data: { status, approverId: ctx.userId, decidedAt: new Date(), decisionNote: body.reason ?? body.note ?? null },
      include: requestInclude,
    });
    await audit(tx, ctx, {
      action: `leave_request.${action}`,
      entity: "leave_request",
      entityId: id,
      companyId: req.employee.companyId,
      previous: { status: req.status },
      next: { status, reason: body.reason ?? body.note, days: req.days },
    });
    return row;
  });

  if (updated.employee.userId && updated.employee.userId !== ctx.userId) {
    await createSystemNotification({
      organizationId: ctx.organizationId,
      userId: updated.employee.userId,
      type: "LEAVE_DECIDED",
      title: `Your ${updated.leaveType.name} request was ${updated.status.toLowerCase()}`,
      body: `${ymd(updated.startDate)} to ${ymd(updated.endDate)}${updated.decisionNote ? ` · ${updated.decisionNote}` : ""}`,
      data: { href: `/hr/leave/${updated.id}` },
    }).catch(() => null);
  }
  return updated;
}

/** Cancels an employee's pending requests inside the caller's transaction (used on exit). */
export async function cancelPendingLeave(tx: Prisma.TransactionClient, employeeId: string, actorId: string, note: string) {
  const pending = await tx.leaveRequest.findMany({ where: { employeeId, status: R.PENDING } });
  for (const req of pending) {
    await tx.leaveBalance.updateMany({ where: { employeeId, leaveTypeId: req.leaveTypeId, year: req.startDate.getUTCFullYear() }, data: { pending: { decrement: req.days } } });
    await tx.leaveRequest.update({ where: { id: req.id }, data: { status: R.CANCELLED, approverId: actorId, decidedAt: new Date(), decisionNote: note } });
  }
  return pending.length;
}

const listSchema = listQuerySchema.extend({
  status: z.nativeEnum(ApprovalStatus).optional(),
  employeeId: z.string().optional(),
  mine: z.enum(["true", "false"]).optional(),
  /** Requests the caller can decide: reports' (manager) or all in scope (leave.approve). */
  toApprove: z.enum(["true", "false"]).optional(),
});

export async function listLeaveRequests(ctx: AccessContext, query: unknown) {
  assertAny(ctx, ["leave.view", "leave.apply", "leave.approve"]);
  const q = listSchema.parse(query);
  const filters: Prisma.LeaveRequestWhereInput[] = [{ organizationId: ctx.organizationId, employee: employeeVisibility(ctx), status: q.status, employeeId: q.employeeId }];
  if (q.mine === "true") filters.push({ employee: { userId: ctx.userId } });
  if (q.toApprove === "true") {
    filters.push({ status: R.PENDING, employee: { OR: [{ userId: null }, { userId: { not: ctx.userId } }] } });
    if (!can(ctx, "leave.approve")) filters.push({ employee: { manager: { is: { userId: ctx.userId } } } });
  }
  const where: Prisma.LeaveRequestWhereInput = { AND: filters };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.leaveRequest.findMany({ where, include: requestInclude, ...listArgs(q, ["createdAt", "startDate"], "createdAt") }),
      prisma.leaveRequest.count({ where }),
    ]),
  );
}

export async function getLeaveRequest(ctx: AccessContext, id: string) {
  assertAny(ctx, ["leave.view", "leave.apply", "leave.approve"]);
  const req = await prisma.leaveRequest.findFirst({ where: { id, employee: employeeVisibility(ctx) }, include: requestInclude });
  if (!req) throw new AppError("NOT_FOUND", "Leave request not found", 404);
  return req;
}

/** Approved (and optionally pending) leave overlapping a date range, plus holidays. */
export async function leaveCalendar(ctx: AccessContext, query: unknown) {
  assertAny(ctx, ["leave.view", "leave.apply", "leave.approve"]);
  const q = z
    .object({
      from: zDay,
      to: zDay,
      companyId: z.string().optional(),
      departmentId: z.string().optional(),
      includePending: z.enum(["true", "false"]).optional(),
    })
    .refine((d) => d.to >= d.from, { message: "to must be on or after from", path: ["to"] })
    .refine((d) => d.to.getTime() - d.from.getTime() <= 92 * 86_400_000, { message: "Range is limited to 92 days", path: ["to"] })
    .parse(query);
  if (q.companyId && !ctx.companies.has(q.companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  const me = await findMyEmployee(ctx);
  const companies = new Set(scopedCompanies(ctx, q.companyId));
  if (me && !q.companyId) companies.add(me.companyId);
  const [leaves, holidays] = await Promise.all([
    prisma.leaveRequest.findMany({
      where: {
        organizationId: ctx.organizationId,
        status: q.includePending === "true" ? { in: [R.APPROVED, R.PENDING] } : R.APPROVED,
        startDate: { lte: q.to },
        endDate: { gte: q.from },
        employee: { AND: [employeeVisibility(ctx), { companyId: q.companyId, departmentId: q.departmentId }] },
      },
      include: requestInclude,
      orderBy: { startDate: "asc" },
    }),
    prisma.holiday.findMany({ where: { organizationId: ctx.organizationId, companyId: { in: [...companies] }, date: { gte: q.from, lte: q.to } }, orderBy: { date: "asc" } }),
  ]);
  return { from: ymd(q.from), to: ymd(q.to), leaves, holidays };
}
