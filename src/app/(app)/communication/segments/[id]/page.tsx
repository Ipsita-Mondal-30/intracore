import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getSegment, segmentFieldCatalog } from "@/features/marketing/segments";
import { SegmentBuilder } from "../segment-builder";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { ActionButton } from "@/components/erp/action-button";
import { humanize } from "@/components/erp/format";

export default async function SegmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "campaign.view")) notFound();
  const segment = await getSegment(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const canEdit = can(ctx, "campaign.manage");
  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Communication", "Segments", segment.name]}
        title={segment.name}
        subtitle={`${humanize(segment.entity)} segment`}
        actions={canEdit ? <ActionButton path={`/segments/${id}`} method="DELETE" label="Delete" variant="ghost" confirm="Delete this segment?" redirectTo="/communication/segments" /> : null}
      />
      <Card>
        <CardContent className="pt-5">
          <SegmentBuilder
            catalog={segmentFieldCatalog()}
            segment={{ id: segment.id, name: segment.name, entity: segment.entity, filters: Array.isArray(segment.filters) ? (segment.filters as { field: string; op: string; value?: unknown }[]) : [] }}
            canEdit={canEdit}
          />
        </CardContent>
      </Card>
    </div>
  );
}
