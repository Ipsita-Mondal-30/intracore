import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listCustomers } from "@/features/customers/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function CustomersPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const page = await listCustomers(ctx, listParams(params, ["status"]));

  return (
    <div className="space-y-4">
      <PageHeader breadcrumbs={["CRM", "Customers"]} title="Customers" subtitle="Accounts you sell to. Leads become customers on conversion." />

      {can(ctx, "customer.create") ? (
        <Card>
          <CardHeader><CardTitle>New customer</CardTitle></CardHeader>
          <CardContent>
            <ApiForm path="/customers" submitLabel="Create customer" redirect="/crm/customers/:id" className="grid gap-3 sm:grid-cols-4">
              <Field label="Name"><Input name="name" required /></Field>
              <Field label="Type">
                <Select name="type" defaultValue="BUSINESS">
                  <option value="BUSINESS">Business</option>
                  <option value="INDIVIDUAL">Individual</option>
                </Select>
              </Field>
              <Field label="Email"><Input name="email" type="email" /></Field>
              <Field label="Phone"><Input name="phone" /></Field>
              <Field label="GSTIN"><Input name="gstin" /></Field>
              <Field label="State code" hint="Place of supply, e.g. 29"><Input name="stateCode" /></Field>
              <Field label="Billing address" className="sm:col-span-2"><Input name="billingAddress" /></Field>
              <label className="flex items-center gap-2 text-xs text-muted sm:col-span-4">
                <input type="checkbox" name="ignoreDuplicates" /> Create even if a similar customer exists
              </label>
            </ApiForm>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search name, email, phone, GSTIN…"
            filters={[{ name: "status", label: "Status", options: ["ACTIVE", "INACTIVE", "ARCHIVED"].map((v) => ({ value: v, label: v })) }]}
          />
          <RecordsTable
            columns={[
              { key: "name", label: "Customer" },
              { key: "contact", label: "Contact" },
              { key: "gstin", label: "GSTIN" },
              { key: "owner", label: "Owner" },
              { key: "counts", label: "Contacts / Deals" },
              { key: "status", label: "Status" },
            ]}
            empty={param(params, "q") ? "No customers match your search." : "No customers yet. Convert a lead or create one above."}
          >
            {page.items.length
              ? page.items.map((c) => (
                  <RecordsTableRow key={c.id}>
                    <RecordsTableCell>
                      <Link href={`/crm/customers/${c.id}`} className="font-medium text-primary hover:underline">{c.name}</Link>
                    </RecordsTableCell>
                    <RecordsTableCell>{c.email ?? c.phone ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{c.gstin ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{c.owner?.name ?? c.owner?.email ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{c._count.contacts} / {c._count.opportunities}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={c.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/crm/customers" />
        </CardContent>
      </Card>
    </div>
  );
}
