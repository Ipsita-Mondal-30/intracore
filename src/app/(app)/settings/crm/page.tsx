import { can, getAccessContext } from "@/lib/access";
import { getCrmSettings } from "@/features/customers/service";
import { DuplicateRulesForm } from "@/features/customers/duplicate-rules-form";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function CrmSettingsPage() {
  const ctx = await getAccessContext();
  const settings = await getCrmSettings(ctx);

  return (
    <div className="space-y-4">
      <PageHeader breadcrumbs={["Settings", "CRM"]} title="CRM" subtitle="Duplicate detection when creating customers and leads, and on lead conversion." />
      <Card>
        <CardHeader><CardTitle>Duplicate matching rules</CardTitle></CardHeader>
        <CardContent>
          <DuplicateRulesForm rules={settings.duplicates} canEdit={can(ctx, "crm.administer")} />
        </CardContent>
      </Card>
    </div>
  );
}
