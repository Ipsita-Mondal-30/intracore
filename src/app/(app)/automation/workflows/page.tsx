import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listWorkflows } from "@/features/automation/workflows";
import { TRIGGER_CATALOG } from "@/features/automation/catalog";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { formatDateTime } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function WorkflowsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = (
    <PageHeader
      breadcrumbs={["Automation", "Workflows"]}
      title="Workflows"
      subtitle="Event-driven rules: when a record event happens and the conditions hold, run the actions."
      actions={can(ctx, "workflow.manage") ? <Link href="/automation/workflows/new" className="text-sm text-primary hover:underline">New workflow</Link> : null}
    />
  );
  if (!can(ctx, "workflow.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view workflows.</p></div>;
  }
  const p = listParams(params, ["triggerEntity", "enabled"]);
  const page = await listWorkflows(ctx, {
    ...p,
    triggerEntity: p.triggerEntity && p.triggerEntity in TRIGGER_CATALOG ? p.triggerEntity : undefined,
    enabled: p.enabled === "true" || p.enabled === "false" ? p.enabled : undefined,
  });
  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search name…"
            filters={[
              { name: "triggerEntity", label: "Record", options: Object.entries(TRIGGER_CATALOG).map(([value, d]) => ({ value, label: d.label })) },
              { name: "enabled", label: "State", options: [{ value: "true", label: "Enabled" }, { value: "false", label: "Disabled" }] },
            ]}
          />
          <RecordsTable
            columns={[
              { key: "name", label: "Workflow" },
              { key: "trigger", label: "Trigger" },
              { key: "runs", label: "Runs" },
              { key: "updated", label: "Updated" },
              { key: "state", label: "State" },
            ]}
            empty="No workflows yet."
          >
            {page.items.length
              ? page.items.map((w) => (
                  <RecordsTableRow key={w.id}>
                    <RecordsTableCell><Link href={`/automation/workflows/${w.id}`} className="font-medium text-primary hover:underline">{w.name}</Link></RecordsTableCell>
                    <RecordsTableCell>{w.triggerAction}</RecordsTableCell>
                    <RecordsTableCell>{w._count.runs}</RecordsTableCell>
                    <RecordsTableCell>{formatDateTime(w.updatedAt)}</RecordsTableCell>
                    <RecordsTableCell>{w.isEnabled ? <Badge tone="success">Enabled</Badge> : <Badge tone="neutral">Disabled</Badge>}</RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/automation/workflows" />
        </CardContent>
      </Card>
    </div>
  );
}
