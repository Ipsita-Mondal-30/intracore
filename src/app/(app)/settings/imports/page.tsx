import { can, getAccessContext } from "@/lib/access";
import { IMPORT_ENTITIES, MAX_IMPORT_ROWS, importTemplate, listImportJobs } from "@/features/admin/imports";
import { ImportPanel } from "@/features/admin/import-panel";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDateTime } from "@/components/erp/format";

const CREATE: Record<string, string> = { customer: "customer.create", contact: "contact.create", vendor: "vendor.create", product: "product.create" };

export default async function ImportsPage() {
  const ctx = await getAccessContext();
  const header = (
    <PageHeader
      breadcrumbs={["Settings", "Imports"]}
      title="Imports"
      subtitle={`CSV import (up to 5 MB, ${MAX_IMPORT_ROWS.toLocaleString("en-IN")} rows). Validate first: a dry run writes nothing. Rows are created one by one through the same rules as the forms; failing rows are reported and skipped.`}
    />
  );
  if (!can(ctx, "data.import")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to import data.</p></div>;
  }
  const entities = IMPORT_ENTITIES.filter((e) => can(ctx, CREATE[e]));
  const jobs = await listImportJobs(ctx, { pageSize: 25 });

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardHeader><CardTitle>New import</CardTitle></CardHeader>
        <CardContent>
          {entities.length ? <ImportPanel entities={entities} /> : <p className="text-sm text-muted">You can&apos;t create any importable record type.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Columns</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-sm">
          {entities.map((entity) => {
            const t = importTemplate(ctx, entity);
            return (
              <p key={entity}>
                <strong className="capitalize">{entity}</strong>: {t.columns.map((c) => (t.required.includes(c) ? `${c}*` : c)).join(", ")}
              </p>
            );
          })}
          <p className="text-xs text-muted">* required. Header names must match exactly. Contacts link to a customer by code or exact name; products resolve uom by code and category / taxRate by name. Duplicates: customers follow the CRM duplicate rules; vendors match on code or GSTIN; products on SKU or barcode; contacts on email.</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Recent imports</CardTitle></CardHeader>
        <CardContent>
          <RecordsTable
            columns={[{ key: "when", label: "When" }, { key: "entity", label: "Type" }, { key: "file", label: "File" }, { key: "status", label: "Status" }, { key: "counts", label: "Rows / created / duplicates / errors" }, { key: "by", label: "By" }]}
            empty="No imports yet."
          >
            {jobs.items.length
              ? jobs.items.map((job) => (
                  <RecordsTableRow key={job.id}>
                    <RecordsTableCell>{formatDateTime(job.createdAt)}</RecordsTableCell>
                    <RecordsTableCell className="capitalize">{job.entity}</RecordsTableCell>
                    <RecordsTableCell className="text-xs">{job.filename ?? "—"}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={job.status} /></RecordsTableCell>
                    <RecordsTableCell>{job.totalRows} / {job.imported} / {job.duplicates} / {job.errors}</RecordsTableCell>
                    <RecordsTableCell>{job.createdBy.name ?? job.createdBy.email}</RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
        </CardContent>
      </Card>
    </div>
  );
}
