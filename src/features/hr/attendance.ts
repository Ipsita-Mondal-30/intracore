import { z } from "zod";
import { ApprovalStatus, AttendanceStatus, EmployeeStatus, type AttendanceRecord, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, can, companyScopeWhere, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate } from "@/lib/api/list";
import { createSystemNotification } from "@/lib/notifications/create";
import { assertAny, zDay } from "@/features/hr/org";
import { requireMyEmployee } from "@/features/hr/employees";

/**
 * Attendance: one record per employee per day.
 *   - self check-in / check-out (attendance.self) on the linked employee, dated in the org timezone
 *   - manual / bulk recording (attendance.record), audited with previous values
 *   - corrections: requested by the employee (or a recorder), applied only when approved by an
 *     attendance.approve holder who is neither the requester nor the employee; every step is
 *     audited on the attendance record ("attendance" entity) so its history shows the change.
 * Worked/late minutes are derived from check-in/out and the employee's shift (HH:MM local + grace).
 */

const A = AttendanceStatus;
const C = ApprovalStatus;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

export const orgTimezone = async (organizationId: string) =>
  (await prisma.organization.findUnique({ where: { id: organizationId }, select: { timezone: true } }))?.timezone ?? "UTC";

/** Local calendar day (as UTC midnight) and minutes since local midnight. */
export function localParts(at: Date, timeZone: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return { day: new Date(`${p.year}-${p.month}-${p.day}`), minutes: Number(p.hour) * 60 + Number(p.minute) };
}

type Times = { checkIn: Date | null; checkOut: Date | null };

/** "HH:MM" (local time on the record's day, org timezone) or an ISO timestamp. */
const timeInput = z.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.coerce.date()]).nullish();

function resolveTime(value: string | Date | null | undefined, day: Date, timeZone: string) {
  if (typeof value !== "string") return value;
  const [h, m] = value.split(":").map(Number);
  const guess = new Date(day.getTime() + (h * 60 + m) * 60_000);
  const local = localParts(guess, timeZone);
  const offset = (local.day.getTime() - day.getTime()) / 60_000 + local.minutes - (h * 60 + m);
  return new Date(guess.getTime() - offset * 60_000);
}

function derive(times: Times, shift: { startTime: string; graceMinutes: number } | null, timeZone: string) {
  if (times.checkIn && times.checkOut && times.checkOut <= times.checkIn) throw new AppError("VALIDATION_ERROR", "Check-out must be after check-in", 422);
  const workedMinutes = times.checkIn && times.checkOut ? Math.round((times.checkOut.getTime() - times.checkIn.getTime()) / 60_000) : null;
  let lateMinutes: number | null = null;
  if (times.checkIn && shift) {
    const [h, m] = shift.startTime.split(":").map(Number);
    const late = localParts(times.checkIn, timeZone).minutes - (h * 60 + m);
    lateMinutes = late > shift.graceMinutes ? late : 0;
  }
  return { workedMinutes, lateMinutes };
}

const snapshot = (r: Pick<AttendanceRecord, "status" | "checkIn" | "checkOut" | "notes" | "workedMinutes" | "lateMinutes">) => ({
  status: r.status,
  checkIn: r.checkIn,
  checkOut: r.checkOut,
  notes: r.notes,
  workedMinutes: r.workedMinutes,
  lateMinutes: r.lateMinutes,
});

/** Employees whose attendance the caller may see: self, direct reports, and HR scope. */
function employeeVisibility(ctx: AccessContext): Prisma.EmployeeWhereInput {
  const or: Prisma.EmployeeWhereInput[] = [{ userId: ctx.userId }, { manager: { is: { userId: ctx.userId } } }];
  if (can(ctx, "attendance.view") || can(ctx, "attendance.record") || can(ctx, "attendance.approve")) or.push(companyScopeWhere(ctx));
  return { organizationId: ctx.organizationId, OR: or };
}

const employeeSelect = { id: true, fullName: true, employeeNumber: true, userId: true, companyId: true, shift: { select: { startTime: true, graceMinutes: true } } } as const;

// ─── Recording ────────────────────────────────────────────────────────────────

const entrySchema = z.object({
  employeeId: z.string().min(1),
  status: z.nativeEnum(AttendanceStatus),
  checkIn: timeInput,
  checkOut: timeInput,
  notes: z.string().trim().max(500).nullish(),
});
const recordSchema = z.object({ date: zDay, entries: z.array(entrySchema).min(1).max(500) });

/** Create or overwrite records for one date (bulk). Overwrites are audited with previous values. */
export async function recordAttendance(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "attendance.record");
  const data = recordSchema.parse(input);
  const ids = [...new Set(data.entries.map((e) => e.employeeId))];
  if (ids.length !== data.entries.length) throw new AppError("VALIDATION_ERROR", "Each employee may appear once per date", 422);
  const timeZone = await orgTimezone(ctx.organizationId);
  return prisma.$transaction(async (tx) => {
    const employees = await tx.employee.findMany({ where: { AND: [{ id: { in: ids } }, companyScopeWhere(ctx)] }, select: { ...employeeSelect, status: true, joiningDate: true, exitDate: true } });
    if (employees.length !== ids.length) throw new AppError("NOT_FOUND", "Employee not found", 404);
    const byId = new Map(employees.map((e) => [e.id, e]));
    const out: AttendanceRecord[] = [];
    for (const entry of data.entries) {
      const emp = byId.get(entry.employeeId)!;
      if (data.date < emp.joiningDate || (emp.status === EmployeeStatus.EXITED && emp.exitDate && data.date > emp.exitDate)) {
        throw new AppError("VALIDATION_ERROR", `${emp.fullName} is not employed on ${ymd(data.date)}`, 422);
      }
      const times = { checkIn: resolveTime(entry.checkIn, data.date, timeZone) ?? null, checkOut: resolveTime(entry.checkOut, data.date, timeZone) ?? null };
      const values = { status: entry.status, ...times, notes: entry.notes ?? null, ...derive(times, emp.shift, timeZone) };
      const key = { employeeId_date: { employeeId: emp.id, date: data.date } };
      const existing = await tx.attendanceRecord.findUnique({ where: key });
      const row = existing
        ? await tx.attendanceRecord.update({ where: { id: existing.id }, data: { ...values, source: "MANUAL" } })
        : await tx.attendanceRecord.create({ data: { ...values, organizationId: ctx.organizationId, employeeId: emp.id, date: data.date, source: "MANUAL" } });
      await audit(tx, ctx, {
        action: existing ? "attendance.updated" : "attendance.recorded",
        entity: "attendance",
        entityId: row.id,
        companyId: emp.companyId,
        previous: existing ? snapshot(existing) : undefined,
        next: snapshot(row),
      });
      out.push(row);
    }
    return out;
  });
}

/** Self check-in / check-out for today (org timezone) on the caller's own employee record. */
export async function punch(ctx: AccessContext, kind: "in" | "out") {
  assertCan(ctx, "attendance.self");
  const me = await requireMyEmployee(ctx);
  const timeZone = await orgTimezone(ctx.organizationId);
  const now = new Date();
  const { day } = localParts(now, timeZone);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.attendanceRecord.findUnique({ where: { employeeId_date: { employeeId: me.id, date: day } } });
    if (existing) await tx.$queryRaw`SELECT 1 FROM "attendance_records" WHERE "id" = ${existing.id} FOR UPDATE`;
    const shift = me.shift;
    let row: AttendanceRecord;
    if (kind === "in") {
      if (existing?.checkIn) throw new AppError("INVALID_STATE", "You have already checked in today", 422);
      const times = { checkIn: now, checkOut: null };
      const values = { status: A.PRESENT, ...times, ...derive(times, shift, timeZone), source: "SYSTEM" };
      row = existing
        ? await tx.attendanceRecord.update({ where: { id: existing.id }, data: values })
        : await tx.attendanceRecord.create({ data: { ...values, organizationId: ctx.organizationId, employeeId: me.id, date: day } });
    } else {
      if (!existing?.checkIn) throw new AppError("INVALID_STATE", "Check in first", 422);
      if (existing.checkOut) throw new AppError("INVALID_STATE", "You have already checked out today", 422);
      row = await tx.attendanceRecord.update({ where: { id: existing.id }, data: { checkOut: now, ...derive({ checkIn: existing.checkIn, checkOut: now }, shift, timeZone) } });
    }
    await audit(tx, ctx, { action: `attendance.check_${kind}`, entity: "attendance", entityId: row.id, companyId: me.companyId, previous: existing ? snapshot(existing) : undefined, next: snapshot(row) });
    return row;
  });
}

const listSchema = listQuerySchema.extend({
  employeeId: z.string().optional(),
  from: zDay.optional(),
  to: zDay.optional(),
  status: z.nativeEnum(AttendanceStatus).optional(),
  mine: z.enum(["true", "false"]).optional(),
});

export async function listAttendance(ctx: AccessContext, query: unknown) {
  assertAny(ctx, ["attendance.view", "attendance.self", "attendance.record", "attendance.approve"]);
  const q = listSchema.parse(query);
  const where: Prisma.AttendanceRecordWhereInput = {
    organizationId: ctx.organizationId,
    employeeId: q.employeeId,
    status: q.status,
    date: q.from || q.to ? { gte: q.from, lte: q.to } : undefined,
    employee: q.mine === "true" ? { AND: [employeeVisibility(ctx), { userId: ctx.userId }] } : employeeVisibility(ctx),
  };
  return paginate(q, () =>
    Promise.all([
      prisma.attendanceRecord.findMany({
        where,
        include: { employee: { select: { id: true, fullName: true, employeeNumber: true } }, _count: { select: { corrections: { where: { status: C.PENDING } } } } },
        ...listArgs(q, ["date", "createdAt"], "date"),
      }),
      prisma.attendanceRecord.count({ where }),
    ]),
  );
}

export async function getAttendance(ctx: AccessContext, id: string) {
  assertAny(ctx, ["attendance.view", "attendance.self", "attendance.record", "attendance.approve"]);
  const row = await prisma.attendanceRecord.findFirst({
    where: { id, employee: employeeVisibility(ctx) },
    include: { employee: { select: employeeSelect }, corrections: { orderBy: { createdAt: "desc" } } },
  });
  if (!row) throw new AppError("NOT_FOUND", "Attendance record not found", 404);
  return row;
}

// ─── Corrections ──────────────────────────────────────────────────────────────

const proposedSchema = z
  .object({
    status: z.nativeEnum(AttendanceStatus).optional(),
    checkIn: timeInput,
    checkOut: timeInput,
    notes: z.string().trim().max(500).nullish(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), "Propose at least one change");

const correctionSchema = z
  .object({
    attendanceId: z.string().min(1).optional(),
    /** Own record for this date; an ABSENT record is created if none exists yet. */
    date: zDay.optional(),
    reason: z.string({ required_error: "A reason is required" }).trim().min(1, "A reason is required").max(1000),
    proposed: proposedSchema,
  })
  .refine((d) => d.attendanceId || d.date, { message: "attendanceId or date is required", path: ["attendanceId"] });

export async function requestCorrection(ctx: AccessContext, input: unknown) {
  assertAny(ctx, ["attendance.self", "attendance.record"]);
  const data = correctionSchema.parse(input);
  const timeZone = await orgTimezone(ctx.organizationId);
  const correction = await prisma.$transaction(async (tx) => {
    let record: AttendanceRecord | null;
    let companyId: string;
    if (data.attendanceId) {
      await tx.$queryRaw`SELECT 1 FROM "attendance_records" WHERE "id" = ${data.attendanceId} FOR UPDATE`;
      const own = { organizationId: ctx.organizationId, userId: ctx.userId };
      const visible: Prisma.EmployeeWhereInput[] = can(ctx, "attendance.self") ? [own] : [];
      if (can(ctx, "attendance.record")) visible.push(companyScopeWhere(ctx));
      const found = await tx.attendanceRecord.findFirst({ where: { id: data.attendanceId, employee: { OR: visible } }, include: { employee: { select: { companyId: true } } } });
      if (!found) throw new AppError("NOT_FOUND", "Attendance record not found", 404);
      record = found;
      companyId = found.employee.companyId;
    } else {
      assertCan(ctx, "attendance.self");
      const me = await requireMyEmployee(ctx);
      companyId = me.companyId;
      const key = { employeeId_date: { employeeId: me.id, date: data.date! } };
      record = await tx.attendanceRecord.findUnique({ where: key });
      if (!record) {
        if (data.date! < me.joiningDate || data.date! > localParts(new Date(), timeZone).day) throw new AppError("VALIDATION_ERROR", "Date is outside your employment or in the future", 422);
        record = await tx.attendanceRecord.create({ data: { organizationId: ctx.organizationId, employeeId: me.id, date: data.date!, status: A.ABSENT, source: "MANUAL", notes: "No punch recorded" } });
      }
      await tx.$queryRaw`SELECT 1 FROM "attendance_records" WHERE "id" = ${record.id} FOR UPDATE`;
    }
    if (await tx.attendanceCorrection.findFirst({ where: { attendanceId: record.id, status: C.PENDING } })) {
      throw new AppError("INVALID_STATE", "A correction for this day is already pending", 422);
    }
    const proposed = { ...data.proposed, checkIn: resolveTime(data.proposed.checkIn, record.date, timeZone), checkOut: resolveTime(data.proposed.checkOut, record.date, timeZone) };
    const merged = {
      checkIn: proposed.checkIn === undefined ? record.checkIn : proposed.checkIn,
      checkOut: proposed.checkOut === undefined ? record.checkOut : proposed.checkOut,
    };
    derive(merged, null, timeZone); // validates check-out after check-in
    const row = await tx.attendanceCorrection.create({
      data: {
        organizationId: ctx.organizationId,
        attendanceId: record.id,
        requestedById: ctx.userId,
        reason: data.reason,
        previous: JSON.parse(JSON.stringify(snapshot(record))),
        proposed: JSON.parse(JSON.stringify(proposed)),
      },
    });
    await audit(tx, ctx, { action: "attendance.correction_requested", entity: "attendance", entityId: record.id, companyId, next: { correctionId: row.id, reason: data.reason, proposed } });
    return row;
  });
  return correction;
}

const decisionSchemas = {
  approve: z.object({ note: z.string().trim().max(1000).optional() }),
  reject: z.object({ reason: z.string({ required_error: "A reason is required" }).trim().min(1, "A reason is required").max(1000) }),
  cancel: z.object({}),
};
export type CorrectionAction = keyof typeof decisionSchemas;
export const CORRECTION_ACTIONS = Object.keys(decisionSchemas) as CorrectionAction[];

export async function decideCorrection(ctx: AccessContext, id: string, action: CorrectionAction, input: unknown) {
  const schema = decisionSchemas[action];
  if (!schema) throw new AppError("NOT_FOUND", "Unknown action", 404);
  const body = schema.parse(input ?? {}) as { note?: string; reason?: string };
  if (action !== "cancel") assertCan(ctx, "attendance.approve");
  const timeZone = await orgTimezone(ctx.organizationId);

  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "attendance_corrections" WHERE "id" = ${id} FOR UPDATE`;
    const visible: Prisma.AttendanceCorrectionWhereInput =
      action === "cancel" ? { requestedById: ctx.userId } : { attendance: { employee: companyScopeWhere(ctx) } };
    const corr = await tx.attendanceCorrection.findFirst({
      where: { id, organizationId: ctx.organizationId, ...visible },
      include: { attendance: { include: { employee: { select: employeeSelect } } } },
    });
    if (!corr) throw new AppError("NOT_FOUND", "Correction not found", 404);
    const employee = corr.attendance.employee;
    if (action !== "cancel" && (corr.requestedById === ctx.userId || employee.userId === ctx.userId)) {
      throw new AppError("FORBIDDEN", "You cannot decide a correction you requested or for your own attendance", 403);
    }
    if (corr.status !== C.PENDING) throw new AppError("INVALID_STATE", `Cannot ${action} a correction that is ${corr.status}`, 422);

    const status = action === "approve" ? C.APPROVED : action === "reject" ? C.REJECTED : C.CANCELLED;
    const updated = await tx.attendanceCorrection.update({
      where: { id },
      data: { status, decidedById: ctx.userId, decidedAt: new Date(), decisionNote: body.reason ?? body.note ?? null },
    });

    let record = corr.attendance;
    if (action === "approve") {
      await tx.$queryRaw`SELECT 1 FROM "attendance_records" WHERE "id" = ${record.id} FOR UPDATE`;
      const current = await tx.attendanceRecord.findUniqueOrThrow({ where: { id: record.id } });
      const p = proposedSchema.parse(corr.proposed);
      const times = {
        checkIn: p.checkIn === undefined ? current.checkIn : resolveTime(p.checkIn, current.date, timeZone) ?? null,
        checkOut: p.checkOut === undefined ? current.checkOut : resolveTime(p.checkOut, current.date, timeZone) ?? null,
      };
      const next = await tx.attendanceRecord.update({
        where: { id: record.id },
        data: { status: p.status ?? current.status, notes: p.notes === undefined ? current.notes : p.notes, ...times, ...derive(times, employee.shift, timeZone) },
      });
      await audit(tx, ctx, {
        action: "attendance.corrected",
        entity: "attendance",
        entityId: record.id,
        companyId: employee.companyId,
        previous: snapshot(current),
        next: { ...snapshot(next), correctionId: id, note: body.note },
      });
      record = { ...next, employee };
    } else {
      await audit(tx, ctx, {
        action: `attendance.correction_${action === "reject" ? "rejected" : "cancelled"}`,
        entity: "attendance",
        entityId: record.id,
        companyId: employee.companyId,
        next: { correctionId: id, reason: body.reason },
      });
    }
    return { correction: updated, attendance: record };
  });

  if (action !== "cancel" && result.correction.requestedById !== ctx.userId) {
    await createSystemNotification({
      organizationId: ctx.organizationId,
      userId: result.correction.requestedById,
      type: "ATTENDANCE_CORRECTION_DECIDED",
      title: `Attendance correction for ${ymd(result.attendance.date)} was ${result.correction.status.toLowerCase()}`,
      body: result.correction.decisionNote ?? undefined,
      data: { href: `/hr/attendance/${result.attendance.id}` },
    }).catch(() => null);
  }
  return result.correction;
}

export async function listCorrections(ctx: AccessContext, query: unknown) {
  assertAny(ctx, ["attendance.self", "attendance.record", "attendance.approve"]);
  const q = listQuerySchema.extend({ status: z.nativeEnum(ApprovalStatus).optional(), mine: z.enum(["true", "false"]).optional() }).parse(query);
  const all = can(ctx, "attendance.approve") && q.mine !== "true";
  const where: Prisma.AttendanceCorrectionWhereInput = {
    organizationId: ctx.organizationId,
    status: q.status,
    ...(all ? { attendance: { employee: companyScopeWhere(ctx) } } : { requestedById: ctx.userId }),
  };
  return paginate(q, () =>
    Promise.all([
      prisma.attendanceCorrection.findMany({
        where,
        include: { attendance: { select: { id: true, date: true, status: true, employee: { select: { id: true, fullName: true, employeeNumber: true, userId: true } } } } },
        ...listArgs(q, ["createdAt"], "createdAt"),
      }),
      prisma.attendanceCorrection.count({ where }),
    ]),
  );
}
