import Link from "next/link";
import { CommunicationType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { CampaignFields } from "../campaign-fields";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { ApiForm } from "@/components/erp/api-form";

export default async function NewCampaignPage() {
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Communication", "Campaigns", "New"]} title="New campaign" subtitle="Drafts can be edited until they are submitted for approval." />;
  if (!can(ctx, "campaign.manage")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to create campaigns.</p></div>;
  }
  const [templates, segments] = await Promise.all([
    prisma.messageTemplate.findMany({ where: { organizationId: ctx.organizationId, isActive: true }, select: { id: true, name: true, channel: true, category: true }, orderBy: { name: "asc" } }),
    prisma.segment.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true, name: true, entity: true }, orderBy: { name: "asc" } }),
  ]);
  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          {templates.length === 0 || segments.length === 0 ? (
            <p className="text-sm text-muted">
              A campaign needs a message template and a <Link href="/communication/segments" className="text-primary hover:underline">segment</Link>. Create them first.
            </p>
          ) : (
            <ApiForm path="/campaigns" submitLabel="Create draft" redirect="/communication/campaigns/:id" className="grid gap-3 sm:grid-cols-2">
              <CampaignFields templates={templates} segments={segments} channels={Object.values(CommunicationType)} />
            </ApiForm>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
