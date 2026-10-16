import Link from "next/link";
import { LeadPriority } from "@prisma/client";
import { can, getAccessContext } from "@/lib/access";
import { listTickets, TICKET_STATUSES } from "@/features/service/tickets";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDateTime, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function TicketsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = (
    <PageHeader
      breadcrumbs={["Service", "Tickets"]}
      title="Service tickets"
      subtitle={can(ctx, "ticket.assign") ? "All tickets in your companies." : "Tickets assigned to or raised by you."}
      actions={can(ctx, "ticket.create") ? <Link href="/service/tickets/new" className="text-sm text-primary hover:underline">New ticket</Link> : null}
    />
  );
  if (!can(ctx, "ticket.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view tickets.</p></div>;
  }
  const p = listParams(params, ["status", "priority", "view"]);
  const page = await listTickets(ctx, {
    ...p,
    status: TICKET_STATUSES.includes(p.status as never) ? p.status : undefined,
    priority: p.priority && p.priority in LeadPriority ? p.priority : undefined,
    open: p.view === "open" ? "true" : undefined,
    mine: p.view === "mine" ? "true" : undefined,
    breached: p.view === "breached" ? "true" : undefined,
    view: undefined,
  });
  const now = Date.now();

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search number or subject…"
            filters={[
              { name: "view", label: "View", options: [{ value: "open", label: "Open" }, { value: "mine", label: "Assigned to me" }, { value: "breached", label: "SLA breached" }] },
              { name: "status", label: "Status", options: TICKET_STATUSES.map((s) => ({ value: s, label: humanize(s) })) },
              { name: "priority", label: "Priority", options: Object.values(LeadPriority).map((s) => ({ value: s, label: humanize(s) })) },
            ]}
          />
          <RecordsTable
            columns={[
              { key: "number", label: "Ticket" },
              { key: "subject", label: "Subject" },
              { key: "customer", label: "Customer" },
              { key: "assignee", label: "Assignee" },
              { key: "priority", label: "Priority" },
              { key: "due", label: "Resolve by" },
              { key: "status", label: "Status" },
            ]}
            empty="No tickets match."
          >
            {page.items.length
              ? page.items.map((t) => {
                  const overdue = t.resolutionDueAt && !["RESOLVED", "CLOSED", "CANCELLED"].includes(t.status) && t.resolutionDueAt.getTime() < now;
                  return (
                    <RecordsTableRow key={t.id}>
                      <RecordsTableCell><Link href={`/service/tickets/${t.id}`} className="font-medium text-primary hover:underline">{t.number}</Link></RecordsTableCell>
                      <RecordsTableCell>{t.subject}</RecordsTableCell>
                      <RecordsTableCell>{t.customer?.name ?? "—"}</RecordsTableCell>
                      <RecordsTableCell>{t.assignee ? t.assignee.name ?? t.assignee.email : "Unassigned"}</RecordsTableCell>
                      <RecordsTableCell>{humanize(t.priority)}</RecordsTableCell>
                      <RecordsTableCell>
                        {formatDateTime(t.resolutionDueAt)} {overdue ? <Badge tone="danger">Overdue</Badge> : null}
                      </RecordsTableCell>
                      <RecordsTableCell><StatusBadge status={t.status} /></RecordsTableCell>
                    </RecordsTableRow>
                  );
                })
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/service/tickets" />
        </CardContent>
      </Card>
    </div>
  );
}
