import { prisma } from "@/lib/db/prisma";
import type { AccessContext } from "@/lib/access";
import { Decimal, money } from "@/lib/money";
import { progressOf, projectAccess, taskCountsByProject, userNames } from "@/features/projects/projects";

/**
 * Status, progress and budget report for one project.
 * - progress: DONE tasks / all non-cancelled tasks (count-based, subtasks included)
 * - actualCost = all logged hours × project hourlyRate; billableAmount = billable hours × rate
 * - budgetUsedPercent = actualCost / budget (null without a budget or rate)
 * Amounts are decimal strings.
 */
export async function projectReport(ctx: AccessContext, projectId: string) {
  const { project } = await projectAccess(prisma, ctx, projectId);
  const [counts, estimates, hoursByBillable, hoursByUser, milestones, overdue] = await Promise.all([
    taskCountsByProject(prisma, [projectId]),
    prisma.projectTask.groupBy({ by: ["status"], where: { projectId, status: { not: "CANCELLED" } }, _sum: { estimateHours: true } }),
    prisma.timeEntry.groupBy({ by: ["billable"], where: { projectId }, _sum: { hours: true } }),
    prisma.timeEntry.groupBy({ by: ["userId"], where: { projectId }, _sum: { hours: true } }),
    prisma.milestone.findMany({ where: { projectId }, include: { tasks: { select: { status: true } } }, orderBy: [{ dueDate: "asc" }, { name: "asc" }] }),
    prisma.projectTask.count({ where: { projectId, status: { notIn: ["DONE", "CANCELLED"] }, dueDate: { lt: new Date() } } }),
  ]);

  const sum = (rows: { _sum: { hours?: Decimal | null; estimateHours?: Decimal | null } }[], key: "hours" | "estimateHours") =>
    rows.reduce((s, r) => s.add(r._sum[key] ?? 0), new Decimal(0));
  const totalHours = sum(hoursByBillable, "hours");
  const billableHours = sum(hoursByBillable.filter((r) => r.billable), "hours");
  const rate = project.hourlyRate;
  const actualCost = rate ? money(totalHours.mul(rate)) : null;
  const users = await userNames(hoursByUser.map((r) => r.userId));

  return {
    project: { id: project.id, code: project.code, name: project.name, status: project.status, startDate: project.startDate, endDate: project.endDate },
    tasks: { byStatus: counts.get(projectId) ?? {}, overdue },
    progress: progressOf(counts.get(projectId) ?? {}),
    hours: {
      estimated: sum(estimates, "estimateHours").toString(),
      estimatedDone: sum(estimates.filter((r) => r.status === "DONE"), "estimateHours").toString(),
      logged: totalHours.toString(),
      billable: billableHours.toString(),
      nonBillable: totalHours.sub(billableHours).toString(),
      byUser: hoursByUser.map((r) => ({ userId: r.userId, user: users.get(r.userId) ?? null, hours: (r._sum.hours ?? new Decimal(0)).toString() })),
    },
    budget: {
      budget: project.budget?.toString() ?? null,
      hourlyRate: rate?.toString() ?? null,
      actualCost: actualCost?.toString() ?? null,
      billableAmount: rate ? money(billableHours.mul(rate)).toString() : null,
      remaining: project.budget && actualCost ? project.budget.sub(actualCost).toString() : null,
      usedPercent: project.budget && actualCost && project.budget.gt(0) ? actualCost.div(project.budget).mul(100).toDecimalPlaces(1).toNumber() : null,
    },
    milestones: milestones.map((m) => ({
      id: m.id,
      name: m.name,
      dueDate: m.dueDate,
      status: m.status,
      progress: progressOf(m.tasks.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {})),
    })),
  };
}
