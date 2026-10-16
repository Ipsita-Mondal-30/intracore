import { can, getAccessContext } from "@/lib/access";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { WorkflowBuilder } from "../workflow-builder";
import { builderData } from "../builder-data";

export default async function NewWorkflowPage() {
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Automation", "Workflows", "New"]} title="New workflow" subtitle="Rules are data: triggers, conditions and actions come from fixed allowlists." />;
  if (!can(ctx, "workflow.manage")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to manage workflows.</p></div>;
  }
  return (
    <div className="space-y-4">
      {header}
      <Card><CardContent className="pt-5"><WorkflowBuilder {...await builderData(ctx)} /></CardContent></Card>
    </div>
  );
}
