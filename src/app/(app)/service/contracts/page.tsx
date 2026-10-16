import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { prisma } from "@/lib/db/prisma";
import { listContracts } from "@/features/service/contracts";
import { companyOptions, customerOptions } from "@/features/service/lookups";
import { ContractForm } from "@/features/service/forms";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatMoney, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const STATUSES = ["DRAFT", "ACTIVE", "EXPIRED", "CANCELLED", "RENEWED"];

export default async function ContractsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Service", "AMC contracts"]} title="AMC contracts" subtitle="Annual maintenance contracts, covered assets, entitlements and renewals." />;
  if (!can(ctx, "contract.view")) return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view contracts.</p></div>;

  const page = await listContracts(ctx, listParams(params, ["status"]));
  const canCreate = can(ctx, "contract.create");
  const [companies, customers, assets] = canCreate
    ? await Promise.all([
        companyOptions(ctx),
        customerOptions(ctx),
        prisma.asset.findMany({ where: { organizationId: ctx.organizationId, companyId: { in: [...ctx.companies.keys()] }, ownership: "CUSTOMER", status: { notIn: ["RETIRED", "DISPOSED"] } }, select: { id: true, tag: true, name: true, customerId: true }, orderBy: { tag: "asc" }, take: 1000 }),
      ])
    : [[], [], []];

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <ListToolbar params={params} placeholder="Contract number" filters={[{ name: "status", label: "Status", options: STATUSES.map((s) => ({ value: s, label: humanize(s) })) }]} />
          <RecordsTable
            columns={[{ key: "number", label: "Contract" }, { key: "customer", label: "Customer" }, { key: "period", label: "Period" }, { key: "assets", label: "Assets" }, { key: "value", label: "Value" }, { key: "status", label: "Status" }]}
            empty="No contracts yet."
          >
            {page.items.length
              ? page.items.map((c) => (
                  <RecordsTableRow key={c.id}>
                    <RecordsTableCell><Link href={`/service/contracts/${c.id}`} className="font-medium text-primary hover:underline">{c.number}</Link></RecordsTableCell>
                    <RecordsTableCell>{c.customer.name}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(c.startDate)} – {formatDate(c.endDate)}</RecordsTableCell>
                    <RecordsTableCell>{c._count.assets}</RecordsTableCell>
                    <RecordsTableCell>{formatMoney(c.value)}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={c.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/service/contracts" />
        </CardContent>
      </Card>
      {canCreate && companies.length ? (
        <Card>
          <CardHeader><CardTitle>New contract</CardTitle></CardHeader>
          <CardContent>
            <ContractForm companies={companies} customers={customers} assets={assets.map((a) => ({ id: a.id, label: `${a.tag} · ${a.name}`, customerId: a.customerId }))} />
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
