import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listInspectionTemplates, listInspections } from "@/features/quality/inspections";
import { listNonConformances } from "@/features/quality/ncr";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatQty, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function QualityPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Manufacturing", "Quality"]} title="Quality" subtitle="Inspection templates and results, non-conformances and corrective actions." />;
  if (!can(ctx, "quality.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have access to quality records.</p></div>;
  }
  const [ncrs, inspections, templates] = await Promise.all([
    listNonConformances(ctx, listParams(params, ["status", "severity"])),
    listInspections(ctx, { pageSize: "15" }),
    listInspectionTemplates(ctx, { pageSize: "100" }),
  ]);
  const canManage = can(ctx, "quality.manage");
  const canInspect = can(ctx, "quality.inspect");

  return (
    <div className="space-y-4">
      {header}

      <Card>
        <CardHeader><CardTitle>Non-conformances</CardTitle></CardHeader>
        <CardContent>
          <ListToolbar
            params={params}
            placeholder="Search number, description…"
            filters={[
              { name: "status", label: "Status", options: ["OPEN", "IN_PROGRESS", "CLOSED"].map((v) => ({ value: v, label: humanize(v) })) },
              { name: "severity", label: "Severity", options: ["MINOR", "MAJOR", "CRITICAL"].map((v) => ({ value: v, label: humanize(v) })) },
            ]}
          />
          <RecordsTable
            columns={[
              { key: "number", label: "Number" },
              { key: "description", label: "Description" },
              { key: "qty", label: "Quantity", className: "text-right" },
              { key: "severity", label: "Severity" },
              { key: "raised", label: "Raised" },
              { key: "status", label: "Status" },
            ]}
            empty="No non-conformances."
          >
            {ncrs.items.length
              ? ncrs.items.map((n) => (
                  <RecordsTableRow key={n.id}>
                    <RecordsTableCell><Link href={`/manufacturing/quality/${n.id}`} className="font-medium text-primary hover:underline">{n.number}</Link></RecordsTableCell>
                    <RecordsTableCell className="max-w-md truncate">{n.description}</RecordsTableCell>
                    <RecordsTableCell className="text-right">{formatQty(n.quantity)}</RecordsTableCell>
                    <RecordsTableCell>{humanize(n.severity)}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(n.createdAt)}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={n.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...ncrs} params={params} basePath="/manufacturing/quality" />
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Recent inspections</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {canInspect ? <Link href="/manufacturing/quality/inspect" className="text-primary hover:underline">Record an inspection</Link> : null}
            {inspections.items.length === 0 ? <p className="text-muted">No inspections yet.</p> : null}
            <ul className="space-y-1">
              {inspections.items.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-2">
                  <StatusBadge status={i.result} />
                  <span>{i.template.name}</span>
                  <span className="text-muted">{humanize(i.sourceType)} · {formatQty(i.inspectedQty)} inspected, {formatQty(i.rejectedQty)} rejected</span>
                  {i.nonConformances.map((n) => <Link key={n.id} href={`/manufacturing/quality/${n.id}`} className="text-primary hover:underline">{n.number}</Link>)}
                  <span className="text-2xs text-subtle">{formatDate(i.createdAt)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Inspection templates</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {templates.items.length === 0 ? <p className="text-muted">No templates yet.</p> : null}
            <ul className="space-y-2">
              {templates.items.map((t) => (
                <li key={t.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t.name}</span>
                  <span className="text-muted">{humanize(t.appliesTo)} · {t.items.length} checks · used {t._count.inspections}×</span>
                  {!t.isActive ? <StatusBadge status="INACTIVE" /> : null}
                  {t.isActive && canInspect ? <Link href={`/manufacturing/quality/inspect?templateId=${t.id}`} className="text-primary hover:underline">Inspect</Link> : null}
                  {canManage ? (
                    <ActionButton path={`/inspection-templates/${t.id}`} method="PATCH" body={{ isActive: !t.isActive }} label={t.isActive ? "Deactivate" : "Activate"} variant="ghost" />
                  ) : null}
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      {canManage ? (
        <Card>
          <CardHeader><CardTitle>New inspection template</CardTitle></CardHeader>
          <CardContent>
            <ApiForm path="/inspection-templates" submitLabel="Create template" successMessage="Template created">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Name"><Input name="name" required /></Field>
                <Field label="Applies to">
                  <Select name="appliesTo" defaultValue="GENERAL">
                    <option value="GENERAL">Any</option>
                    <option value="GOODS_RECEIPT">Goods receipts</option>
                    <option value="PRODUCTION">Production</option>
                  </Select>
                </Field>
              </div>
              <div className="space-y-2">
                <div className="grid grid-cols-[1fr_130px_100px_100px_80px] gap-2 text-2xs uppercase tracking-wide text-subtle">
                  <span>Check</span><span>Type</span><span>Min</span><span>Max</span><span>Required</span>
                </div>
                {Array.from({ length: 6 }, (_, i) => (
                  <div key={i} className="grid grid-cols-[1fr_130px_100px_100px_80px] items-center gap-2">
                    <Input name={`items.${i}.label`} placeholder={i === 0 ? "e.g. Diameter (mm)" : ""} aria-label={`Check ${i + 1}`} />
                    <Select name={`items.${i}.type`} defaultValue="BOOLEAN" aria-label={`Type ${i + 1}`}>
                      <option value="BOOLEAN">Pass / fail</option>
                      <option value="NUMERIC">Measurement</option>
                      <option value="TEXT">Note</option>
                    </Select>
                    <Input name={`items.${i}.minValue`} type="number" step="any" aria-label={`Minimum ${i + 1}`} />
                    <Input name={`items.${i}.maxValue`} type="number" step="any" aria-label={`Maximum ${i + 1}`} />
                    <input type="checkbox" name={`items.${i}.required`} defaultChecked aria-label={`Required ${i + 1}`} />
                  </div>
                ))}
                <p className="text-2xs text-subtle">Rows without a check name are ignored. Measurements pass when within min / max.</p>
              </div>
            </ApiForm>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
