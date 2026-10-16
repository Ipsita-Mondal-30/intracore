import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, can, companyScopeWhere, type AccessContext } from "@/lib/access";
import { audit, changes } from "@/lib/audit";
import { listArgs, listQuerySchema, paginate } from "@/lib/api/list";
import { zDecimal } from "@/lib/money";

/**
 * Performance: review cycles (DRAFT → ACTIVE → CLOSED), goals with numeric targets and
 * progress, and one review per employee per cycle:
 *   PENDING → SELF_SUBMITTED (the employee) → MANAGER_SUBMITTED (reviewer) → CLOSED (cycle close)
 * A manager review may also be given straight from PENDING. Nobody reviews themselves as manager.
 * Visibility: performance.view sees employees in scope; everyone sees their own goals and
 * reviews and the reviews they are the reviewer on.
 */

const CYCLE_TRANSITIONS = {
  activate: { from: ["DRAFT"], to: "ACTIVE" },
  close: { from: ["ACTIVE"], to: "CLOSED" },
} as const;
export type CycleAction = keyof typeof CYCLE_TRANSITIONS;
export const CYCLE_ACTIONS = Object.keys(CYCLE_TRANSITIONS) as CycleAction[];

const GOAL_STATUSES = ["NOT_STARTED", "ON_TRACK", "AT_RISK", "ACHIEVED", "MISSED"] as const;

const inScopeEmployee = (ctx: AccessContext): Prisma.EmployeeWhereInput => companyScopeWhere(ctx);
const ownEmployee = (ctx: AccessContext): Prisma.EmployeeWhereInput => ({ organizationId: ctx.organizationId, userId: ctx.userId });

// ─── Review cycles ───────────────────────────────────────────────────────────

const cycleSchema = z
  .object({ companyId: z.string().min(1), name: z.string().trim().min(1).max(120), startDate: z.coerce.date(), endDate: z.coerce.date() })
  .refine((c) => c.endDate >= c.startDate, { message: "End date must be on or after the start date", path: ["endDate"] });

const cycleWhere = (ctx: AccessContext): Prisma.ReviewCycleWhereInput => ({ organizationId: ctx.organizationId, companyId: { in: [...ctx.companies.keys()] } });

export async function createReviewCycle(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "performance.manage");
  const data = cycleSchema.parse(input);
  if (!ctx.companies.has(data.companyId)) throw new AppError("NOT_FOUND", "Company not found", 404);
  return prisma.$transaction(async (tx) => {
    const cycle = await tx.reviewCycle.create({ data: { ...data, organizationId: ctx.organizationId } });
    await audit(tx, ctx, { action: "review_cycle.created", entity: "review_cycle", entityId: cycle.id, companyId: cycle.companyId, next: cycle });
    return cycle;
  });
}

/**
 * activate: opens a PENDING review for every ACTIVE / ON_NOTICE employee of the company
 * who joined by the cycle end, with their manager's login (if any) as reviewer.
 * close: closes the cycle and all its reviews; goals of a closed cycle are frozen.
 */
export async function transitionReviewCycle(ctx: AccessContext, id: string, action: CycleAction) {
  const rule = CYCLE_TRANSITIONS[action];
  if (!rule) throw new AppError("NOT_FOUND", "Unknown action", 404);
  assertCan(ctx, "performance.manage");
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "review_cycles" WHERE "id" = ${id} FOR UPDATE`;
    const cycle = await tx.reviewCycle.findFirst({ where: { id, ...cycleWhere(ctx) } });
    if (!cycle) throw new AppError("NOT_FOUND", "Review cycle not found", 404);
    if (!(rule.from as readonly string[]).includes(cycle.status)) throw new AppError("INVALID_STATE", `Cannot ${action} a cycle that is ${cycle.status}`, 422);
    let reviews = 0;
    if (action === "activate") {
      const employees = await tx.employee.findMany({
        where: { companyId: cycle.companyId, status: { in: ["ACTIVE", "ON_NOTICE"] }, joiningDate: { lte: cycle.endDate } },
        select: { id: true, manager: { select: { userId: true } } },
      });
      reviews = (
        await tx.performanceReview.createMany({
          data: employees.map((e) => ({ organizationId: ctx.organizationId, cycleId: id, employeeId: e.id, reviewerId: e.manager?.userId ?? null })),
          skipDuplicates: true,
        })
      ).count;
    } else {
      await tx.performanceReview.updateMany({ where: { cycleId: id }, data: { status: "CLOSED" } });
    }
    const updated = await tx.reviewCycle.update({ where: { id }, data: { status: rule.to } });
    await audit(tx, ctx, { action: `review_cycle.${action}`, entity: "review_cycle", entityId: id, companyId: cycle.companyId, previous: { status: cycle.status }, next: { status: updated.status, reviewsOpened: reviews || undefined } });
    return updated;
  });
}

export async function listReviewCycles(ctx: AccessContext, query: unknown) {
  assertCan(ctx, "performance.view");
  const q = listQuerySchema.extend({ status: z.enum(["DRAFT", "ACTIVE", "CLOSED"]).optional() }).parse(query);
  const where: Prisma.ReviewCycleWhereInput = { ...cycleWhere(ctx), status: q.status };
  return paginate(q, () =>
    Promise.all([
      prisma.reviewCycle.findMany({ where, include: { _count: { select: { reviews: true, goals: true } } }, ...listArgs(q, ["startDate", "createdAt"], "startDate") }),
      prisma.reviewCycle.count({ where }),
    ]),
  );
}

export async function getReviewCycle(ctx: AccessContext, id: string) {
  assertCan(ctx, "performance.view");
  const cycle = await prisma.reviewCycle.findFirst({ where: { id, ...cycleWhere(ctx) } });
  if (!cycle) throw new AppError("NOT_FOUND", "Review cycle not found", 404);
  return cycle;
}

// ─── Goals ───────────────────────────────────────────────────────────────────

const goalFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(5000).nullish(),
  targetValue: zDecimal({ max: 1e15 }).nullish(),
  currentValue: zDecimal({ max: 1e15 }).nullish(),
  weight: z.coerce.number().int().min(1).max(100).default(1),
  dueDate: z.coerce.date().nullish(),
  status: z.enum(GOAL_STATUSES).default("NOT_STARTED"),
};
const goalSchema = z.object({ employeeId: z.string().min(1), cycleId: z.string().min(1).nullish(), ...goalFields });

function goalWhere(ctx: AccessContext): Prisma.GoalWhereInput {
  const own = { organizationId: ctx.organizationId, employee: ownEmployee(ctx) };
  return can(ctx, "performance.view") ? { OR: [{ organizationId: ctx.organizationId, employee: inScopeEmployee(ctx) }, own] } : own;
}

export async function createGoal(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "performance.manage");
  const data = goalSchema.parse(input);
  return prisma.$transaction(async (tx) => {
    const employee = await tx.employee.findFirst({ where: { id: data.employeeId, ...inScopeEmployee(ctx) } });
    if (!employee) throw new AppError("NOT_FOUND", "Employee not found", 404);
    if (data.cycleId) {
      const cycle = await tx.reviewCycle.findFirst({ where: { id: data.cycleId, companyId: employee.companyId } });
      if (!cycle) throw new AppError("INVALID_REFERENCE", "Review cycle not found in the employee's company", 422);
      if (cycle.status === "CLOSED") throw new AppError("INVALID_STATE", "The review cycle is closed", 422);
    }
    const goal = await tx.goal.create({ data: { ...data, organizationId: ctx.organizationId } });
    await audit(tx, ctx, { action: "goal.created", entity: "goal", entityId: goal.id, companyId: employee.companyId, next: goal });
    return goal;
  });
}

/** performance.manage edits everything; the employee may record progress (currentValue, status). */
export async function updateGoal(ctx: AccessContext, id: string, input: unknown) {
  const manager = can(ctx, "performance.manage");
  const schema = manager ? z.object(goalFields).partial() : z.object({ currentValue: goalFields.currentValue, status: goalFields.status.optional() }).strict();
  const data = schema.parse(input);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "goals" WHERE "id" = ${id} FOR UPDATE`;
    const goal = await tx.goal.findFirst({ where: { AND: [{ id }, goalWhere(ctx)] }, include: { employee: true, cycle: true } });
    if (!goal) throw new AppError("NOT_FOUND", "Goal not found", 404);
    const self = goal.employee.userId === ctx.userId;
    if (!self && !(manager && (await tx.employee.count({ where: { id: goal.employeeId, ...inScopeEmployee(ctx) } })))) {
      throw new AppError("FORBIDDEN", "You cannot update this goal", 403);
    }
    if (goal.cycle?.status === "CLOSED") throw new AppError("INVALID_STATE", "Goals of a closed cycle cannot change", 422);
    const { employee: _e, cycle: _c, ...before } = goal;
    const updated = await tx.goal.update({ where: { id }, data });
    await audit(tx, ctx, { action: "goal.updated", entity: "goal", entityId: id, companyId: goal.employee.companyId, ...changes(before, updated) });
    return updated;
  });
}

export async function listGoals(ctx: AccessContext, query: unknown) {
  const q = listQuerySchema.extend({ employeeId: z.string().optional(), cycleId: z.string().optional(), mine: z.enum(["true", "false"]).optional() }).parse(query);
  const where: Prisma.GoalWhereInput = {
    AND: [goalWhere(ctx), { employeeId: q.employeeId, cycleId: q.cycleId }, q.mine === "true" ? { employee: ownEmployee(ctx) } : {}],
  };
  return paginate(q, () =>
    Promise.all([
      prisma.goal.findMany({ where, include: { employee: { select: { id: true, fullName: true, employeeNumber: true } }, cycle: { select: { id: true, name: true, status: true } } }, ...listArgs(q, ["createdAt", "dueDate"], "createdAt") }),
      prisma.goal.count({ where }),
    ]),
  );
}

// ─── Reviews ─────────────────────────────────────────────────────────────────

function reviewWhere(ctx: AccessContext): Prisma.PerformanceReviewWhereInput {
  const personal: Prisma.PerformanceReviewWhereInput[] = [
    { organizationId: ctx.organizationId, employee: ownEmployee(ctx) },
    { organizationId: ctx.organizationId, reviewerId: ctx.userId },
  ];
  return { OR: can(ctx, "performance.view") ? [{ organizationId: ctx.organizationId, employee: inScopeEmployee(ctx) }, ...personal] : personal };
}

const reviewInclude = {
  employee: { select: { id: true, fullName: true, employeeNumber: true, userId: true } },
  cycle: { select: { id: true, name: true, status: true, startDate: true, endDate: true } },
} satisfies Prisma.PerformanceReviewInclude;

/** Adds a review for an employee who joined after the cycle was activated. */
export async function createPerformanceReview(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "performance.manage");
  const data = z.object({ cycleId: z.string().min(1), employeeId: z.string().min(1), reviewerId: z.string().uuid().nullish() }).parse(input);
  return prisma.$transaction(async (tx) => {
    const employee = await tx.employee.findFirst({ where: { id: data.employeeId, ...inScopeEmployee(ctx) } });
    if (!employee) throw new AppError("NOT_FOUND", "Employee not found", 404);
    const cycle = await tx.reviewCycle.findFirst({ where: { id: data.cycleId, companyId: employee.companyId } });
    if (!cycle) throw new AppError("INVALID_REFERENCE", "Review cycle not found in the employee's company", 422);
    if (cycle.status !== "ACTIVE") throw new AppError("INVALID_STATE", "Reviews are added to active cycles only", 422);
    if (data.reviewerId) {
      if (data.reviewerId === employee.userId) throw new AppError("VALIDATION_ERROR", "An employee cannot be their own reviewer", 422);
      const member = await tx.organizationMember.count({ where: { organizationId: ctx.organizationId, userId: data.reviewerId, status: "ACTIVE" } });
      if (!member) throw new AppError("INVALID_REFERENCE", "The reviewer must be an active member", 422);
    }
    const review = await tx.performanceReview.create({ data: { ...data, organizationId: ctx.organizationId }, include: reviewInclude });
    await audit(tx, ctx, { action: "performance_review.created", entity: "performance_review", entityId: review.id, companyId: employee.companyId, next: review });
    return review;
  });
}

export const REVIEW_ACTIONS = ["self", "manager"] as const;
export type ReviewAction = (typeof REVIEW_ACTIONS)[number];
const submissionSchema = z.object({ rating: z.coerce.number().int().min(1).max(5), comments: z.string().trim().max(5000).optional() });

export async function submitPerformanceReview(ctx: AccessContext, id: string, action: ReviewAction, input: unknown) {
  if (!REVIEW_ACTIONS.includes(action)) throw new AppError("NOT_FOUND", "Unknown action", 404);
  const data = submissionSchema.parse(input ?? {});
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "performance_reviews" WHERE "id" = ${id} FOR UPDATE`;
    const review = await tx.performanceReview.findFirst({ where: { AND: [{ id }, reviewWhere(ctx)] }, include: { ...reviewInclude, employee: true } });
    if (!review) throw new AppError("NOT_FOUND", "Review not found", 404);
    if (review.cycle.status !== "ACTIVE") throw new AppError("INVALID_STATE", "The review cycle is not active", 422);
    const self = review.employee.userId === ctx.userId;
    let update: Prisma.PerformanceReviewUpdateInput;
    if (action === "self") {
      if (!self) throw new AppError("FORBIDDEN", "Only the employee can submit a self review", 403);
      if (review.status !== "PENDING") throw new AppError("INVALID_STATE", `Cannot submit a self review when the review is ${review.status}`, 422);
      update = { selfRating: data.rating, selfComments: data.comments ?? null, status: "SELF_SUBMITTED" };
    } else {
      if (self) throw new AppError("FORBIDDEN", "You cannot give your own manager review", 403);
      const inScope = can(ctx, "performance.manage") && (await tx.employee.count({ where: { id: review.employeeId, ...inScopeEmployee(ctx) } })) > 0;
      if (review.reviewerId !== ctx.userId && !inScope) throw new AppError("FORBIDDEN", "Only the assigned reviewer can submit this review", 403);
      if (review.status !== "PENDING" && review.status !== "SELF_SUBMITTED") {
        throw new AppError("INVALID_STATE", `Cannot submit a manager review when the review is ${review.status}`, 422);
      }
      update = { managerRating: data.rating, managerComments: data.comments ?? null, status: "MANAGER_SUBMITTED", reviewerId: ctx.userId };
    }
    const updated = await tx.performanceReview.update({ where: { id }, data: update, include: reviewInclude });
    await audit(tx, ctx, { action: `performance_review.${action}`, entity: "performance_review", entityId: id, companyId: review.employee.companyId, previous: { status: review.status }, next: { status: updated.status, rating: data.rating } });
    return updated;
  });
}

/** Filter by employeeId for an employee's review history across cycles. */
export async function listPerformanceReviews(ctx: AccessContext, query: unknown) {
  const q = listQuerySchema.extend({ cycleId: z.string().optional(), employeeId: z.string().optional(), status: z.string().optional() }).parse(query);
  const where: Prisma.PerformanceReviewWhereInput = { AND: [reviewWhere(ctx), { cycleId: q.cycleId, employeeId: q.employeeId, status: q.status }] };
  return paginate(q, () =>
    Promise.all([
      prisma.performanceReview.findMany({ where, include: reviewInclude, ...listArgs(q, ["updatedAt"], "updatedAt") }),
      prisma.performanceReview.count({ where }),
    ]),
  );
}

export async function getPerformanceReview(ctx: AccessContext, id: string) {
  const review = await prisma.performanceReview.findFirst({ where: { AND: [{ id }, reviewWhere(ctx)] }, include: reviewInclude });
  if (!review) throw new AppError("NOT_FOUND", "Review not found", 404);
  return review;
}
