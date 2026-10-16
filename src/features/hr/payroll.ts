import { z } from "zod";
import { SalaryCalcType, SalaryComponentKind, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, can, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate, searchWhere } from "@/lib/api/list";
import { Decimal, money, zDecimal } from "@/lib/money";
import { isJournaled, postJournal } from "@/features/finance/ledger";

/**
 * Payroll: a configurable calculation engine, NOT statutory-compliant payroll.
 * No statutory component, rate, ceiling or slab ships with the app — every rule is a
 * SalaryComponent the company defines. Rules are documented in docs/PAYROLL.md.
 *
 * Run lifecycle (one run per company + month):
 *   DRAFT → calculate → CALCULATED (recalculate freely) → approve → APPROVED (final)
 *   DRAFT | CALCULATED → cancel → CANCELLED; creating the same month again reopens it.
 * Approval needs payroll.approve and a different person from whoever created or last
 * calculated the run; it posts Dr SALARY_EXPENSE / Cr SALARIES_PAYABLE when journaled.
 * Payslips of an approved run are never changed.
 */

const K = SalaryComponentKind;
const C = SalaryCalcType;
const DAY = 86_400_000;

// ─── Scope ───────────────────────────────────────────────────────────────────

/** Payroll touches every employee of a company, so it needs whole-company scope. */
function fullCompanies(ctx: AccessContext) {
  return [...ctx.companies].filter(([, scope]) => scope === "all").map(([id]) => id);
}

/** Full-scope company ids, narrowed to `companyId` when one is asked for. */
const companyFilter = (ctx: AccessContext, companyId?: string) => ({ in: fullCompanies(ctx).filter((id) => !companyId || id === companyId) });

function assertFullCompany(ctx: AccessContext, companyId: string) {
  if (ctx.companies.get(companyId) !== "all") throw new AppError("NOT_FOUND", "Company not found", 404);
}

const zCode = z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9_]{0,29}$/, "Code: letters, digits and _ (max 30), starting with a letter");

// ─── Salary components ───────────────────────────────────────────────────────

const componentSchema = z.object({
  companyId: z.string().min(1),
  code: zCode,
  name: z.string().trim().min(1).max(100),
  kind: z.nativeEnum(K),
  calcType: z.nativeEnum(C).default(C.FIXED),
  baseComponentCode: zCode.nullish(),
  prorate: z.boolean().default(true),
  capAmount: zDecimal().nullish(),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().default(true),
});

async function validateComponentRule(
  tx: Prisma.TransactionClient,
  companyId: string,
  c: { code: string; kind: SalaryComponentKind; calcType: SalaryCalcType; baseComponentCode?: string | null },
) {
  if (c.calcType === C.PERCENT_OF_GROSS && c.kind === K.EARNING) {
    throw new AppError("VALIDATION_ERROR", "An earning cannot be a percent of gross (gross is the sum of earnings)", 422);
  }
  if (c.calcType !== C.PERCENT_OF_COMPONENT) {
    if (c.baseComponentCode) throw new AppError("VALIDATION_ERROR", "A base component applies only to PERCENT_OF_COMPONENT", 422);
    return;
  }
  if (!c.baseComponentCode) throw new AppError("VALIDATION_ERROR", "Choose the base component for a percentage", 422);
  if (c.baseComponentCode === c.code) throw new AppError("VALIDATION_ERROR", "A component cannot be a percentage of itself", 422);
  const base = await tx.salaryComponent.findUnique({ where: { companyId_code: { companyId, code: c.baseComponentCode } } });
  if (!base) throw new AppError("INVALID_REFERENCE", `Base component ${c.baseComponentCode} does not exist in this company`, 422);
  if (c.kind === K.EARNING && base.kind !== K.EARNING) {
    throw new AppError("VALIDATION_ERROR", "An earning can only be a percentage of another earning", 422);
  }
}

export async function listSalaryComponents(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "payroll.view");
  const q = z.object({ companyId: z.string().optional() }).parse(query);
  return prisma.salaryComponent.findMany({
    where: { organizationId: ctx.organizationId, companyId: companyFilter(ctx, q.companyId) },
    orderBy: [{ companyId: "asc" }, { sortOrder: "asc" }, { code: "asc" }],
  });
}

export async function createSalaryComponent(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "payroll.run");
  const data = componentSchema.parse(input);
  assertFullCompany(ctx, data.companyId);
  return prisma.$transaction(async (tx) => {
    await validateComponentRule(tx, data.companyId, data);
    const component = await tx.salaryComponent.create({ data: { ...data, organizationId: ctx.organizationId, baseComponentCode: data.baseComponentCode ?? null, capAmount: data.capAmount ?? null } });
    await audit(tx, ctx, { action: "salary_component.created", entity: "salary_component", entityId: component.id, companyId: component.companyId, next: component });
    return component;
  });
}

/** Changes apply to future calculations only; payslips keep the snapshot they were made with. */
export async function updateSalaryComponent(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "payroll.run");
  const data = componentSchema.omit({ companyId: true, code: true }).partial().parse(input);
  return prisma.$transaction(async (tx) => {
    const current = await tx.salaryComponent.findFirst({ where: { id, organizationId: ctx.organizationId, companyId: { in: fullCompanies(ctx) } } });
    if (!current) throw new AppError("NOT_FOUND", "Salary component not found", 404);
    const next = { ...current, ...data };
    await validateComponentRule(tx, current.companyId, next);
    const updated = await tx.salaryComponent.update({ where: { id }, data });
    await audit(tx, ctx, { action: "salary_component.updated", entity: "salary_component", entityId: id, companyId: current.companyId, previous: current, next: updated });
    return updated;
  });
}

// ─── Salary structures ───────────────────────────────────────────────────────

const linesSchema = z
  .array(z.object({ componentId: z.string().min(1), value: zDecimal({ max: 1e10, places: 4 }) }))
  .min(1, "Add at least one component")
  .max(100)
  .refine((lines) => new Set(lines.map((l) => l.componentId)).size === lines.length, "Each component may appear once");

const structureSchema = z.object({ employeeId: z.string().min(1), effectiveFrom: z.coerce.date(), lines: linesSchema });

const structureInclude = {
  lines: { include: { component: true }, orderBy: { component: { sortOrder: "asc" } } },
  employee: { select: { id: true, fullName: true, employeeNumber: true, companyId: true } },
} satisfies Prisma.SalaryStructureInclude;

async function payrollEmployee(tx: Prisma.TransactionClient, ctx: AccessContext, employeeId: string) {
  const employee = await tx.employee.findFirst({ where: { id: employeeId, organizationId: ctx.organizationId, companyId: { in: fullCompanies(ctx) } } });
  if (!employee) throw new AppError("NOT_FOUND", "Employee not found", 404);
  return employee;
}

async function validateLines(tx: Prisma.TransactionClient, companyId: string, lines: { componentId: string; value: Decimal }[]) {
  const components = await tx.salaryComponent.findMany({ where: { companyId, id: { in: lines.map((l) => l.componentId) }, isActive: true } });
  if (components.length !== lines.length) throw new AppError("INVALID_REFERENCE", "Unknown or inactive salary component", 422);
  for (const l of lines) {
    const c = components.find((x) => x.id === l.componentId)!;
    if (c.calcType === C.FIXED && l.value.decimalPlaces() > 2) throw new AppError("VALIDATION_ERROR", `${c.code}: a fixed amount has at most 2 decimal places`, 422);
    if (c.calcType !== C.FIXED && l.value.gt(100)) throw new AppError("VALIDATION_ERROR", `${c.code}: a percentage cannot exceed 100`, 422);
  }
}

export async function listSalaryStructures(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "payroll.view");
  const q = listQuerySchema.extend({ employeeId: z.string().optional() }).parse(query);
  const where: Prisma.SalaryStructureWhereInput = {
    organizationId: ctx.organizationId,
    employeeId: q.employeeId,
    employee: { companyId: { in: fullCompanies(ctx) }, ...searchWhere(q.q, ["fullName", "employeeNumber"]) },
  };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.salaryStructure.findMany({ where, include: structureInclude, ...listArgs(q, ["effectiveFrom", "createdAt"], "effectiveFrom") }),
      prisma.salaryStructure.count({ where }),
    ]),
  );
}

export async function getSalaryStructure(ctx: AccessContext, id: string) {
  assertCan(ctx, "payroll.view");
  const s = await prisma.salaryStructure.findFirst({ where: { id, organizationId: ctx.organizationId, employee: { companyId: { in: fullCompanies(ctx) } } }, include: structureInclude });
  if (!s) throw new AppError("NOT_FOUND", "Salary structure not found", 404);
  return s;
}

/** A new effective-dated version; the version in force at a period's end is the one used. */
export async function createSalaryStructure(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "payroll.run");
  const data = structureSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const employee = await payrollEmployee(tx, ctx, data.employeeId);
    await validateLines(tx, employee.companyId, data.lines);
    const s = await tx.salaryStructure.create({
      data: {
        organizationId: ctx.organizationId,
        employeeId: employee.id,
        effectiveFrom: data.effectiveFrom,
        lines: { create: data.lines.map((l) => ({ componentId: l.componentId, value: l.value })) },
      },
      include: structureInclude,
    });
    await audit(tx, ctx, { action: "salary_structure.created", entity: "salary_structure", entityId: s.id, companyId: employee.companyId, next: s });
    return s;
  });
}

/** Lines may be replaced until an approved payslip of this employee depends on the version. */
export async function updateSalaryStructure(ctx: AccessContext, id: string, input: unknown) {
  assertCan(ctx, "payroll.run");
  const data = z.object({ lines: linesSchema }).parse(input);
  return prisma.$transaction(async (tx) => {
    const s = await tx.salaryStructure.findFirst({ where: { id, organizationId: ctx.organizationId, employee: { companyId: { in: fullCompanies(ctx) } } }, include: structureInclude });
    if (!s) throw new AppError("NOT_FOUND", "Salary structure not found", 404);
    const used = await tx.payslip.count({ where: { employeeId: s.employeeId, run: { status: "APPROVED", period: { gte: s.effectiveFrom.toISOString().slice(0, 7) } } } });
    if (used > 0) throw new AppError("INVALID_STATE", "Approved payroll used this structure; add a new version with a later effective date", 422);
    await validateLines(tx, s.employee.companyId, data.lines);
    await tx.salaryStructureLine.deleteMany({ where: { structureId: id } });
    const updated = await tx.salaryStructure.update({
      where: { id },
      data: { lines: { create: data.lines.map((l) => ({ componentId: l.componentId, value: l.value })) } },
      include: structureInclude,
    });
    await audit(tx, ctx, { action: "salary_structure.updated", entity: "salary_structure", entityId: id, companyId: s.employee.companyId, previous: s.lines, next: updated.lines });
    return updated;
  });
}

// ─── Calculation engine (pure) ───────────────────────────────────────────────

export type RuleLine = {
  code: string;
  name: string;
  kind: SalaryComponentKind;
  calcType: SalaryCalcType;
  baseComponentCode: string | null;
  prorate: boolean;
  capAmount: Decimal | null;
  sortOrder: number;
  value: Decimal;
};

export type PayslipLine = { code: string; name: string; kind: SalaryComponentKind; amount: string; computed?: string; note?: string };

/**
 * One employee's month. Each component is rounded half-up to 2 dp, then capped at
 * `capAmount`. FIXED earnings with `prorate` scale by paidDays / calendarDays; percent
 * components derive from already-prorated amounts. Deductions apply in sortOrder and
 * never take net pay below zero: a deduction larger than what remains is reduced to
 * the remainder and the line records the computed amount.
 */
export function computePayslip(rules: RuleLine[], calendarDays: number, paidDays: Decimal) {
  const byCode = new Map(rules.map((r) => [r.code, r]));
  const amounts = new Map<string, Decimal>();
  let gross: Decimal | null = null;
  const fail = (message: string) => {
    throw new AppError("PAYROLL_RULE_ERROR", message, 422);
  };

  const resolve = (code: string, stack: string[]): Decimal => {
    const memo = amounts.get(code);
    if (memo) return memo;
    if (stack.includes(code)) fail(`Circular rule: ${[...stack, code].join(" → ")}`);
    const r = byCode.get(code);
    if (!r) return fail(`${stack.at(-1)} is a percentage of ${code}, which is not in the salary structure`);
    let amount: Decimal;
    if (r.calcType === C.FIXED) {
      amount = r.kind === K.EARNING && r.prorate ? r.value.mul(paidDays).div(calendarDays) : r.value;
    } else if (r.calcType === C.PERCENT_OF_COMPONENT) {
      const base = byCode.get(r.baseComponentCode ?? "");
      if (base && r.kind === K.EARNING && base.kind !== K.EARNING) fail(`${r.code}: an earning can only be a percentage of another earning`);
      amount = resolve(r.baseComponentCode ?? "", [...stack, code]).mul(r.value).div(100);
    } else {
      if (r.kind === K.EARNING || gross === null) return fail(`${r.code}: an earning cannot be a percentage of gross`);
      amount = gross.mul(r.value).div(100);
    }
    amount = money(amount);
    if (r.capAmount && amount.gt(r.capAmount)) amount = money(r.capAmount);
    amounts.set(code, amount);
    return amount;
  };

  const ordered = [...rules].sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code));
  for (const r of ordered) if (r.kind === K.EARNING) resolve(r.code, []);
  gross = ordered.filter((r) => r.kind === K.EARNING).reduce((s, r) => s.add(amounts.get(r.code)!), new Decimal(0));
  for (const r of ordered) if (r.kind !== K.EARNING) resolve(r.code, []);

  let remaining = gross;
  let deductions = new Decimal(0);
  let employer = new Decimal(0);
  const lines: PayslipLine[] = ordered.map((r) => {
    const computed = amounts.get(r.code)!;
    const line: PayslipLine = { code: r.code, name: r.name, kind: r.kind, amount: computed.toFixed(2) };
    if (r.kind === K.DEDUCTION) {
      const applied = Decimal.min(computed, remaining);
      remaining = remaining.sub(applied);
      deductions = deductions.add(applied);
      if (applied.lt(computed)) Object.assign(line, { amount: applied.toFixed(2), computed: computed.toFixed(2), note: "Reduced: deductions cannot exceed gross earnings" });
    }
    if (r.kind === K.EMPLOYER_CONTRIBUTION) employer = employer.add(computed);
    return line;
  });
  return { grossEarnings: gross, totalDeductions: deductions, employerContributions: employer, netPay: gross.sub(deductions), lines };
}

// ─── Attendance inputs ───────────────────────────────────────────────────────

export function periodBounds(period: string) {
  const [y, m] = period.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end = new Date(Date.UTC(y, m, 0));
  return { start, end, calendarDays: end.getUTCDate() };
}

const daysBetween = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / DAY) + 1;
const maxDate = (a: Date, b: Date) => (a > b ? a : b);
const minDate = (a: Date, b: Date) => (a < b ? a : b);

type LeaveInput = { startDate: Date; endDate: Date; days: Decimal; isPaid: boolean };
type AttendanceInput = { date: Date; status: string };

/**
 * Unpaid days in the month = days outside employment (before joining / after exit)
 * + approved unpaid leave (its charged `days`, pro rata by calendar overlap when the
 *   request crosses the month or employment boundary)
 * + ABSENT (1) and HALF_DAY (0.5) attendance on dates not covered by approved leave.
 * Capped at the calendar days; paid days = calendar days − unpaid days.
 */
export function payableDays(
  period: string,
  employment: { joiningDate: Date; exitDate: Date | null },
  leaves: LeaveInput[],
  attendance: AttendanceInput[],
) {
  const { start, end, calendarDays } = periodBounds(period);
  const from = maxDate(start, employment.joiningDate);
  const to = employment.exitDate ? minDate(end, employment.exitDate) : end;
  if (from > to) return { calendarDays, unpaidDays: new Decimal(calendarDays), paidDays: new Decimal(0) };

  let unpaid = new Decimal(calendarDays - daysBetween(from, to));
  for (const l of leaves) {
    if (l.isPaid) continue;
    const a = maxDate(from, l.startDate);
    const b = minDate(to, l.endDate);
    if (a > b) continue;
    unpaid = unpaid.add(l.days.mul(daysBetween(a, b)).div(daysBetween(l.startDate, l.endDate)));
  }
  const onLeave = (d: Date) => leaves.some((l) => d >= l.startDate && d <= l.endDate);
  for (const r of attendance) {
    if (r.date < from || r.date > to || onLeave(r.date)) continue;
    if (r.status === "ABSENT") unpaid = unpaid.add(1);
    if (r.status === "HALF_DAY") unpaid = unpaid.add("0.5");
  }
  unpaid = Decimal.min(money(unpaid), calendarDays);
  return { calendarDays, unpaidDays: unpaid, paidDays: new Decimal(calendarDays).sub(unpaid) };
}

// ─── Payroll runs ────────────────────────────────────────────────────────────

const zPeriod = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Period must be YYYY-MM");

function runWhere(ctx: AccessContext): Prisma.PayrollRunWhereInput {
  return { organizationId: ctx.organizationId, companyId: { in: fullCompanies(ctx) } };
}

async function lockRun(tx: Prisma.TransactionClient, ctx: AccessContext, id: string) {
  await tx.$queryRaw`SELECT 1 FROM "payroll_runs" WHERE "id" = ${id} FOR UPDATE`;
  const run = await tx.payrollRun.findFirst({ where: { id, ...runWhere(ctx) } });
  if (!run) throw new AppError("NOT_FOUND", "Payroll run not found", 404);
  return run;
}

type Skipped = { employeeId: string; fullName: string; employeeNumber: string; reason: string };

/** Employees employed during the period, with the structure in force at its end. */
async function payrollInputs(db: Prisma.TransactionClient, companyId: string, period: string) {
  const { start, end } = periodBounds(period);
  const employees = await db.employee.findMany({
    where: {
      companyId,
      joiningDate: { lte: end },
      OR: [{ exitDate: null, status: { not: "EXITED" } }, { exitDate: { gte: start } }],
    },
    include: {
      salaryStructures: {
        where: { effectiveFrom: { lte: end } },
        orderBy: { effectiveFrom: "desc" },
        take: 1,
        include: { lines: { include: { component: true } } },
      },
    },
    orderBy: { employeeNumber: "asc" },
  });
  const skipped: Skipped[] = [];
  const eligible: typeof employees = [];
  for (const e of employees) {
    const base = { employeeId: e.id, fullName: e.fullName, employeeNumber: e.employeeNumber };
    if (e.status === "ONBOARDING") skipped.push({ ...base, reason: "Onboarding is not complete" });
    else if (!e.salaryStructures[0]) skipped.push({ ...base, reason: "No salary structure effective in this period" });
    else eligible.push(e);
  }
  return { eligible, skipped };
}

export async function createPayrollRun(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "payroll.run");
  const data = z.object({ companyId: z.string().min(1), period: zPeriod }).parse(input);
  assertFullCompany(ctx, data.companyId);
  return prisma.$transaction(async (tx) => {
    const existing = await tx.payrollRun.findUnique({ where: { companyId_period: data } });
    if (existing && existing.status !== "CANCELLED") {
      throw new AppError("DUPLICATE", `A payroll run for ${data.period} already exists`, 409, { id: existing.id });
    }
    const run = existing
      ? await tx.payrollRun.update({ where: { id: existing.id }, data: { status: "DRAFT", createdById: ctx.userId, calculatedAt: null, approvedAt: null, approvedById: null } })
      : await tx.payrollRun.create({ data: { ...data, organizationId: ctx.organizationId, createdById: ctx.userId } });
    await audit(tx, ctx, { action: existing ? "payroll_run.reopened" : "payroll_run.created", entity: "payroll_run", entityId: run.id, companyId: run.companyId, next: run });
    return run;
  });
}

export async function listPayrollRuns(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "payroll.view");
  const q = listQuerySchema.extend({ companyId: z.string().optional(), status: z.enum(["DRAFT", "CALCULATED", "APPROVED", "CANCELLED"]).optional() }).parse(query);
  const where: Prisma.PayrollRunWhereInput = { organizationId: ctx.organizationId, companyId: companyFilter(ctx, q.companyId), status: q.status };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.payrollRun.findMany({ where, include: { company: { select: { code: true, name: true } }, _count: { select: { payslips: true } } }, ...listArgs(q, ["period", "createdAt"], "period") }),
      prisma.payrollRun.count({ where }),
    ]),
  );
}

export async function getPayrollRun(ctx: AccessContext, id: string) {
  assertCan(ctx, "payroll.view");
  const run = await prisma.payrollRun.findFirst({
    where: { id, ...runWhere(ctx) },
    include: { company: { select: { code: true, name: true } }, payslips: { include: { employee: { select: { fullName: true, employeeNumber: true } } }, orderBy: { employee: { employeeNumber: "asc" } } } },
  });
  if (!run) throw new AppError("NOT_FOUND", "Payroll run not found", 404);
  const sum = (key: "grossEarnings" | "totalDeductions" | "employerContributions" | "netPay") => run.payslips.reduce((s, p) => s.add(p[key]), new Decimal(0));
  const [journal, inputs] = await Promise.all([
    prisma.journalEntry.findFirst({ where: { companyId: run.companyId, sourceType: "PAYROLL_RUN", sourceId: run.id, sourceEvent: "approve" }, select: { id: true, number: true } }),
    run.status === "DRAFT" || run.status === "CALCULATED" ? prisma.$transaction((tx) => payrollInputs(tx, run.companyId, run.period)) : null,
  ]);
  return {
    ...run,
    totals: { grossEarnings: sum("grossEarnings"), totalDeductions: sum("totalDeductions"), employerContributions: sum("employerContributions"), netPay: sum("netPay") },
    skipped: inputs?.skipped ?? [],
    journal,
  };
}

const RUN_ACTIONS = ["calculate", "approve", "cancel"] as const;
export type PayrollRunAction = (typeof RUN_ACTIONS)[number];
export const PAYROLL_RUN_ACTIONS: readonly string[] = RUN_ACTIONS;

export async function transitionPayrollRun(ctx: AccessContext, id: string, action: PayrollRunAction) {
  if (!RUN_ACTIONS.includes(action)) throw new AppError("NOT_FOUND", "Unknown action", 404);
  assertCan(ctx, action === "approve" ? "payroll.approve" : "payroll.run");

  return prisma.$transaction(async (tx) => {
    const run = await lockRun(tx, ctx, id);
    const expect = (...allowed: string[]) => {
      if (!allowed.includes(run.status)) throw new AppError("INVALID_STATE", `Cannot ${action} a payroll run that is ${run.status}`, 422);
    };
    let skipped: Skipped[] = [];
    let data: Prisma.PayrollRunUncheckedUpdateInput;

    switch (action) {
      case "calculate": {
        expect("DRAFT", "CALCULATED");
        const inputs = await payrollInputs(tx, run.companyId, run.period);
        skipped = inputs.skipped;
        const ids = inputs.eligible.map((e) => e.id);
        const { start, end } = periodBounds(run.period);
        const [leaves, attendance] = await Promise.all([
          tx.leaveRequest.findMany({
            where: { employeeId: { in: ids }, status: "APPROVED", startDate: { lte: end }, endDate: { gte: start } },
            include: { leaveType: { select: { isPaid: true } } },
          }),
          tx.attendanceRecord.findMany({ where: { employeeId: { in: ids }, date: { gte: start, lte: end }, status: { in: ["ABSENT", "HALF_DAY"] } } }),
        ]);
        await tx.payslip.deleteMany({ where: { runId: run.id } });
        const payslips: Prisma.PayslipCreateManyInput[] = [];
        for (const e of inputs.eligible) {
          const days = payableDays(
            run.period,
            e,
            leaves.filter((l) => l.employeeId === e.id).map((l) => ({ ...l, isPaid: l.leaveType.isPaid })),
            attendance.filter((a) => a.employeeId === e.id),
          );
          const rules = e.salaryStructures[0].lines.filter((l) => l.component.isActive).map((l) => ({ ...l.component, value: l.value }));
          let slip: ReturnType<typeof computePayslip>;
          try {
            slip = computePayslip(rules, days.calendarDays, days.paidDays);
          } catch (error) {
            if (error instanceof AppError) throw new AppError(error.code, `${e.employeeNumber} ${e.fullName}: ${error.message}`, 422);
            throw error;
          }
          payslips.push({
            organizationId: ctx.organizationId,
            runId: run.id,
            employeeId: e.id,
            workingDays: days.calendarDays,
            paidDays: days.paidDays,
            unpaidDays: days.unpaidDays,
            grossEarnings: slip.grossEarnings,
            totalDeductions: slip.totalDeductions,
            employerContributions: slip.employerContributions,
            netPay: slip.netPay,
            lines: slip.lines,
          });
        }
        await tx.payslip.createMany({ data: payslips });
        data = { status: "CALCULATED", calculatedAt: new Date() };
        break;
      }
      case "approve": {
        expect("CALCULATED");
        const calculatedBy = await tx.auditLog.findFirst({ where: { organizationId: ctx.organizationId, entity: "payroll_run", entityId: run.id, action: "payroll_run.calculate" }, orderBy: { createdAt: "desc" }, select: { userId: true } });
        if (run.createdById === ctx.userId || calculatedBy?.userId === ctx.userId) {
          throw new AppError("FORBIDDEN", "Payroll must be approved by someone other than who prepared it", 403);
        }
        const slips = await tx.payslip.findMany({ where: { runId: run.id }, select: { grossEarnings: true, employerContributions: true } });
        if (slips.length === 0) throw new AppError("INVALID_STATE", "There are no payslips to approve", 422);
        const cost = slips.reduce((s, p) => s.add(p.grossEarnings).add(p.employerContributions), new Decimal(0));
        const date = periodBounds(run.period).end;
        if (cost.gt(0) && (await isJournaled(tx, run.companyId, date))) {
          // ponytail: deductions and employer contributions sit in Salaries Payable too; split per liability once mapping keys exist
          await postJournal(tx, { organizationId: ctx.organizationId, companyId: run.companyId, userId: ctx.userId }, {
            date,
            sourceType: "PAYROLL_RUN",
            sourceId: run.id,
            sourceEvent: "approve",
            memo: `Payroll ${run.period}`,
            lines: [
              { account: "SALARY_EXPENSE", debit: cost },
              { account: "SALARIES_PAYABLE", credit: cost },
            ],
          });
        }
        data = { status: "APPROVED", approvedById: ctx.userId, approvedAt: new Date() };
        break;
      }
      case "cancel":
        expect("DRAFT", "CALCULATED");
        await tx.payslip.deleteMany({ where: { runId: run.id } });
        data = { status: "CANCELLED", calculatedAt: null };
        break;
    }
    const updated = await tx.payrollRun.update({ where: { id }, data: data! });
    await audit(tx, ctx, { action: `payroll_run.${action}`, entity: "payroll_run", entityId: id, companyId: run.companyId, previous: { status: run.status }, next: { status: updated.status, skipped: skipped.length ? skipped : undefined } });
    return { ...updated, skipped };
  });
}

// ─── Payslips ────────────────────────────────────────────────────────────────

/** payroll.view sees payslips of full-scope companies; anyone sees their own approved payslips. */
function payslipWhere(ctx: AccessContext): Prisma.PayslipWhereInput {
  const own: Prisma.PayslipWhereInput = { organizationId: ctx.organizationId, employee: { userId: ctx.userId }, run: { status: "APPROVED" } };
  return can(ctx, "payroll.view") ? { OR: [{ organizationId: ctx.organizationId, run: { companyId: { in: fullCompanies(ctx) } } }, own] } : own;
}

export async function listPayslips(ctx: AccessContext, query: unknown) {
  const q = listQuerySchema.extend({ runId: z.string().optional(), employeeId: z.string().optional() }).parse(query);
  const where: Prisma.PayslipWhereInput = { AND: [payslipWhere(ctx), { runId: q.runId, employeeId: q.employeeId }] };
  return paginate(q, () =>
    prisma.$transaction([
      prisma.payslip.findMany({
        where,
        include: { employee: { select: { fullName: true, employeeNumber: true } }, run: { select: { period: true, status: true, companyId: true } } },
        ...listArgs(q, ["createdAt", "netPay"], "createdAt"),
      }),
      prisma.payslip.count({ where }),
    ]),
  );
}

export async function getPayslip(ctx: AccessContext, id: string) {
  const slip = await prisma.payslip.findFirst({
    where: { AND: [{ id }, payslipWhere(ctx)] },
    include: { employee: { select: { fullName: true, employeeNumber: true, userId: true } }, run: { select: { id: true, period: true, status: true, company: { select: { name: true } } } } },
  });
  if (!slip) throw new AppError("NOT_FOUND", "Payslip not found", 404);
  return slip;
}
