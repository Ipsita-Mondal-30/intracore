import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { APPROVAL_STATUSES, listApprovals } from "@/features/automation/approvals";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { formatDateTime, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function ApprovalsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const p = listParams(params, ["status", "scope"]);
  const all = p.scope === "all" && can(ctx, "approval.view_all");
  const status = p.status === "any" ? undefined : APPROVAL_STATUSES.includes(p.status as never) ? p.status : "PENDING";
  const page = await listApprovals(ctx, { ...p, status, scope: all ? "all" : "mine" });
  const now = Date.now();

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Automation", "Approvals"]}
        title="Approvals"
        subtitle="Requests assigned to you or your role. Approving records the decision; it does not change the record itself."
      />
      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search title…"
            filters={[
              { name: "status", label: "Status (default pending)", options: [{ value: "any", label: "Any" }, ...APPROVAL_STATUSES.map((s) => ({ value: s, label: humanize(s) }))] },
              ...(can(ctx, "approval.view_all") ? [{ name: "scope", label: "Scope", options: [{ value: "all", label: "Everyone's" }] }] : []),
            ]}
          />
          <RecordsTable
            columns={[
              { key: "title", label: "Request" },
              { key: "workflow", label: "Workflow" },
              { key: "step", label: "Step" },
              { key: "due", label: "Due" },
              { key: "status", label: "Status" },
              { key: "decide", label: "" },
            ]}
            empty="Nothing waiting for you."
          >
            {page.items.length
              ? page.items.map((r) => {
                  const mine = !all || r.approverUserId === ctx.userId; // "mine" lists only my user/role requests
                  return (
                    <RecordsTableRow key={r.id}>
                      <RecordsTableCell>
                        <span className="font-medium">{r.title}</span>
                        <span className="block text-2xs text-subtle">{r.entityType} · {r.approverRoleCode ? `role ${r.approverRoleCode}` : "assigned to a user"}</span>
                      </RecordsTableCell>
                      <RecordsTableCell>
                        {r.run && can(ctx, "workflow.view") ? <Link href={`/automation/workflows/${r.run.workflow.id}?run=${r.run.id}`} className="text-primary hover:underline">{r.run.workflow.name}</Link> : r.run?.workflow.name ?? "—"}
                      </RecordsTableCell>
                      <RecordsTableCell>{r.stepIndex + 1}</RecordsTableCell>
                      <RecordsTableCell>{formatDateTime(r.dueAt)} {r.status === "PENDING" && r.dueAt && r.dueAt.getTime() < now ? <Badge tone="danger">Overdue</Badge> : null}</RecordsTableCell>
                      <RecordsTableCell><StatusBadge status={r.status} /></RecordsTableCell>
                      <RecordsTableCell>
                        {r.status === "PENDING" && mine ? (
                          <div className="flex gap-2">
                            <ActionButton path={`/approvals/${r.id}/approve`} label="Approve" variant="default" prompt="Comment (optional)" promptField="comment" />
                            <ActionButton path={`/approvals/${r.id}/reject`} label="Reject" variant="ghost" prompt="Why reject? (required)" promptField="comment" />
                          </div>
                        ) : null}
                      </RecordsTableCell>
                    </RecordsTableRow>
                  );
                })
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/automation/approvals" />
        </CardContent>
      </Card>
    </div>
  );
}
