import { LeadPriority } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { TICKET_SOURCES } from "@/features/service/tickets";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { humanize } from "@/components/erp/format";

export default async function NewTicketPage() {
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Service", "Tickets", "New"]} title="New ticket" subtitle="SLA due dates are set from the priority's policy." />;
  if (!can(ctx, "ticket.create")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to create tickets.</p></div>;
  }
  const org = ctx.organizationId;
  const [companies, customers, categories, members, assets] = await Promise.all([
    prisma.company.findMany({ where: { organizationId: org, id: { in: [...ctx.companies.keys()] } }, select: { id: true, code: true, name: true }, orderBy: [{ isDefault: "desc" }, { code: "asc" }] }),
    prisma.customer.findMany({ where: { organizationId: org, status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 }),
    prisma.ticketCategory.findMany({ where: { organizationId: org, isActive: true }, orderBy: { name: "asc" } }),
    can(ctx, "ticket.assign") ? prisma.organizationMember.findMany({ where: { organizationId: org, status: "ACTIVE" }, select: { user: { select: { id: true, name: true, email: true } } } }) : [],
    prisma.asset.findMany({ where: { organizationId: org, companyId: { in: [...ctx.companies.keys()] } }, select: { id: true, tag: true, name: true }, orderBy: { tag: "asc" }, take: 500 }),
  ]);

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          {companies.length === 0 ? (
            <p className="text-sm text-muted">You don&apos;t have access to any company.</p>
          ) : (
            <ApiForm path="/tickets" submitLabel="Create ticket" redirect="/service/tickets/:id" className="grid gap-3 sm:grid-cols-3">
              <Field label="Subject" className="sm:col-span-3"><Input name="subject" required maxLength={300} /></Field>
              <Field label="Company">
                <Select name="companyId" required>{companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</Select>
              </Field>
              <Field label="Customer">
                <Select name="customerId"><option value="">None</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
              </Field>
              <Field label="Category">
                <Select name="categoryId"><option value="">None</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
              </Field>
              <Field label="Priority">
                <Select name="priority" defaultValue="MEDIUM">{Object.values(LeadPriority).map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</Select>
              </Field>
              <Field label="Source">
                <Select name="source" defaultValue="PHONE">{TICKET_SOURCES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select>
              </Field>
              {members.length ? (
                <Field label="Assign to">
                  <Select name="assigneeId"><option value="">Unassigned</option>{members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name ?? m.user.email}</option>)}</Select>
                </Field>
              ) : null}
              <Field label="Asset">
                <Select name="assetId"><option value="">None</option>{assets.map((a) => <option key={a.id} value={a.id}>{a.tag} · {a.name}</option>)}</Select>
              </Field>
              <Field label="Description" className="sm:col-span-3"><Textarea name="description" rows={4} maxLength={20000} /></Field>
            </ApiForm>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
