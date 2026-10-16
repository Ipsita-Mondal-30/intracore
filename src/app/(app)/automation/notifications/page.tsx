import Link from "next/link";
import { getAccessContext } from "@/lib/access";
import { getPreferences, listNotificationHistory, notificationTypes } from "@/features/notifications/history";
import { NotificationPreferencesForm } from "@/features/notifications/preferences-form";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { ActionButton } from "@/components/erp/action-button";
import { formatDateTime } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Only same-origin relative links from notification data are rendered. */
const safeHref = (data: unknown) => {
  const href = (data as { href?: unknown } | null)?.href;
  return typeof href === "string" && href.startsWith("/") && !href.startsWith("//") ? href : null;
};

export default async function NotificationHistoryPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const [page, types, prefs] = await Promise.all([
    listNotificationHistory(ctx, listParams(params, ["unread", "type", "from", "to"])),
    notificationTypes(ctx),
    getPreferences(ctx),
  ]);

  return (
    <div className="space-y-4">
      <PageHeader breadcrumbs={["Automation", "Notification history"]} title="Notification history" subtitle={`${page.unread} unread`} />
      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search notifications"
            filters={[
              { name: "unread", label: "Read state", options: [{ value: "true", label: "Unread" }, { value: "false", label: "Read" }] },
              { name: "type", label: "Type", options: types.map((t) => ({ value: t, label: t })) },
            ]}
          >
            <Input type="date" name="from" defaultValue={param(params, "from") ?? ""} className="max-w-[160px]" aria-label="From date" />
            <Input type="date" name="to" defaultValue={param(params, "to") ?? ""} className="max-w-[160px]" aria-label="To date" />
          </ListToolbar>
          {page.unread > 0 ? (
            <div className="mb-3">
              <ActionButton path="/notifications/read-all" label="Mark all read" />
            </div>
          ) : null}
          <RecordsTable
            columns={[{ key: "title", label: "Notification" }, { key: "type", label: "Type" }, { key: "when", label: "When" }, { key: "actions", label: "" }]}
            empty="No notifications."
          >
            {page.items.length
              ? page.items.map((n) => {
                  const href = safeHref(n.data);
                  return (
                    <RecordsTableRow key={n.id}>
                      <RecordsTableCell>
                        <div className={n.readAt ? "" : "font-semibold"}>
                          {href ? <Link href={href} className="hover:underline">{n.title}</Link> : n.title}
                        </div>
                        {n.body ? <div className="text-2xs text-subtle">{n.body}</div> : null}
                      </RecordsTableCell>
                      <RecordsTableCell className="font-mono text-2xs">{n.type}</RecordsTableCell>
                      <RecordsTableCell>{formatDateTime(n.createdAt)}</RecordsTableCell>
                      <RecordsTableCell>{n.readAt ? null : <ActionButton path={`/notifications/${n.id}/read`} label="Mark read" variant="ghost" />}</RecordsTableCell>
                    </RecordsTableRow>
                  );
                })
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/automation/notifications" />
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Preferences</CardTitle></CardHeader>
        <CardContent>
          <NotificationPreferencesForm prefs={prefs} />
        </CardContent>
      </Card>
    </div>
  );
}
