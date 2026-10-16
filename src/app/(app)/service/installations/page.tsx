import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listInstallationJobs } from "@/features/service/installations";
import { companyOptions, customerOptions, memberOptions } from "@/features/service/lookups";
import { InstallationForm } from "@/features/service/forms";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDateTime, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const STATUSES = ["PLANNED", "SCHEDULED", "IN_PROGRESS", "COMPLETED", "CANCELLED"];

export default async function InstallationsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Service", "Installations"]} title="Installation jobs" subtitle="Plan, schedule and complete installations against a checklist." />;
  if (!can(ctx, "field.view")) return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view field work.</p></div>;

  const page = await listInstallationJobs(ctx, listParams(params, ["status"]));
  const canCreate = can(ctx, "field.schedule");
  const [companies, customers, members] = canCreate ? await Promise.all([companyOptions(ctx), customerOptions(ctx), memberOptions(ctx)]) : [[], [], []];

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <ListToolbar params={params} placeholder="Job number, address" filters={[{ name: "status", label: "Status", options: STATUSES.map((s) => ({ value: s, label: humanize(s) })) }]} />
          <RecordsTable columns={[{ key: "number", label: "Job" }, { key: "customer", label: "Customer" }, { key: "when", label: "Scheduled" }, { key: "status", label: "Status" }]} empty="No installation jobs.">
            {page.items.length
              ? page.items.map((j) => (
                  <RecordsTableRow key={j.id}>
                    <RecordsTableCell><Link href={`/service/installations/${j.id}`} className="font-medium text-primary hover:underline">{j.number}</Link></RecordsTableCell>
                    <RecordsTableCell>{j.customer.name}</RecordsTableCell>
                    <RecordsTableCell>{j.scheduledStart ? formatDateTime(j.scheduledStart) : "—"}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={j.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/service/installations" />
        </CardContent>
      </Card>
      {canCreate && companies.length ? (
        <Card>
          <CardHeader><CardTitle>New installation job</CardTitle></CardHeader>
          <CardContent><InstallationForm companies={companies} customers={customers} technicians={members} /></CardContent>
        </Card>
      ) : null}
    </div>
  );
}
