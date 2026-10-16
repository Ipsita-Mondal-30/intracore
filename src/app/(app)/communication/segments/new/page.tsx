import { can, getAccessContext } from "@/lib/access";
import { segmentFieldCatalog } from "@/features/marketing/segments";
import { SegmentBuilder } from "../segment-builder";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";

export default async function NewSegmentPage() {
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Communication", "Segments", "New"]} title="New segment" />;
  if (!can(ctx, "campaign.manage")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to create segments.</p></div>;
  }
  return (
    <div className="space-y-4">
      {header}
      <Card><CardContent className="pt-5"><SegmentBuilder catalog={segmentFieldCatalog()} canEdit /></CardContent></Card>
    </div>
  );
}
