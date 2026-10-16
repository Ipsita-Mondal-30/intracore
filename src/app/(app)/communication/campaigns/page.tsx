import Link from "next/link";
import { CommunicationType } from "@prisma/client";
import { can, getAccessContext } from "@/lib/access";
import { CAMPAIGN_STATUSES, listCampaigns } from "@/features/marketing/campaigns";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDateTime, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function CampaignsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = (
    <PageHeader
      breadcrumbs={["Communication", "Campaigns"]}
      title="Campaigns"
      subtitle="Messages to a segment, sent after approval. Only recipients with consent are messaged."
      actions={can(ctx, "campaign.manage") ? <Link href="/communication/campaigns/new" className="text-sm text-primary hover:underline">New campaign</Link> : null}
    />
  );
  if (!can(ctx, "campaign.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view campaigns.</p></div>;
  }
  const p = listParams(params, ["status", "channel"]);
  const page = await listCampaigns(ctx, {
    ...p,
    status: CAMPAIGN_STATUSES.includes(p.status as never) ? p.status : undefined,
    channel: p.channel && p.channel in CommunicationType ? p.channel : undefined,
  });

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search campaigns…"
            filters={[
              { name: "status", label: "Status", options: CAMPAIGN_STATUSES.map((s) => ({ value: s, label: humanize(s) })) },
              { name: "channel", label: "Channel", options: Object.values(CommunicationType).map((s) => ({ value: s, label: humanize(s) })) },
            ]}
          />
          <RecordsTable
            columns={[
              { key: "name", label: "Campaign" },
              { key: "channel", label: "Channel" },
              { key: "segment", label: "Segment" },
              { key: "template", label: "Template" },
              { key: "scheduled", label: "Scheduled" },
              { key: "recipients", label: "Recipients" },
              { key: "status", label: "Status" },
            ]}
            empty="No campaigns yet."
          >
            {page.items.length
              ? page.items.map((c) => (
                  <RecordsTableRow key={c.id}>
                    <RecordsTableCell><Link href={`/communication/campaigns/${c.id}`} className="font-medium text-primary hover:underline">{c.name}</Link></RecordsTableCell>
                    <RecordsTableCell>{humanize(c.channel)}</RecordsTableCell>
                    <RecordsTableCell>{c.segment.name}</RecordsTableCell>
                    <RecordsTableCell>{c.template.name}</RecordsTableCell>
                    <RecordsTableCell>{formatDateTime(c.scheduledAt)}</RecordsTableCell>
                    <RecordsTableCell>{c._count.recipients}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={c.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/communication/campaigns" />
        </CardContent>
      </Card>
    </div>
  );
}
