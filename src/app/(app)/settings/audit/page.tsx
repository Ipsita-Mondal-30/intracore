import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { searchAuditLogs } from "@/features/admin/audit";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { Pagination, param } from "@/components/erp/list-controls";
import { formatDateTime } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const json = (value: unknown) => (value === null || value === undefined ? "—" : JSON.stringify(value, null, 2));

export default async function AuditPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Settings", "Audit trail"]} title="Audit trail" subtitle="Every recorded change in this organization and the companies you can access." />;
  if (!can(ctx, "audit.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view the audit trail.</p></div>;
  }

  const p = (key: string) => param(params, key) || undefined;
  const to = p("to");
  const [page, members, companies] = await Promise.all([
    searchAuditLogs(ctx, {
      page: p("page"),
      q: p("q"),
      action: p("action"),
      entity: p("entity"),
      entityId: p("entityId"),
      userId: p("userId"),
      companyId: p("companyId"),
      from: p("from"),
      // The date picker means "through the end of that day".
      to: to ? `${to}T23:59:59.999Z` : undefined,
    }),
    prisma.organizationMember.findMany({ where: { organizationId: ctx.organizationId }, select: { user: { select: { id: true, name: true, email: true } } } }),
    prisma.company.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...ctx.companies.keys()] } }, select: { id: true, code: true } }),
  ]);

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <form method="get" className="grid gap-2 sm:grid-cols-4">
            <Input name="action" defaultValue={p("action")} placeholder="Action prefix, e.g. customer." aria-label="Action prefix" />
            <Input name="q" defaultValue={p("q")} placeholder="Text in action" aria-label="Text in action" />
            <Input name="entity" defaultValue={p("entity")} placeholder="Entity, e.g. sales_invoice" aria-label="Entity" />
            <Input name="entityId" defaultValue={p("entityId")} placeholder="Entity id" aria-label="Entity id" />
            <Select name="userId" defaultValue={p("userId") ?? ""} aria-label="User">
              <option value="">Any user</option>
              {members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name ?? m.user.email}</option>)}
            </Select>
            <Select name="companyId" defaultValue={p("companyId") ?? ""} aria-label="Company">
              <option value="">Any company</option>
              {companies.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}
            </Select>
            <Input type="date" name="from" defaultValue={p("from")} aria-label="From date" />
            <Input type="date" name="to" defaultValue={to} aria-label="To date" />
            <div><Button type="submit" size="sm" variant="secondary">Search</Button></div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5">
          <RecordsTable
            columns={[{ key: "when", label: "When" }, { key: "who", label: "User" }, { key: "action", label: "Action" }, { key: "entity", label: "Entity" }, { key: "diff", label: "Change" }]}
            empty="No audit entries match."
          >
            {page.items.length
              ? page.items.map((log) => (
                  <RecordsTableRow key={log.id}>
                    <RecordsTableCell className="whitespace-nowrap">{formatDateTime(log.createdAt)}</RecordsTableCell>
                    <RecordsTableCell>{log.user?.name ?? log.user?.email ?? "System"}</RecordsTableCell>
                    <RecordsTableCell className="font-mono text-xs">{log.action}</RecordsTableCell>
                    <RecordsTableCell className="text-xs">{log.entity}<br /><span className="text-subtle">{log.entityId ?? ""}</span></RecordsTableCell>
                    <RecordsTableCell>
                      {log.previous || log.next ? (
                        <details>
                          <summary className="cursor-pointer text-xs text-primary">View diff</summary>
                          <div className="mt-2 grid gap-2 md:grid-cols-2">
                            <pre className="max-h-64 overflow-auto rounded-lg bg-danger-soft p-2 text-2xs">{json(log.previous)}</pre>
                            <pre className="max-h-64 overflow-auto rounded-lg bg-success-soft p-2 text-2xs">{json(log.next)}</pre>
                          </div>
                        </details>
                      ) : "—"}
                    </RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination page={page.page} pageSize={page.pageSize} total={page.total} params={params} basePath="/settings/audit" />
        </CardContent>
      </Card>
    </div>
  );
}
