import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listSegments, SEGMENT_ENTITIES } from "@/features/marketing/segments";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { formatDateTime, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function SegmentsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = (
    <PageHeader
      breadcrumbs={["Communication", "Segments"]}
      title="Segments"
      subtitle="Saved audiences. Membership is evaluated when previewed and when a campaign sends."
      actions={can(ctx, "campaign.manage") ? <Link href="/communication/segments/new" className="text-sm text-primary hover:underline">New segment</Link> : null}
    />
  );
  if (!can(ctx, "campaign.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view segments.</p></div>;
  }
  const p = listParams(params, ["entity"]);
  const page = await listSegments(ctx, { ...p, entity: SEGMENT_ENTITIES.includes(p.entity as never) ? p.entity : undefined });
  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <ListToolbar params={params} placeholder="Search segments…" filters={[{ name: "entity", label: "Audience", options: SEGMENT_ENTITIES.map((e) => ({ value: e, label: humanize(e) })) }]} />
          <RecordsTable
            columns={[{ key: "name", label: "Segment" }, { key: "entity", label: "Audience" }, { key: "filters", label: "Filters" }, { key: "campaigns", label: "Campaigns" }, { key: "created", label: "Created" }]}
            empty="No segments yet."
          >
            {page.items.length
              ? page.items.map((s) => (
                  <RecordsTableRow key={s.id}>
                    <RecordsTableCell><Link href={`/communication/segments/${s.id}`} className="font-medium text-primary hover:underline">{s.name}</Link></RecordsTableCell>
                    <RecordsTableCell>{humanize(s.entity)}</RecordsTableCell>
                    <RecordsTableCell>{Array.isArray(s.filters) ? s.filters.length : 0}</RecordsTableCell>
                    <RecordsTableCell>{s._count.campaigns}</RecordsTableCell>
                    <RecordsTableCell>{formatDateTime(s.createdAt)}</RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/communication/segments" />
        </CardContent>
      </Card>
    </div>
  );
}
