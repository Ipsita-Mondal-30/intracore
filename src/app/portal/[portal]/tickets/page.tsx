import Link from "next/link";
import { listAssets, listTickets, ticketCategories, ticketCompanies } from "@/features/portal/customer";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Field } from "@/components/erp/api-form";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDateTime, humanize } from "@/components/erp/format";
import { pagePortal, PortalHeader, salesKind, Section } from "@/app/portal/_components/portal-page";
import { PortalForm } from "@/app/portal/_components/portal-client";
import { portalTitle, salesLinks } from "../nav";

export default async function PortalTickets({ params }: { params: Promise<{ portal: string }> }) {
  const { portal } = await params;
  const p = await pagePortal(salesKind(portal));
  const [tickets, companies, categories, assets] = await Promise.all([listTickets(p, { pageSize: 100 }), ticketCompanies(p), ticketCategories(p), listAssets(p)]);
  const base = `/portal/${portal}`;
  return (
    <div>
      <PortalHeader title={portalTitle(portal)} organization={p.organizationName} links={salesLinks(portal)} />
      <Section title="Raise a ticket">
        <PortalForm path={`/${portal}/tickets`} submitLabel="Create ticket" successMessage="Ticket created" redirect={`${base}/tickets/:id`}>
          <Field label="Subject"><Input name="subject" required maxLength={300} /></Field>
          <Field label="Describe the problem"><Textarea name="description" rows={4} maxLength={20000} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Priority">
              <Select name="priority" defaultValue="MEDIUM">
                {["LOW", "MEDIUM", "HIGH"].map((v) => <option key={v} value={v}>{humanize(v)}</option>)}
              </Select>
            </Field>
            {companies.length > 1 ? (
              <Field label="Company">
                <Select name="companyId">{companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
              </Field>
            ) : null}
            {categories.length ? (
              <Field label="Category">
                <Select name="categoryId" defaultValue=""><option value="">—</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
              </Field>
            ) : null}
            {assets.length ? (
              <Field label="Equipment">
                <Select name="assetId" defaultValue=""><option value="">—</option>{assets.map((a) => <option key={a.id} value={a.id}>{a.tag} · {a.name}</option>)}</Select>
              </Field>
            ) : null}
          </div>
        </PortalForm>
      </Section>
      <Section title="Your tickets">
        <RecordsTable columns={[{ key: "n", label: "Ticket" }, { key: "s", label: "Subject" }, { key: "st", label: "Status" }, { key: "c", label: "Opened" }, { key: "u", label: "Updated" }]} empty="No tickets yet.">
          {tickets.items.length
            ? tickets.items.map((t) => (
                <RecordsTableRow key={t.id}>
                  <RecordsTableCell><Link className="font-medium text-primary hover:underline" href={`${base}/tickets/${t.id}`}>{t.number}</Link></RecordsTableCell>
                  <RecordsTableCell>{t.subject}</RecordsTableCell>
                  <RecordsTableCell><StatusBadge status={t.status} /></RecordsTableCell>
                  <RecordsTableCell>{formatDateTime(t.createdAt)}</RecordsTableCell>
                  <RecordsTableCell>{formatDateTime(t.updatedAt)}</RecordsTableCell>
                </RecordsTableRow>
              ))
            : undefined}
        </RecordsTable>
      </Section>
    </div>
  );
}
