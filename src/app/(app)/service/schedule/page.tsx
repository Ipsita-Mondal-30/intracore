import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listVisits } from "@/features/service/field";
import { companyOptions, memberOptions, userNames } from "@/features/service/lookups";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDateTime, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const STATUSES = ["SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "NO_SHOW"];

export default async function SchedulePage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const canSchedule = can(ctx, "field.schedule");
  const header = <PageHeader breadcrumbs={["Service", "Field schedule"]} title="Field schedule" subtitle={canSchedule ? "Technician visits across your companies." : "Your assigned visits."} />;
  if (!can(ctx, "field.view")) return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view field work.</p></div>;

  const page = await listVisits(ctx, { ...listParams(params, ["status"]), dir: "asc" });
  const [companies, members, names] = await Promise.all([
    canSchedule ? companyOptions(ctx) : [],
    canSchedule ? memberOptions(ctx) : [],
    userNames(page.items.map((v) => v.technicianId)),
  ]);

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <ListToolbar params={params} filters={[{ name: "status", label: "Status", options: STATUSES.map((s) => ({ value: s, label: humanize(s) })) }]} />
          <RecordsTable
            columns={[{ key: "when", label: "When" }, { key: "tech", label: "Technician" }, { key: "type", label: "Service" }, { key: "for", label: "For" }, { key: "status", label: "Status" }]}
            empty="No visits scheduled."
          >
            {page.items.length
              ? page.items.map((v) => (
                  <RecordsTableRow key={v.id}>
                    <RecordsTableCell><Link href={`/service/schedule/${v.id}`} className="font-medium text-primary hover:underline">{formatDateTime(v.scheduledStart)}</Link></RecordsTableCell>
                    <RecordsTableCell>{names.get(v.technicianId) ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{v.serviceType ? humanize(v.serviceType) : "—"}</RecordsTableCell>
                    <RecordsTableCell>{[v.asset?.tag, v.ticket?.number, v.contract?.number].filter(Boolean).join(" · ") || "—"}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={v.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/service/schedule" />
        </CardContent>
      </Card>
      {canSchedule && companies.length ? (
        <Card>
          <CardHeader><CardTitle>Schedule a visit</CardTitle></CardHeader>
          <CardContent>
            <ApiForm path="/service-visits" submitLabel="Schedule" className="grid gap-3 sm:grid-cols-3">
              <Field label="Company"><Select name="companyId" required>{companies.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field>
              <Field label="Technician"><Select name="technicianId" required>{members.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</Select></Field>
              <Field label="Service type"><Input name="serviceType" placeholder="PREVENTIVE" maxLength={60} /></Field>
              <Field label="Start"><Input type="datetime-local" name="scheduledStart" required /></Field>
              <Field label="End"><Input type="datetime-local" name="scheduledEnd" required /></Field>
              <Field label="Asset id" hint="Optional"><Input name="assetId" /></Field>
              <Field label="Notes" className="sm:col-span-3"><Textarea name="notes" rows={2} /></Field>
            </ApiForm>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
