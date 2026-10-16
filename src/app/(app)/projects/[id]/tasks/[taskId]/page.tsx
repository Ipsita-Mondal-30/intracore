import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { CLOSED_PROJECT, getProject, TASK_PRIORITIES } from "@/features/projects/projects";
import { getTask, listTasks } from "@/features/projects/tasks";
import { listDocuments } from "@/features/documents/service";
import { DocumentDownload, DocumentUpload } from "@/features/finance/document-upload";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { dateInput, formatDate, formatDateTime, formatQty, humanize } from "@/components/erp/format";

const MOVES: Record<string, [string, string][]> = {
  TODO: [["IN_PROGRESS", "Start"], ["BLOCKED", "Blocked"], ["DONE", "Done"], ["CANCELLED", "Cancel"]],
  IN_PROGRESS: [["DONE", "Done"], ["BLOCKED", "Blocked"], ["TODO", "Back to to-do"], ["CANCELLED", "Cancel"]],
  BLOCKED: [["IN_PROGRESS", "Unblock"], ["TODO", "Back to to-do"], ["CANCELLED", "Cancel"]],
  DONE: [["IN_PROGRESS", "Reopen"]],
  CANCELLED: [["TODO", "Reopen"]],
};

export default async function TaskPage({ params }: { params: Promise<{ id: string; taskId: string }> }) {
  const { id, taskId } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "project.view")) notFound();
  const task = await getTask(ctx, taskId).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  if (task.projectId !== id) notFound();
  const [project, documents, siblings] = await Promise.all([
    getProject(ctx, id),
    can(ctx, "document.view") ? listDocuments(ctx, "project_task", taskId) : null,
    listTasks(ctx, { projectId: id, pageSize: 100, sort: "title", dir: "asc" }),
  ]);
  const canEdit = task.myRole !== "VIEWER" && !CLOSED_PROJECT.includes(project.status);
  const name = (u: { name: string | null; email: string } | null) => (u ? u.name ?? u.email : "—");
  const assignable = project.members.filter((m) => m.role !== "VIEWER");

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Projects", project.code, "Task"]}
        title={task.title}
        subtitle={`${project.name}${task.parent ? ` › ${task.parent.title}` : ""}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={task.status} />
            {canEdit
              ? MOVES[task.status]?.map(([status, label]) => (
                  <ActionButton key={status} path={`/project-tasks/${taskId}/status`} body={{ status }} label={label} variant={status === "CANCELLED" ? "ghost" : "secondary"} />
                ))
              : null}
          </div>
        }
      />
      <p className="text-sm"><Link href={`/projects/${id}`} className="text-primary hover:underline">← Back to project</Link></p>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>{canEdit ? "Edit task" : "Task"}</CardTitle></CardHeader>
            <CardContent>
              {canEdit ? (
                <ApiForm path={`/project-tasks/${taskId}`} method="PATCH" className="grid gap-3 sm:grid-cols-3">
                  <Field label="Title" className="sm:col-span-3"><Input name="title" defaultValue={task.title} required maxLength={300} /></Field>
                  <Field label="Assignee">
                    <Select name="assigneeId" defaultValue={task.assigneeId ?? ""} data-nullable>
                      <option value="">Unassigned</option>
                      {assignable.map((m) => <option key={m.userId} value={m.userId}>{name(m.user)}</option>)}
                    </Select>
                  </Field>
                  <Field label="Priority">
                    <Select name="priority" defaultValue={task.priority}>{TASK_PRIORITIES.map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</Select>
                  </Field>
                  <Field label="Due"><Input type="date" name="dueDate" defaultValue={dateInput(task.dueDate)} data-nullable /></Field>
                  <Field label="Milestone">
                    <Select name="milestoneId" defaultValue={task.milestoneId ?? ""} data-nullable>
                      <option value="">None</option>
                      {project.milestones.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </Select>
                  </Field>
                  <Field label="Estimate (hours)"><Input name="estimateHours" inputMode="decimal" defaultValue={task.estimateHours?.toString() ?? ""} data-nullable /></Field>
                  <Field label="Parent task">
                    <Select name="parentId" defaultValue={task.parentId ?? ""} data-nullable>
                      <option value="">None (top level)</option>
                      {siblings.items.filter((t) => t.id !== taskId).map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                    </Select>
                  </Field>
                  <Field label="Description" className="sm:col-span-3"><Textarea name="description" rows={4} defaultValue={task.description ?? ""} maxLength={10000} data-nullable /></Field>
                </ApiForm>
              ) : (
                <dl className="space-y-2 text-sm">
                  <div><dt className="text-subtle">Assignee</dt><dd>{name(task.assignee)}</dd></div>
                  <div><dt className="text-subtle">Priority</dt><dd>{humanize(task.priority)}</dd></div>
                  <div><dt className="text-subtle">Due</dt><dd>{formatDate(task.dueDate)}</dd></div>
                  {task.description ? <div><dt className="text-subtle">Description</dt><dd className="whitespace-pre-line">{task.description}</dd></div> : null}
                </dl>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Subtasks</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {task.subtasks.length === 0 ? <p className="text-sm text-muted">No subtasks.</p> : (
                <ul className="space-y-1 text-sm">
                  {task.subtasks.map((s) => (
                    <li key={s.id} className="flex items-center justify-between gap-2">
                      <Link href={`/projects/${id}/tasks/${s.id}`} className="text-primary hover:underline">{s.title}</Link>
                      <span className="flex items-center gap-2 text-2xs text-subtle">{name(s.assignee)} <StatusBadge status={s.status} /></span>
                    </li>
                  ))}
                </ul>
              )}
              {canEdit ? (
                <ApiForm path="/project-tasks" submitLabel="Add subtask" extra={{ projectId: id, parentId: taskId }} className="flex flex-wrap items-end gap-2 border-t border-[var(--ic-border)] pt-3">
                  <Input name="title" required maxLength={300} placeholder="Subtask title" aria-label="Subtask title" className="max-w-sm" />
                </ApiForm>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Comments</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {task.comments.length === 0 ? <p className="text-sm text-muted">No comments yet.</p> : (
                <ul className="space-y-3 text-sm">
                  {task.comments.map((c) => (
                    <li key={c.id}>
                      <p className="text-2xs text-subtle">{name(c.author)} · {formatDateTime(c.createdAt)}</p>
                      <p className="whitespace-pre-line">{c.body}</p>
                    </li>
                  ))}
                </ul>
              )}
              <ApiForm path={`/project-tasks/${taskId}/comments`} submitLabel="Comment" className="space-y-2 border-t border-[var(--ic-border)] pt-3">
                <Textarea name="body" rows={2} required maxLength={10000} aria-label="Comment" />
              </ApiForm>
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
                {can(ctx, "document.create") && canEdit ? <DocumentUpload entityType="project_task" entityId={taskId} /> : null}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div><dt className="text-subtle">Created</dt><dd>{name(task.createdBy)} · {formatDateTime(task.createdAt)}</dd></div>
                <div><dt className="text-subtle">Hours (est. / logged)</dt><dd>{formatQty(task.estimateHours)} / {formatQty(task.loggedHours)}</dd></div>
                {task.completedAt ? <div><dt className="text-subtle">Completed</dt><dd>{formatDateTime(task.completedAt)}</dd></div> : null}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Activity</CardTitle></CardHeader>
            <CardContent>
              {task.activity.length === 0 ? <p className="text-sm text-muted">No activity yet.</p> : (
                <ol className="space-y-2 text-sm">
                  {task.activity.map((a) => {
                    const prev = a.previous as { status?: string } | null;
                    const next = a.next as { status?: string } | null;
                    return (
                      <li key={a.id} className="flex flex-wrap items-baseline gap-x-2">
                        <span className="text-2xs text-subtle">{formatDateTime(a.createdAt)}</span>
                        <span className="font-medium">{humanize(a.action.split(".").pop() ?? a.action)}</span>
                        {prev?.status && next?.status ? <span className="text-muted">{humanize(prev.status)} → {humanize(next.status)}</span> : null}
                        <span className="text-2xs text-subtle">by {name(a.user)}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
