import Link from "next/link";
import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { listProjects, PROJECT_STATUSES } from "@/features/projects/projects";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { ApiForm, Field } from "@/components/erp/api-form";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function ProjectsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Projects"]} title="Projects" subtitle="Projects you manage or are a member of." />;
  if (!can(ctx, "project.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view projects.</p></div>;
  }
  const status = listParams(params, ["status"]).status;
  const page = await listProjects(ctx, { ...listParams(params), status: PROJECT_STATUSES.includes(status as never) ? status : undefined });
  const canCreate = can(ctx, "project.create");
  const [companies, members] = canCreate
    ? await Promise.all([
        prisma.company.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...ctx.companies.keys()] } }, select: { id: true, code: true, name: true }, orderBy: [{ isDefault: "desc" }, { code: "asc" }] }),
        prisma.organizationMember.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, select: { user: { select: { id: true, name: true, email: true } } } }),
      ])
    : [[], []];

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <ListToolbar params={params} placeholder="Search code or name…" filters={[{ name: "status", label: "Status", options: PROJECT_STATUSES.map((s) => ({ value: s, label: humanize(s) })) }]} />
          <RecordsTable
            columns={[
              { key: "code", label: "Code" },
              { key: "name", label: "Name" },
              { key: "customer", label: "Customer" },
              { key: "end", label: "Ends" },
              { key: "progress", label: "Progress" },
              { key: "status", label: "Status" },
            ]}
            empty="No projects yet."
          >
            {page.items.length
              ? page.items.map((p) => (
                  <RecordsTableRow key={p.id}>
                    <RecordsTableCell><Link href={`/projects/${p.id}`} className="font-medium text-primary hover:underline">{p.code}</Link></RecordsTableCell>
                    <RecordsTableCell>{p.name}</RecordsTableCell>
                    <RecordsTableCell>{p.customer?.name ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{formatDate(p.endDate)}</RecordsTableCell>
                    <RecordsTableCell>
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-20 overflow-hidden rounded-full bg-skeleton" role="progressbar" aria-valuenow={p.progress.percent} aria-valuemin={0} aria-valuemax={100}>
                          <div className="h-full bg-primary" style={{ width: `${p.progress.percent}%` }} />
                        </div>
                        <span className="text-2xs text-subtle">{p.progress.done}/{p.progress.total}</span>
                      </div>
                    </RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={p.status} /></RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/projects" />
        </CardContent>
      </Card>

      {canCreate && companies.length ? (
        <Card>
          <CardHeader><CardTitle>New project</CardTitle></CardHeader>
          <CardContent>
            <ApiForm path="/projects" submitLabel="Create project" redirect="/projects/:id" className="grid gap-3 sm:grid-cols-3">
              <Field label="Company">
                <Select name="companyId" required>{companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</Select>
              </Field>
              <Field label="Code"><Input name="code" required maxLength={32} placeholder="PRJ-001" /></Field>
              <Field label="Name"><Input name="name" required maxLength={200} /></Field>
              <Field label="Project manager">
                <Select name="managerId" defaultValue={ctx.userId}>{members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name ?? m.user.email}</option>)}</Select>
              </Field>
              <Field label="Start"><Input type="date" name="startDate" /></Field>
              <Field label="End"><Input type="date" name="endDate" /></Field>
              <Field label="Budget"><Input name="budget" inputMode="decimal" placeholder="0.00" /></Field>
              <Field label="Hourly rate"><Input name="hourlyRate" inputMode="decimal" placeholder="0.00" /></Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm"><input type="checkbox" name="billable" /> Billable by default</label>
              <Field label="Description" className="sm:col-span-3"><Textarea name="description" rows={2} maxLength={10000} /></Field>
            </ApiForm>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
