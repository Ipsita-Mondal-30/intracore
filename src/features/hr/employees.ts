import { z } from "zod";
import { EmployeeStatus, EmploymentType, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, assertCompanyAccess, can, companyScopeWhere, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { nextDocumentNumber } from "@/lib/numbering";
import { assertActiveMember } from "@/lib/tenant/refs";
import { zDay } from "@/features/hr/org";
import { cancelPendingLeave } from "@/features/hr/leave";

/**
 * Employees (company-scoped, numbered EMP-00001 per company) and their lifecycle:
 *   ONBOARDING ─activate→ ACTIVE ─notice→ ON_NOTICE ─exit→ EXITED
 *   ACTIVE: confirm, transfer, promote; ON_NOTICE ─withdraw_notice→ ACTIVE
 *   exit is also allowed from ONBOARDING / ACTIVE (immediate separation).
 * Every transition writes an EmploymentEvent and an audit row.
 */

const S = EmployeeStatus;
const nullable = <T extends z.ZodTypeAny>(schema: T) => schema.nullish().or(z.literal("").transform(() => null));
const text = (max: number) => z.string().trim().max(max);
const id = z.string().min(1);

const profileSchema = z.object({
  firstName: text(80).min(1),
  lastName: nullable(text(80)),
  workEmail: nullable(z.string().trim().toLowerCase().email()),
  phone: nullable(text(40)),
  dateOfBirth: nullable(zDay),
  employmentType: z.nativeEnum(EmploymentType).optional(),
  userId: nullable(z.string().uuid()),
  managerId: nullable(id),
  shiftId: nullable(id),
});

const createSchema = profileSchema.extend({
  companyId: id,
  branchId: nullable(id),
  departmentId: nullable(id),
  designationId: nullable(id),
  joiningDate: zDay,
  status: z.enum([S.ONBOARDING, S.ACTIVE]).default(S.ONBOARDING),
});

const include = {
  department: { select: { id: true, name: true } },
  designation: { select: { id: true, name: true } },
  manager: { select: { id: true, fullName: true, employeeNumber: true, userId: true } },
  shift: { select: { id: true, name: true, startTime: true, endTime: true, graceMinutes: true, workDays: true } },
  branch: { select: { id: true, name: true } },
  company: { select: { id: true, code: true, name: true } },
} satisfies Prisma.EmployeeInclude;

const fullName = (first: string, last?: string | null) => [first, last].filter(Boolean).join(" ");
const canSeeAll = (ctx: AccessContext) => can(ctx, "employee.view") || can(ctx, "hr.view");

/** The signed-in user's own employee record in this organization, if any. */
export async function findMyEmployee(ctx: AccessContext) {
  return prisma.employee.findFirst({ where: { organizationId: ctx.organizationId, userId: ctx.userId }, include });
}

export async function requireMyEmployee(ctx: AccessContext) {
  const me = await findMyEmployee(ctx);
  if (!me) throw new AppError("NO_EMPLOYEE", "Your login is not linked to an employee record", 422);
  if (me.status === S.EXITED) throw new AppError("INVALID_STATE", "Your employee record is closed", 422);
  return me;
}

/**
 * Validates client ids against the company/org. The manager chain is walked upwards;
 * finding `selfId` in it would create a reporting loop.
 */
async function assertRefs(
  tx: Prisma.TransactionClient,
  ctx: AccessContext,
  companyId: string,
  refs: { departmentId?: string | null; designationId?: string | null; shiftId?: string | null; managerId?: string | null; userId?: string | null },
  selfId?: string,
) {
  const bad = (what: string) => new AppError("INVALID_REFERENCE", `${what} not found`, 422);
  if (refs.departmentId && !(await tx.department.findFirst({ where: { id: refs.departmentId, companyId, isActive: true } }))) throw bad("Department");
  if (refs.designationId && !(await tx.designation.findFirst({ where: { id: refs.designationId, organizationId: ctx.organizationId } }))) throw bad("Designation");
  if (refs.shiftId && !(await tx.shift.findFirst({ where: { id: refs.shiftId, companyId, isActive: true } }))) throw bad("Shift");
  if (refs.userId) await assertActiveMember(ctx.organizationId, refs.userId);
  if (refs.managerId) {
    const manager = await tx.employee.findFirst({ where: { id: refs.managerId, organizationId: ctx.organizationId } });
    if (!manager || manager.status === S.EXITED) throw bad("Reporting manager");
    let cursor: string | null = manager.id;
    for (let depth = 0; cursor && depth < 100; depth++) {
      if (cursor === selfId) throw new AppError("VALIDATION_ERROR", "Reporting manager would create a reporting loop", 422);
      const row: { managerId: string | null } | null = await tx.employee.findUnique({ where: { id: cursor }, select: { managerId: true } });
      cursor = row?.managerId ?? null;
    }
  }
}

export async function createEmployee(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "employee.create");
  const data = createSchema.parse(input);
  assertCompanyAccess(ctx, data.companyId, data.branchId);
  return prisma.$transaction(async (tx) => {
    await assertRefs(tx, ctx, data.companyId, data);
    const employee = await tx.employee.create({
      data: {
        ...data,
        organizationId: ctx.organizationId,
        fullName: fullName(data.firstName, data.lastName),
        employeeNumber: await nextDocumentNumber(tx, ctx.organizationId, data.companyId, "employee"),
      },
      include,
    });
    await tx.employmentEvent.create({
      data: {
        organizationId: ctx.organizationId,
        employeeId: employee.id,
        type: data.status === S.ACTIVE ? "JOINED" : "ONBOARDING",
        effectiveDate: data.joiningDate,
        details: { departmentId: data.departmentId ?? null, designationId: data.designationId ?? null, branchId: data.branchId ?? null },
        actorId: ctx.userId,
      },
    });
    await audit(tx, ctx, { action: "employee.created", entity: "employee", entityId: employee.id, companyId: employee.companyId, next: employee });
    return employee;
  });
}

export async function updateEmployee(ctx: AccessContext, employeeId: string, input: unknown) {
  assertCan(ctx, "employee.update");
  const data = profileSchema.partial().parse(input);
  return prisma.$transaction(async (tx) => {
    const before = await lockEmployee(tx, ctx, employeeId);
    if (before.status === S.EXITED) throw new AppError("INVALID_STATE", "Exited employees cannot be edited", 422);
    await assertRefs(tx, ctx, before.companyId, data, employeeId);
    const patch: Prisma.EmployeeUncheckedUpdateInput & Record<string, unknown> = { ...data };
    if (data.firstName !== undefined || data.lastName !== undefined) {
      patch.fullName = fullName(data.firstName ?? before.firstName, data.lastName === undefined ? before.lastName : data.lastName);
    }
    const diff = changes(before as Record<string, unknown>, patch);
    if (!diff.changed) return getEmployee(ctx, employeeId, tx);
    const employee = await tx.employee.update({ where: { id: employeeId }, data: patch, include });
    await audit(tx, ctx, { action: "employee.updated", entity: "employee", entityId: employeeId, companyId: before.companyId, previous: diff.previous, next: diff.next });
    return employee;
  });
}

async function lockEmployee(tx: Prisma.TransactionClient, ctx: AccessContext, employeeId: string) {
  await tx.$queryRaw`SELECT 1 FROM "employees" WHERE "id" = ${employeeId} FOR UPDATE`;
  const row = await tx.employee.findFirst({ where: { AND: [{ id: employeeId }, companyScopeWhere(ctx)] } });
  if (!row) throw new AppError("NOT_FOUND", "Employee not found", 404);
  return row;
}

const actionSchemas = {
  activate: z.object({ joiningDate: zDay.optional() }),
  confirm: z.object({ confirmationDate: zDay }),
  transfer: z.object({ departmentId: nullable(id), branchId: nullable(id), effectiveDate: zDay, note: text(500).optional() }),
  promote: z.object({ designationId: id, effectiveDate: zDay, note: text(500).optional() }),
  notice: z.object({ exitDate: zDay, reason: text(1000).min(1, "A reason is required") }),
  withdraw_notice: z.object({ note: text(500).optional() }),
  exit: z.object({ exitDate: zDay.optional(), reason: text(1000).optional() }),
};
export type EmployeeAction = keyof typeof actionSchemas;
export const EMPLOYEE_ACTIONS = Object.keys(actionSchemas) as EmployeeAction[];

const EVENT: Record<EmployeeAction, string> = {
  activate: "JOINED",
  confirm: "CONFIRMED",
  transfer: "TRANSFERRED",
  promote: "PROMOTED",
  notice: "NOTICE",
  withdraw_notice: "NOTICE_WITHDRAWN",
  exit: "EXITED",
};

export async function transitionEmployee(ctx: AccessContext, employeeId: string, action: EmployeeAction, input: unknown) {
  const schema = actionSchemas[action];
  if (!schema) throw new AppError("NOT_FOUND", "Unknown action", 404);
  assertCan(ctx, "employee.update");
  const body = schema.parse(input ?? {}) as Record<string, unknown> & {
    joiningDate?: Date; confirmationDate?: Date; effectiveDate?: Date; exitDate?: Date;
    departmentId?: string | null; branchId?: string | null; designationId?: string; reason?: string; note?: string;
  };

  return prisma.$transaction(async (tx) => {
    const emp = await lockEmployee(tx, ctx, employeeId);
    const expect = (...allowed: EmployeeStatus[]) => {
      if (!allowed.includes(emp.status)) throw new AppError("INVALID_STATE", `Cannot ${action.replace("_", " ")} an employee who is ${emp.status}`, 422);
    };
    let data: Prisma.EmployeeUncheckedUpdateInput;
    let effectiveDate: Date;
    let details: Record<string, unknown> = {};
    switch (action) {
      case "activate":
        expect(S.ONBOARDING);
        effectiveDate = body.joiningDate ?? emp.joiningDate;
        data = { status: S.ACTIVE, joiningDate: effectiveDate };
        break;
      case "confirm":
        expect(S.ACTIVE);
        if (emp.confirmationDate) throw new AppError("INVALID_STATE", "Employee is already confirmed", 422);
        effectiveDate = body.confirmationDate!;
        if (effectiveDate < emp.joiningDate) throw new AppError("VALIDATION_ERROR", "Confirmation cannot be before joining", 422);
        data = { confirmationDate: effectiveDate };
        break;
      case "transfer": {
        expect(S.ONBOARDING, S.ACTIVE, S.ON_NOTICE);
        const patch: { departmentId?: string | null; branchId?: string | null } = {};
        if (body.departmentId !== undefined && body.departmentId !== emp.departmentId) patch.departmentId = body.departmentId;
        if (body.branchId !== undefined && body.branchId !== emp.branchId) patch.branchId = body.branchId;
        if (Object.keys(patch).length === 0) throw new AppError("VALIDATION_ERROR", "Choose a new department or branch", 422);
        if (patch.branchId !== undefined) assertCompanyAccess(ctx, emp.companyId, patch.branchId);
        if (patch.branchId && !(await tx.branch.findFirst({ where: { id: patch.branchId, companyId: emp.companyId, isActive: true } }))) {
          throw new AppError("INVALID_REFERENCE", "Branch not found in this company", 422);
        }
        await assertRefs(tx, ctx, emp.companyId, { departmentId: patch.departmentId });
        effectiveDate = body.effectiveDate!;
        details = { from: { departmentId: emp.departmentId, branchId: emp.branchId }, to: patch, note: body.note };
        data = patch;
        break;
      }
      case "promote":
        expect(S.ACTIVE);
        if (body.designationId === emp.designationId) throw new AppError("VALIDATION_ERROR", "Choose a different designation", 422);
        await assertRefs(tx, ctx, emp.companyId, { designationId: body.designationId });
        effectiveDate = body.effectiveDate!;
        details = { from: { designationId: emp.designationId }, to: { designationId: body.designationId }, note: body.note };
        data = { designationId: body.designationId };
        break;
      case "notice":
        expect(S.ACTIVE);
        if (body.exitDate! < emp.joiningDate) throw new AppError("VALIDATION_ERROR", "Exit date cannot be before joining", 422);
        effectiveDate = body.exitDate!;
        details = { reason: body.reason };
        data = { status: S.ON_NOTICE, exitDate: body.exitDate, exitReason: body.reason };
        break;
      case "withdraw_notice":
        expect(S.ON_NOTICE);
        effectiveDate = new Date(new Date().toISOString().slice(0, 10));
        details = { previousExitDate: emp.exitDate, note: body.note };
        data = { status: S.ACTIVE, exitDate: null, exitReason: null };
        break;
      case "exit": {
        expect(S.ONBOARDING, S.ACTIVE, S.ON_NOTICE);
        const exitDate = body.exitDate ?? emp.exitDate;
        if (!exitDate) throw new AppError("VALIDATION_ERROR", "An exit date is required", 422);
        if (exitDate < emp.joiningDate) throw new AppError("VALIDATION_ERROR", "Exit date cannot be before joining", 422);
        const reports = await tx.employee.count({ where: { managerId: emp.id, status: { not: S.EXITED } } });
        if (reports > 0) throw new AppError("INVALID_STATE", `Reassign ${reports} direct report(s) before the exit`, 422);
        const cancelled = await cancelPendingLeave(tx, emp.id, ctx.userId, "Employee exited");
        effectiveDate = exitDate;
        details = { reason: body.reason ?? emp.exitReason, cancelledLeaveRequests: cancelled };
        data = { status: S.EXITED, exitDate, exitReason: body.reason ?? emp.exitReason };
        break;
      }
    }
    const employee = await tx.employee.update({ where: { id: employeeId }, data: data!, include });
    await tx.employmentEvent.create({
      data: { organizationId: ctx.organizationId, employeeId, type: EVENT[action], effectiveDate: effectiveDate!, details: JSON.parse(JSON.stringify(details)), actorId: ctx.userId },
    });
    await audit(tx, ctx, {
      action: `employee.${action}`,
      entity: "employee",
      entityId: employeeId,
      companyId: emp.companyId,
      previous: { status: emp.status },
      next: { status: employee.status, ...details },
    });
    return employee;
  });
}

const listSchema = listQuerySchema.extend({
  status: z.nativeEnum(EmployeeStatus).optional(),
  companyId: z.string().optional(),
  departmentId: z.string().optional(),
  managerId: z.string().optional(),
});

export async function listEmployees(ctx: AccessContext, query: unknown) {
  if (!canSeeAll(ctx)) assertCan(ctx, "employee.view");
  const q = listSchema.parse(query);
  const where: Prisma.EmployeeWhereInput = {
    AND: [
      companyScopeWhere(ctx),
      { status: q.status, companyId: q.companyId, departmentId: q.departmentId, managerId: q.managerId },
      searchWhere(q.q, ["fullName", "employeeNumber", "workEmail", "phone"]),
    ],
  };
  return paginate(q, () =>
    Promise.all([
      prisma.employee.findMany({ where, include, ...listArgs(q, ["createdAt", "fullName", "employeeNumber", "joiningDate"], "employeeNumber") }),
      prisma.employee.count({ where }),
    ]),
  );
}

/** HR/employee viewers see employees in their scope; anyone can see their own record. */
export async function getEmployee(ctx: AccessContext, employeeId: string, db: Prisma.TransactionClient = prisma) {
  const where: Prisma.EmployeeWhereInput = canSeeAll(ctx)
    ? { AND: [{ id: employeeId }, companyScopeWhere(ctx)] }
    : { id: employeeId, organizationId: ctx.organizationId, userId: ctx.userId };
  const employee = await db.employee.findFirst({
    where,
    include: {
      ...include,
      reports: { where: { status: { not: S.EXITED } }, select: { id: true, fullName: true, employeeNumber: true }, orderBy: { fullName: "asc" } },
      events: { orderBy: [{ effectiveDate: "desc" }, { createdAt: "desc" }] },
    },
  });
  if (!employee) throw new AppError("NOT_FOUND", "Employee not found", 404);
  return employee;
}
