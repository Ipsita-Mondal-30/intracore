import { can, getAccessContext } from "@/lib/access";
import { listBackgroundJobs, listJobRuns, listWebhookEvents } from "@/features/integrations/jobs";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { param } from "@/components/erp/list-controls";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDateTime, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const JOB_STATUSES = ["DEAD", "PENDING", "RUNNING", "SUCCEEDED", "CANCELLED"];
const EVENT_STATUSES = ["FAILED", "RECEIVED", "PROCESSED", "IGNORED"];

export default async function JobsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Settings", "Jobs & webhooks"]} title="Jobs & webhooks" subtitle="Background deliveries and webhook events for this organization. Failed items can be replayed." />;
  if (!can(ctx, "job.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view jobs.</p></div>;
  }
  const jobStatus = param(params, "jobStatus") ?? "DEAD";
  const eventStatus = param(params, "eventStatus") ?? "FAILED";
  const [jobs, events, runs] = await Promise.all([
    listBackgroundJobs(ctx, { status: JOB_STATUSES.includes(jobStatus) ? jobStatus : "DEAD", pageSize: 50 }),
    listWebhookEvents(ctx, { status: EVENT_STATUSES.includes(eventStatus) ? eventStatus : "FAILED", pageSize: 50 }),
    listJobRuns(ctx, { pageSize: 20 }),
  ]);
  const replay = can(ctx, "job.replay");

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <form method="get" className="flex flex-wrap items-center gap-2">
            <Select name="jobStatus" defaultValue={jobStatus} className="max-w-[220px]" aria-label="Job status">
              {JOB_STATUSES.map((s) => <option key={s} value={s}>Jobs: {humanize(s)}</option>)}
            </Select>
            <Select name="eventStatus" defaultValue={eventStatus} className="max-w-[260px]" aria-label="Webhook event status">
              {EVENT_STATUSES.map((s) => <option key={s} value={s}>Webhook events: {humanize(s)}</option>)}
            </Select>
            <Button type="submit" size="sm" variant="secondary">Apply</Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Background jobs ({jobs.total})</CardTitle></CardHeader>
        <CardContent>
          <RecordsTable
            columns={[
              { key: "type", label: "Type" },
              { key: "status", label: "Status" },
              { key: "attempts", label: "Attempts" },
              { key: "error", label: "Last error" },
              { key: "updated", label: "Updated" },
              { key: "actions", label: "" },
            ]}
            empty="No jobs."
          >
            {jobs.items.length
              ? jobs.items.map((j) => (
                  <RecordsTableRow key={j.id}>
                    <RecordsTableCell>{j.type}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={j.status} /></RecordsTableCell>
                    <RecordsTableCell>{j.attempts}/{j.maxAttempts}</RecordsTableCell>
                    <RecordsTableCell className="max-w-md break-words text-xs">{j.lastError ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{formatDateTime(j.updatedAt)}</RecordsTableCell>
                    <RecordsTableCell>{replay && j.status === "DEAD" ? <ActionButton path={`/background-jobs/${j.id}/replay`} label="Replay" confirm="Run this job again?" /> : null}</RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Webhook events ({events.total})</CardTitle></CardHeader>
        <CardContent>
          <RecordsTable
            columns={[
              { key: "provider", label: "Provider" },
              { key: "id", label: "Event" },
              { key: "status", label: "Status" },
              { key: "error", label: "Note / error" },
              { key: "received", label: "Received" },
              { key: "actions", label: "" },
            ]}
            empty="No webhook events."
          >
            {events.items.length
              ? events.items.map((e) => (
                  <RecordsTableRow key={e.id}>
                    <RecordsTableCell>{e.provider}</RecordsTableCell>
                    <RecordsTableCell className="max-w-xs break-all text-xs">{e.externalId}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={e.status} /></RecordsTableCell>
                    <RecordsTableCell className="max-w-md break-words text-xs">{e.error ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{formatDateTime(e.receivedAt)}</RecordsTableCell>
                    <RecordsTableCell>{replay && e.status === "FAILED" ? <ActionButton path={`/webhook-events/${e.id}/replay`} label="Replay" confirm="Process this event again?" /> : null}</RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Scheduler runs</CardTitle></CardHeader>
        <CardContent>
          <RecordsTable columns={[{ key: "name", label: "Job" }, { key: "status", label: "Status" }, { key: "started", label: "Started" }, { key: "finished", label: "Finished" }]} empty="No runs recorded.">
            {runs.items.length
              ? runs.items.map((r) => (
                  <RecordsTableRow key={r.id}>
                    <RecordsTableCell>{r.name}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={r.status} /></RecordsTableCell>
                    <RecordsTableCell>{formatDateTime(r.startedAt)}</RecordsTableCell>
                    <RecordsTableCell>{formatDateTime(r.finishedAt)}</RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
        </CardContent>
      </Card>
    </div>
  );
}
