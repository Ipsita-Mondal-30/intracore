import Link from "next/link";
import { CommunicationType } from "@prisma/client";
import { can, getAccessContext } from "@/lib/access";
import { listMessages, LOG_STATUSES } from "@/features/communication/messages";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDateTime, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function MessagesPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = (
    <PageHeader
      breadcrumbs={["Communication", "Message log"]}
      title="Message log"
      subtitle="Every email, SMS and WhatsApp message sent or received. Simulated messages were handled by a mock provider and never left the system."
      actions={can(ctx, "communication.send") ? <Link href="/communication/messages/new" className="text-sm text-primary hover:underline">Send message</Link> : null}
    />
  );
  if (!can(ctx, "communication.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view messages.</p></div>;
  }
  const p = listParams(params, ["channel", "status", "direction"]);
  const page = await listMessages(ctx, {
    ...p,
    channel: p.channel && p.channel in CommunicationType ? p.channel : undefined,
    status: LOG_STATUSES.includes(p.status as never) ? p.status : undefined,
    direction: p.direction === "INBOUND" || p.direction === "OUTBOUND" ? p.direction : undefined,
  });

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search address or subject…"
            filters={[
              { name: "channel", label: "Channel", options: Object.values(CommunicationType).map((c) => ({ value: c, label: humanize(c) })) },
              { name: "status", label: "Status", options: LOG_STATUSES.map((s) => ({ value: s, label: humanize(s) })) },
              { name: "direction", label: "Direction", options: [{ value: "OUTBOUND", label: "Outbound" }, { value: "INBOUND", label: "Inbound" }] },
            ]}
          />
          <RecordsTable
            columns={[
              { key: "at", label: "When" },
              { key: "channel", label: "Channel" },
              { key: "address", label: "To / from" },
              { key: "template", label: "Template" },
              { key: "provider", label: "Provider" },
              { key: "status", label: "Status" },
            ]}
            empty="No messages yet."
          >
            {page.items.length
              ? page.items.map((m) => (
                  <RecordsTableRow key={m.id}>
                    <RecordsTableCell><Link href={`/communication/messages/${m.id}`} className="text-primary hover:underline">{formatDateTime(m.createdAt)}</Link></RecordsTableCell>
                    <RecordsTableCell>{humanize(m.channel)} {m.direction === "INBOUND" ? <Badge tone="neutral">Inbound</Badge> : null}</RecordsTableCell>
                    <RecordsTableCell>{m.direction === "INBOUND" ? m.fromAddress : m.toAddress}</RecordsTableCell>
                    <RecordsTableCell>{m.template?.name ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{m.provider}</RecordsTableCell>
                    <RecordsTableCell>
                      <StatusBadge status={m.status} /> {m.simulated ? <Badge tone="warning">Simulated</Badge> : null}
                    </RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/communication/messages" />
        </CardContent>
      </Card>
    </div>
  );
}
