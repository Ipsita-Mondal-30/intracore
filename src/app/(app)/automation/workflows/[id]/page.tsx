import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getWorkflow, getWorkflowRun, listWorkflowRuns } from "@/features/automation/workflows";
import { TRIGGER_CATALOG } from "@/features/automation/catalog";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { Pagination, param } from "@/components/erp/list-controls";
import { formatDateTime } from "@/components/erp/format";
import { WorkflowBuilder, WorkflowTestPanel, type BuilderInitial } from "../workflow-builder";
import { builderData } from "../builder-data";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const orNotFound = (e: unknown): never => {
  if (isAppError(e) && e.status === 404) notFound();
  throw e;
};

export default async function WorkflowPage({ params, searchParams }: Props) {
  const { id } = await params;
  const search = await searchParams;
  const ctx = await getAccessContext();
  if (!can(ctx, "workflow.view")) notFound();
  const wf = await getWorkflow(ctx, id).catch(orNotFound);
  const runId = param(search, "run");
  const [runs, run, builder] = await Promise.all([
    listWorkflowRuns(ctx, { workflowId: id, page: param(search, "page") ?? "1", pageSize: "20" }),
    runId ? getWorkflowRun(ctx, runId).catch(orNotFound) : null,
    can(ctx, "workflow.manage") ? builderData(ctx) : null,
  ]);
  const fields = Object.keys(TRIGGER_CATALOG[wf.triggerEntity]?.fields ?? {});
  const sample = JSON.stringify(Object.fromEntries(fields.slice(0, 4).map((f) => [f, ""])), null, 2);

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Automation", "Workflows", wf.name]}
        title={wf.name}
        subtitle={`${TRIGGER_CATALOG[wf.triggerEntity]?.label ?? wf.triggerEntity} · ${wf.triggerAction}${wf.description ? ` · ${wf.description}` : ""}`}
        actions={
          <div className="flex items-center gap-2">
            {wf.isEnabled ? <Badge tone="success">Enabled</Badge> : <Badge tone="neutral">Disabled</Badge>}
            {builder ? <ActionButton path={`/workflows/${id}`} method="PATCH" body={{ isEnabled: !wf.isEnabled }} label={wf.isEnabled ? "Disable" : "Enable"} /> : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {run ? (
            <Card>
              <CardHeader><CardTitle>Run {formatDateTime(run.startedAt)} · <StatusBadge status={run.status} /></CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {run.error ? <p className="rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">{run.error}</p> : null}
                <ol className="space-y-2">
                  {run.events.map((e) => (
                    <li key={e.id} className="rounded-xl border border-[var(--ic-border)] px-3 py-2">
                      <p className="flex flex-wrap items-center gap-2 text-2xs text-subtle">
                        <span>{e.kind}</span><StatusBadge status={e.status === "OK" ? "COMPLETED" : e.status} /><span>{formatDateTime(e.createdAt)}</span>
                      </p>
                      <p>{e.message}</p>
                      {e.data ? <pre className="mt-1 overflow-auto text-2xs text-subtle">{JSON.stringify(e.data)}</pre> : null}
                    </li>
                  ))}
                </ol>
                {run.approvals.length ? (
                  <p className="text-xs text-subtle">Approvals: {run.approvals.map((a) => `step ${a.stepIndex + 1} ${a.status.toLowerCase()}`).join(", ")}</p>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader><CardTitle>Run history</CardTitle></CardHeader>
            <CardContent>
              <RecordsTable
                columns={[{ key: "started", label: "Started" }, { key: "record", label: "Record" }, { key: "status", label: "Status" }, { key: "finished", label: "Finished" }]}
                empty="No runs yet."
              >
                {runs.items.length
                  ? runs.items.map((r) => (
                      <RecordsTableRow key={r.id}>
                        <RecordsTableCell><Link href={`/automation/workflows/${id}?run=${r.id}`} className="text-primary hover:underline">{formatDateTime(r.startedAt)}</Link></RecordsTableCell>
                        <RecordsTableCell>{r.entityType} {r.entityId ?? ""}</RecordsTableCell>
                        <RecordsTableCell><StatusBadge status={r.status} /></RecordsTableCell>
                        <RecordsTableCell>{formatDateTime(r.finishedAt)}</RecordsTableCell>
                      </RecordsTableRow>
                    ))
                  : undefined}
              </RecordsTable>
              <Pagination {...runs} params={search} basePath={`/automation/workflows/${id}`} />
            </CardContent>
          </Card>

          {builder ? (
            <Card>
              <CardHeader><CardTitle>Edit</CardTitle></CardHeader>
              <CardContent><WorkflowBuilder {...builder} workflowId={id} initial={wf as unknown as BuilderInitial} /></CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Test (dry run)</CardTitle></CardHeader>
            <CardContent>
              <p className="mb-2 text-xs text-subtle">A sample `next` snapshot. Conditions are evaluated and planned actions listed; nothing runs.</p>
              <WorkflowTestPanel workflowId={id} sample={sample} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Definition</CardTitle></CardHeader>
            <CardContent>
              <pre className="overflow-auto text-2xs">{JSON.stringify({ conditions: wf.conditions, actions: wf.actions, approvalSteps: wf.approvalSteps }, null, 2)}</pre>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
