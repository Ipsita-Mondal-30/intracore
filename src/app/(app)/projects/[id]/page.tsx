import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { CLOSED_PROJECT, getProject, PROJECT_ROLES, TASK_PRIORITIES } from "@/features/projects/projects";
import { listTasks } from "@/features/projects/tasks";
import { listTimeEntries } from "@/features/projects/time";
import { projectReport } from "@/features/projects/reports";
import { listDocuments } from "@/features/documents/service";
import { DocumentDownload, DocumentUpload } from "@/features/finance/document-upload";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { dateInput, formatDate, formatDateTime, formatMoney, formatQty, humanize } from "@/components/erp/format";

const ACTIONS: [string, string, string[]][] = [
  ["activate", "Activate", ["PLANNED", "ON_HOLD"]],
  ["hold", "Put on hold", ["ACTIVE"]],
  ["complete", "Complete", ["ACTIVE", "ON_HOLD"]],
  ["cancel", "Cancel", ["PLANNED", "ACTIVE", "ON_HOLD"]],
  ["reopen", "Reopen", ["COMPLETED", "CANCELLED"]],
];

export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "project.view")) notFound();
  const project = await getProject(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const role = project.myRole;
  const isManager = role === "MANAGER" || role === "OWNER";
  const isOpen = !CLOSED_PROJECT.includes(project.status);
  const canEditTasks = isOpen && role !== "VIEWER";
  const canLog = isOpen && project.isMember && project.members.find((m) => m.userId === ctx.userId)?.role !== "VIEWER";

  const [report, tasks, time, documents, orgMembers] = await Promise.all([
    projectReport(ctx, id),
    listTasks(ctx, { projectId: id, pageSize: 100, sort: "createdAt", dir: "asc" }),
    listTimeEntries(ctx, { projectId: id, pageSize: 20 }),
    can(ctx, "document.view") ? listDocuments(ctx, "project", id) : null,
    isManager ? prisma.organizationMember.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, select: { user: { select: { id: true, name: true, email: true } } } }) : [],
  ]);

  // Tasks in tree order: each parent followed by its subtasks.
  const children = new Map<string | null, typeof tasks.items>();
  for (const t of tasks.items) children.set(t.parentId, [...(children.get(t.parentId) ?? []), t]);
  const ids = new Set(tasks.items.map((t) => t.id));
  const tree: { task: (typeof tasks.items)[number]; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number) => {
    for (const t of children.get(parentId) ?? []) {
      tree.push({ task: t, depth });
      walk(t.id, depth + 1);
    }
  };
  walk(null, 0);
  // Subtasks whose parent isn't on this page still show.
  for (const t of tasks.items) if (t.parentId && !ids.has(t.parentId)) { tree.push({ task: t, depth: 1 }); walk(t.id, 2); }

  const assignable = project.members.filter((m) => m.role !== "VIEWER");
  const name = (u: { name: string | null; email: string } | null) => (u ? u.name ?? u.email : "—");

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Projects", project.code]}
        title={project.name}
        subtitle={`${project.code} · ${project.progress.percent}% complete · your role: ${humanize(role)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={project.status} />
            {isManager
              ? ACTIONS.filter(([, , from]) => from.includes(project.status)).map(([action, label]) => (
                  <ActionButton key={action} path={`/projects/${id}/${action}`} label={label} variant={action === "cancel" ? "ghost" : "secondary"} confirm={`${label} this project?`} />
                ))
              : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Progress and budget</CardTitle></CardHeader>
            <CardContent>
              <div className="mb-4 h-2 overflow-hidden rounded-full bg-skeleton" role="progressbar" aria-valuenow={report.progress.percent} aria-valuemin={0} aria-valuemax={100}>
                <div className="h-full bg-primary" style={{ width: `${report.progress.percent}%` }} />
              </div>
              <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                <div><dt className="text-subtle">Tasks done</dt><dd className="font-medium">{report.progress.done} / {report.progress.total}</dd></div>
                <div><dt className="text-subtle">Overdue tasks</dt><dd className="font-medium">{report.tasks.overdue}</dd></div>
                <div><dt className="text-subtle">Hours (est. / logged)</dt><dd className="font-medium">{formatQty(report.hours.estimated)} / {formatQty(report.hours.logged)}</dd></div>
                <div><dt className="text-subtle">Billable hours</dt><dd className="font-medium">{formatQty(report.hours.billable)}</dd></div>
                <div><dt className="text-subtle">Budget</dt><dd className="font-medium">{formatMoney(report.budget.budget)}</dd></div>
                <div><dt className="text-subtle">Actual cost</dt><dd className="font-medium">{formatMoney(report.budget.actualCost)}</dd></div>
                <div><dt className="text-subtle">Remaining</dt><dd className="font-medium">{formatMoney(report.budget.remaining)}</dd></div>
                <div><dt className="text-subtle">Budget used</dt><dd className="font-medium">{report.budget.usedPercent === null ? "—" : `${report.budget.usedPercent}%`}</dd></div>
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Tasks</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {tree.length === 0 ? (
                <p className="text-sm text-muted">No tasks yet.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                      <tr className="border-b border-[var(--ic-border)]">
                        <th className="py-2 pr-2">Task</th><th className="py-2 pr-2">Assignee</th><th className="py-2 pr-2">Priority</th><th className="py-2 pr-2">Due</th><th className="py-2">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tree.map(({ task: t, depth }) => (
                        <tr key={t.id} className="border-b border-[var(--ic-border)] last:border-0">
                          <td className="py-2 pr-2" style={{ paddingLeft: depth * 16 }}>
                            <Link href={`/projects/${id}/tasks/${t.id}`} className="text-primary hover:underline">{t.title}</Link>
                            {t.milestone ? <span className="ml-2 text-2xs text-subtle">{t.milestone.name}</span> : null}
                          </td>
                          <td className="py-2 pr-2">{name(t.assignee)}</td>
                          <td className="py-2 pr-2">{humanize(t.priority)}</td>
                          <td className="py-2 pr-2">{formatDate(t.dueDate)}</td>
                          <td className="py-2"><StatusBadge status={t.status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {tasks.total > tasks.items.length ? <p className="mt-2 text-2xs text-subtle">Showing {tasks.items.length} of {tasks.total} tasks.</p> : null}
                </div>
              )}
              {canEditTasks ? (
                <ApiForm path="/project-tasks" submitLabel="Add task" extra={{ projectId: id }} className="grid gap-3 border-t border-[var(--ic-border)] pt-4 sm:grid-cols-3">
                  <Field label="Title" className="sm:col-span-3"><Input name="title" required maxLength={300} /></Field>
                  <Field label="Parent task">
                    <Select name="parentId"><option value="">None</option>{tasks.items.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</Select>
                  </Field>
                  <Field label="Milestone">
                    <Select name="milestoneId"><option value="">None</option>{project.milestones.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</Select>
                  </Field>
                  <Field label="Assignee">
                    <Select name="assigneeId"><option value="">Unassigned</option>{assignable.map((m) => <option key={m.userId} value={m.userId}>{name(m.user)}</option>)}</Select>
                  </Field>
                  <Field label="Priority">
                    <Select name="priority" defaultValue="MEDIUM">{TASK_PRIORITIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</Select>
                  </Field>
                  <Field label="Due"><Input type="date" name="dueDate" /></Field>
                  <Field label="Estimate (hours)"><Input name="estimateHours" inputMode="decimal" /></Field>
                </ApiForm>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Time</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {time.items.length === 0 ? (
                <p className="text-sm text-muted">No time logged.</p>
              ) : (
                <ul className="divide-y divide-[var(--ic-border)] text-sm">
                  {time.items.map((e) => (
                    <li key={e.id} className="flex flex-wrap items-baseline justify-between gap-2 py-2">
                      <span>
                        <span className="font-medium">{formatQty(e.hours)} h</span> · {name(e.user)} · {formatDate(e.date)}
                        {e.task ? <span className="text-muted"> · {e.task.title}</span> : null}
                        {e.description ? <span className="block text-2xs text-subtle">{e.description}</span> : null}
                      </span>
                      <span className="flex items-center gap-2">
                        {e.billable ? <Badge tone="primary">Billable</Badge> : null}
                        {e.userId === ctx.userId || isManager ? <ActionButton path={`/time-entries/${e.id}`} method="DELETE" label="Delete" variant="ghost" confirm="Delete this time entry?" /> : null}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {canLog ? (
                <ApiForm path="/time-entries" submitLabel="Log time" extra={{ projectId: id }} className="grid gap-3 border-t border-[var(--ic-border)] pt-4 sm:grid-cols-4">
                  <Field label="Date"><Input type="date" name="date" required defaultValue={dateInput(new Date())} /></Field>
                  <Field label="Hours"><Input name="hours" required inputMode="decimal" placeholder="1.5" /></Field>
                  <Field label="Task">
                    <Select name="taskId"><option value="">No task</option>{tasks.items.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</Select>
                  </Field>
                  <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="billable" defaultChecked={project.billable} /> Billable</label>
                  <Field label="Description" className="sm:col-span-4"><Input name="description" maxLength={2000} /></Field>
                </ApiForm>
              ) : null}
            </CardContent>
          </Card>

          {documents ? (
            <Card>
              <CardHeader><CardTitle>Attachments</CardTitle></CardHeader>
              <CardContent className="space-y-3">
                {documents.length === 0 ? <p className="text-sm text-muted">No files attached.</p> : (
                  <ul className="space-y-1 text-sm">
                    {documents.map((d) => (
                      <li key={d.id} className="flex flex-wrap items-baseline gap-2">
                        <DocumentDownload id={d.id} label={d.fileName} />
                        <span className="text-2xs text-subtle">{Math.ceil(d.sizeBytes / 1024)} KB · {formatDateTime(d.createdAt)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {can(ctx, "document.create") && role !== "VIEWER" ? <DocumentUpload entityType="project" entityId={id} /> : null}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div><dt className="text-subtle">Manager</dt><dd>{name(project.manager)}</dd></div>
                <div><dt className="text-subtle">Customer</dt><dd>{project.customer?.name ?? "—"}</dd></div>
                <div><dt className="text-subtle">Dates</dt><dd>{formatDate(project.startDate)} – {formatDate(project.endDate)}</dd></div>
                <div><dt className="text-subtle">Hourly rate</dt><dd>{formatMoney(project.hourlyRate)}{project.billable ? " · billable" : ""}</dd></div>
                {project.description ? <div><dt className="text-subtle">Description</dt><dd className="whitespace-pre-line">{project.description}</dd></div> : null}
              </dl>
              {isManager && isOpen ? (
                <details className="mt-4 text-sm">
                  <summary className="cursor-pointer text-primary">Edit project</summary>
                  <ApiForm path={`/projects/${id}`} method="PATCH" className="mt-3 space-y-3">
                    <Field label="Name"><Input name="name" defaultValue={project.name} maxLength={200} /></Field>
                    <Field label="Start"><Input type="date" name="startDate" defaultValue={dateInput(project.startDate)} data-nullable /></Field>
                    <Field label="End"><Input type="date" name="endDate" defaultValue={dateInput(project.endDate)} data-nullable /></Field>
                    <Field label="Budget"><Input name="budget" inputMode="decimal" defaultValue={project.budget?.toString() ?? ""} data-nullable /></Field>
                    <Field label="Hourly rate"><Input name="hourlyRate" inputMode="decimal" defaultValue={project.hourlyRate?.toString() ?? ""} data-nullable /></Field>
                    <Field label="Manager">
                      <Select name="managerId" defaultValue={project.managerId}>{orgMembers.map((m) => <option key={m.user.id} value={m.user.id}>{name(m.user)}</option>)}</Select>
                    </Field>
                    <label className="flex items-center gap-2"><input type="checkbox" name="billable" defaultChecked={project.billable} /> Billable by default</label>
                  </ApiForm>
                </details>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Members</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <ul className="space-y-1 text-sm">
                {project.members.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2">
                    <span>{name(m.user)} <span className="text-2xs text-subtle">{humanize(m.role)}</span></span>
                    {isManager && m.userId !== project.managerId && (m.role !== "OWNER" || role === "OWNER") ? (
                      <ActionButton path={`/projects/${id}/remove-member`} body={{ userId: m.userId }} label="Remove" variant="ghost" confirm="Remove this member? Their open tasks become unassigned." />
                    ) : null}
                  </li>
                ))}
              </ul>
              {isManager ? (
                <ApiForm path={`/projects/${id}/members`} submitLabel="Add or update member" className="space-y-2 border-t border-[var(--ic-border)] pt-3">
                  <Select name="userId" required aria-label="Member">{orgMembers.map((m) => <option key={m.user.id} value={m.user.id}>{name(m.user)}</option>)}</Select>
                  <Select name="role" defaultValue="MEMBER" aria-label="Role">{PROJECT_ROLES.filter((r) => r !== "OWNER" || role === "OWNER").map((r) => <option key={r} value={r}>{humanize(r)}</option>)}</Select>
                </ApiForm>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Milestones</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {report.milestones.length === 0 ? <p className="text-sm text-muted">No milestones.</p> : (
                <ul className="space-y-2 text-sm">
                  {report.milestones.map((m) => (
                    <li key={m.id} className="flex items-center justify-between gap-2">
                      <span>
                        <span className={m.status === "DONE" ? "line-through" : "font-medium"}>{m.name}</span>
                        <span className="block text-2xs text-subtle">{formatDate(m.dueDate)} · {m.progress.done}/{m.progress.total} tasks</span>
                      </span>
                      {isManager ? (
                        <ActionButton path={`/projects/${id}/milestones/${m.id}`} method="PATCH" body={{ status: m.status === "DONE" ? "OPEN" : "DONE" }} label={m.status === "DONE" ? "Reopen" : "Done"} variant="ghost" />
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
              {isManager && isOpen ? (
                <ApiForm path={`/projects/${id}/milestones`} submitLabel="Add milestone" className="space-y-2 border-t border-[var(--ic-border)] pt-3">
                  <Input name="name" required maxLength={200} placeholder="Milestone name" aria-label="Milestone name" />
                  <Input type="date" name="dueDate" aria-label="Due date" />
                </ApiForm>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="project" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
