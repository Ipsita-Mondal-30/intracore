import { LeadPriority } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { listSlaPolicies, listTicketCategories } from "@/features/service/sla";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { humanize } from "@/components/erp/format";

const duration = (m: number) => (m % 1440 === 0 ? `${m / 1440} d` : m % 60 === 0 ? `${m / 60} h` : `${m} min`);

export default async function ServiceSettingsPage() {
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Service", "SLA & categories"]} title="SLA and categories" subtitle="Response and resolution targets run on calendar time (24x7) from ticket creation." />;
  if (!can(ctx, "ticket.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view service settings.</p></div>;
  }
  const admin = can(ctx, "service.administer");
  const [categories, policies, members] = await Promise.all([
    listTicketCategories(ctx),
    listSlaPolicies(ctx),
    admin ? prisma.organizationMember.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, select: { user: { select: { id: true, name: true, email: true } } } }) : [],
  ]);
  const names = new Map(members.map((m) => [m.user.id, m.user.name ?? m.user.email]));

  return (
    <div className="space-y-4">
      {header}
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle>SLA policies</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {policies.length === 0 ? <p className="text-sm text-muted">No policies: tickets get no due dates.</p> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                    <tr><th className="py-2">Name</th><th className="py-2">Priority</th><th className="py-2">First response</th><th className="py-2">Resolution</th><th className="py-2">Escalate to</th><th className="py-2" /></tr>
                  </thead>
                  <tbody>
                    {policies.map((p) => (
                      <tr key={p.id} className="border-t border-[var(--ic-border)]">
                        <td className="py-2">{p.name} {p.isActive ? null : <Badge tone="neutral">Inactive</Badge>}</td>
                        <td className="py-2">{humanize(p.priority)}</td>
                        <td className="py-2">{duration(p.firstResponseMinutes)}</td>
                        <td className="py-2">{duration(p.resolutionMinutes)}</td>
                        <td className="py-2">{p.escalateToUserId ? names.get(p.escalateToUserId) ?? "—" : "—"}</td>
                        <td className="py-2 text-right">
                          {admin ? <ActionButton path={`/sla-policies/${p.id}`} method="PATCH" body={{ isActive: !p.isActive }} label={p.isActive ? "Deactivate" : "Activate"} variant="ghost" /> : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {admin ? (
              <ApiForm path="/sla-policies" submitLabel="Add policy" className="grid gap-3 border-t border-[var(--ic-border)] pt-4 sm:grid-cols-3">
                <Field label="Name"><Input name="name" required maxLength={80} /></Field>
                <Field label="Priority">
                  <Select name="priority" required>{Object.values(LeadPriority).map((p) => <option key={p} value={p}>{humanize(p)}</option>)}</Select>
                </Field>
                <Field label="Escalate to">
                  <Select name="escalateToUserId"><option value="">Nobody</option>{members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name ?? m.user.email}</option>)}</Select>
                </Field>
                <Field label="First response (minutes)"><Input type="number" name="firstResponseMinutes" required min={1} /></Field>
                <Field label="Resolution (minutes)"><Input type="number" name="resolutionMinutes" required min={1} /></Field>
              </ApiForm>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Categories</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            {categories.length === 0 ? <p className="text-sm text-muted">No categories.</p> : (
              <ul className="space-y-1 text-sm">
                {categories.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-2">
                    <span className={c.isActive ? "" : "text-subtle line-through"}>{c.name}</span>
                    {admin ? <ActionButton path={`/ticket-categories/${c.id}`} method="PATCH" body={{ isActive: !c.isActive }} label={c.isActive ? "Deactivate" : "Activate"} variant="ghost" /> : null}
                  </li>
                ))}
              </ul>
            )}
            {admin ? (
              <ApiForm path="/ticket-categories" submitLabel="Add category" className="space-y-2 border-t border-[var(--ic-border)] pt-3">
                <Input name="name" required maxLength={80} placeholder="e.g. Hardware" aria-label="Category name" />
              </ApiForm>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
