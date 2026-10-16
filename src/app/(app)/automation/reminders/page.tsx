import { can, getAccessContext } from "@/lib/access";
import { listReminders } from "@/features/notifications/reminders";
import { ReminderForm } from "@/features/notifications/reminder-form";
import { memberOptions, userNames } from "@/features/service/lookups";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { ActionButton } from "@/components/erp/action-button";
import { formatDateTime, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function RemindersPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const page = await listReminders(ctx, listParams(params, ["active"]));
  const viewAll = can(ctx, "task.view_all");
  const [names, members] = await Promise.all([
    userNames(page.items.map((r) => r.userId)),
    viewAll ? memberOptions(ctx) : Promise.resolve([]),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Automation", "Reminders"]}
        title="Reminders"
        subtitle="One-off and recurring reminders, delivered as in-app notifications. Missed occurrences fire once when the scheduler catches up."
      />
      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search reminders"
            filters={[{ name: "active", label: "Status", options: [{ value: "true", label: "Active" }, { value: "false", label: "Finished / paused" }] }]}
          />
          <RecordsTable
            columns={[
              { key: "title", label: "Reminder" },
              ...(viewAll ? [{ key: "for", label: "For" }] : []),
              { key: "next", label: "Next" },
              { key: "repeat", label: "Repeat" },
              { key: "fired", label: "Fired" },
              { key: "actions", label: "" },
            ]}
            empty="No reminders yet."
          >
            {page.items.length
              ? page.items.map((r) => (
                  <RecordsTableRow key={r.id}>
                    <RecordsTableCell>
                      <div className="font-medium">{r.title}</div>
                      {r.body ? <div className="text-2xs text-subtle">{r.body}</div> : null}
                    </RecordsTableCell>
                    {viewAll ? <RecordsTableCell>{names.get(r.userId) ?? "—"}</RecordsTableCell> : null}
                    <RecordsTableCell>{r.isActive ? formatDateTime(r.nextRunAt) : <span className="text-subtle">{r.fireCount ? "Finished" : "Paused"}</span>}</RecordsTableCell>
                    <RecordsTableCell>
                      {r.recurrence === "NONE" ? "Once" : `${humanize(r.recurrence)}${r.interval > 1 ? ` × ${r.interval}` : ""}`}
                      {r.endsAt ? <div className="text-2xs text-subtle">until {formatDateTime(r.endsAt)}</div> : null}
                    </RecordsTableCell>
                    <RecordsTableCell>{r.fireCount}{r.lastFiredAt ? <div className="text-2xs text-subtle">{formatDateTime(r.lastFiredAt)}</div> : null}</RecordsTableCell>
                    <RecordsTableCell>
                      <div className="flex gap-2">
                        {r.isActive ? (
                          <ActionButton path={`/reminders/${r.id}`} method="PATCH" body={{ isActive: false }} label="Pause" />
                        ) : r.nextRunAt > new Date() ? (
                          <ActionButton path={`/reminders/${r.id}`} method="PATCH" body={{ isActive: true }} label="Resume" />
                        ) : null}
                        <ActionButton path={`/reminders/${r.id}`} method="DELETE" label="Delete" confirm="Delete this reminder?" variant="ghost" />
                      </div>
                    </RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/automation/reminders" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>New reminder</CardTitle></CardHeader>
        <CardContent>
          <ReminderForm members={viewAll ? members.filter((m) => m.id !== ctx.userId) : undefined} />
        </CardContent>
      </Card>
    </div>
  );
}
