import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listVendors } from "@/features/purchasing/vendors";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function VendorsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const page = await listVendors(ctx, listParams(params, ["status"]));

  return (
    <div className="space-y-4">
      <PageHeader breadcrumbs={["Purchasing", "Vendors"]} title="Vendors" subtitle="Suppliers you buy from." />

      {can(ctx, "vendor.create") ? (
        <Card>
          <CardHeader><CardTitle>New vendor</CardTitle></CardHeader>
          <CardContent>
            <ApiForm path="/vendors" submitLabel="Create vendor" redirect="/purchasing/vendors/:id" className="grid gap-3 sm:grid-cols-4">
              <Field label="Name"><Input name="name" required /></Field>
              <Field label="Code"><Input name="code" /></Field>
              <Field label="Email"><Input name="email" type="email" /></Field>
              <Field label="Phone"><Input name="phone" /></Field>
              <Field label="GSTIN"><Input name="gstin" /></Field>
              <Field label="State code" hint="GST state, e.g. 29"><Input name="stateCode" inputMode="numeric" pattern="[0-9]{2}" maxLength={2} /></Field>
              <Field label="Payment terms (days)"><Input name="paymentTermsDays" type="number" min="0" max="365" /></Field>
              <Field label="Address"><Input name="address" /></Field>
            </ApiForm>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search name, code, email, GSTIN…"
            filters={[{ name: "status", label: "Status", options: ["ACTIVE", "INACTIVE", "ARCHIVED"].map((v) => ({ value: v, label: v })) }]}
          />
          <RecordsTable
            columns={[
              { key: "name", label: "Vendor" },
              { key: "code", label: "Code" },
              { key: "contact", label: "Contact" },
              { key: "gstin", label: "GSTIN" },
              { key: "pos", label: "Purchase orders" },
              { key: "status", label: "Status" },
            ]}
            empty={param(params, "q") || param(params, "status") ? "No vendors match your filters." : "No vendors yet."}
          >
            {page.items.length
              ? page.items.map((v) => (
                  <RecordsTableRow key={v.id}>
                    <RecordsTableCell>
                      <Link href={`/purchasing/vendors/${v.id}`} className="font-medium text-primary hover:underline">{v.name}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>{v.code ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{v.email ?? v.phone ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{v.gstin ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{v._count.purchaseOrders}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={v.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/purchasing/vendors" />
        </CardContent>
      </Card>
    </div>
  );
}
