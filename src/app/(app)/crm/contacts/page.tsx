import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listContacts, listCustomers } from "@/features/customers/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function ContactsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const canCreate = can(ctx, "contact.create");
  const [page, customers] = await Promise.all([
    listContacts(ctx, listParams(params, ["status", "customerId"])),
    canCreate && can(ctx, "customer.view") ? listCustomers(ctx, { pageSize: "100" }) : null,
  ]);

  return (
    <div className="space-y-4">
      <PageHeader breadcrumbs={["CRM", "Contacts"]} title="Contacts" subtitle="People you deal with at your customers." />

      {canCreate ? (
        <Card>
          <CardHeader><CardTitle>New contact</CardTitle></CardHeader>
          <CardContent>
            <ApiForm path="/contacts" submitLabel="Create contact" redirect="/crm/contacts/:id" className="grid gap-3 sm:grid-cols-4">
              <Field label="First name"><Input name="firstName" required /></Field>
              <Field label="Last name"><Input name="lastName" /></Field>
              <Field label="Email"><Input name="email" type="email" /></Field>
              <Field label="Phone"><Input name="phone" /></Field>
              <Field label="Job title"><Input name="jobTitle" /></Field>
              {customers ? (
                <Field label="Customer">
                  <Select name="customerId" defaultValue="">
                    <option value="">No customer</option>
                    {customers.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </Select>
                </Field>
              ) : null}
            </ApiForm>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search name, email, phone, title…"
            filters={[{ name: "status", label: "Status", options: ["ACTIVE", "INACTIVE", "ARCHIVED"].map((v) => ({ value: v, label: v })) }]}
          />
          <RecordsTable
            columns={[
              { key: "name", label: "Contact" },
              { key: "customer", label: "Customer" },
              { key: "title", label: "Job title" },
              { key: "reach", label: "Email / Phone" },
              { key: "status", label: "Status" },
            ]}
            empty={param(params, "q") ? "No contacts match your search." : "No contacts yet. Add one above or from a customer."}
          >
            {page.items.length
              ? page.items.map((c) => (
                  <RecordsTableRow key={c.id}>
                    <RecordsTableCell>
                      <Link href={`/crm/contacts/${c.id}`} className="font-medium text-primary hover:underline">{c.fullName}</Link>
                      {c.isPrimary ? <span className="ml-2 text-2xs text-success">Primary</span> : null}
                    </RecordsTableCell>
                    <RecordsTableCell>
                      {c.customer ? <Link href={`/crm/customers/${c.customer.id}`} className="hover:underline">{c.customer.name}</Link> : "—"}
                    </RecordsTableCell>
                    <RecordsTableCell>{c.jobTitle ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{[c.email, c.phone].filter(Boolean).join(" · ") || "—"}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={c.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/crm/contacts" />
        </CardContent>
      </Card>
    </div>
  );
}
