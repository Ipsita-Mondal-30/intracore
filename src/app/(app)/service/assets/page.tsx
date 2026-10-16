import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { prisma } from "@/lib/db/prisma";
import { ASSET_STATUSES, listAssets } from "@/features/service/assets";
import { companyOptions, customerOptions, memberOptions } from "@/features/service/lookups";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function AssetsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Service", "Assets"]} title="Assets" subtitle="Company asset register and customer installed base, with warranties." />;
  if (!can(ctx, "asset.view")) return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view assets.</p></div>;

  const page = await listAssets(ctx, listParams(params, ["status", "ownership"]));
  const canCreate = can(ctx, "asset.create");
  const [companies, customers, members, products] = canCreate
    ? await Promise.all([
        companyOptions(ctx),
        customerOptions(ctx),
        memberOptions(ctx),
        prisma.product.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, select: { id: true, sku: true, name: true }, orderBy: { sku: "asc" }, take: 500 }),
      ])
    : [[], [], [], []];

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Tag, name, serial, location"
            filters={[
              { name: "status", label: "Status", options: ASSET_STATUSES.map((s) => ({ value: s, label: humanize(s) })) },
              { name: "ownership", label: "Ownership", options: [{ value: "COMPANY", label: "Company" }, { value: "CUSTOMER", label: "Customer" }] },
            ]}
          />
          <RecordsTable
            columns={[{ key: "tag", label: "Tag" }, { key: "name", label: "Name" }, { key: "serial", label: "Serial" }, { key: "owner", label: "Owner" }, { key: "location", label: "Location" }, { key: "status", label: "Status" }]}
            empty="No assets registered yet."
          >
            {page.items.length
              ? page.items.map((a) => (
                  <RecordsTableRow key={a.id}>
                    <RecordsTableCell><Link href={`/service/assets/${a.id}`} className="font-medium text-primary hover:underline">{a.tag}</Link></RecordsTableCell>
                    <RecordsTableCell>{a.name}{a.product ? <span className="block text-2xs text-subtle">{a.product.sku}</span> : null}</RecordsTableCell>
                    <RecordsTableCell>{a.serialNumber ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{a.customer?.name ?? "Company"}</RecordsTableCell>
                    <RecordsTableCell>{a.location ?? "—"}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={a.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/service/assets" />
        </CardContent>
      </Card>

      {canCreate && companies.length ? (
        <Card>
          <CardHeader><CardTitle>Register asset</CardTitle></CardHeader>
          <CardContent>
            <ApiForm path="/assets" submitLabel="Register" redirect="/service/assets/:id" className="grid gap-3 sm:grid-cols-3">
              <Field label="Company"><Select name="companyId" required>{companies.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field>
              <Field label="Tag"><Input name="tag" required maxLength={60} /></Field>
              <Field label="Name"><Input name="name" required maxLength={200} /></Field>
              <Field label="Ownership"><Select name="ownership"><option value="COMPANY">Company</option><option value="CUSTOMER">Customer</option></Select></Field>
              <Field label="Customer" hint="Required for customer-owned assets"><Select name="customerId"><option value="">—</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field>
              <Field label="Product"><Select name="productId"><option value="">—</option>{products.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}</Select></Field>
              <Field label="Serial number"><Input name="serialNumber" maxLength={120} /></Field>
              <Field label="Location"><Input name="location" maxLength={500} /></Field>
              <Field label="Assigned to"><Select name="assignedToId"><option value="">—</option>{members.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}</Select></Field>
              <Field label="Status"><Select name="status"><option value="IN_USE">In use</option><option value="IN_STOCK">In stock</option></Select></Field>
              <Field label="Install date"><Input type="date" name="installDate" /></Field>
              <Field label="Value"><Input name="value" inputMode="decimal" /></Field>
            </ApiForm>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
