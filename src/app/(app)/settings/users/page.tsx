import Link from "next/link";
import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { listMembers } from "@/features/admin/users";
import { InviteMemberForm } from "@/features/members/invite-member-form";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function UsersSettingsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Settings", "Users"]} title="Users" subtitle="Members of the current organization, their roles and company access." />;
  if (!can(ctx, "member.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view members.</p></div>;
  }
  const changeRole = can(ctx, "member.change_role");
  const suspend = can(ctx, "member.remove");

  const [members, roles, invitations] = await Promise.all([
    listMembers(ctx, { ...listParams(params, ["status"]), dir: "asc" }),
    prisma.role.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { name: "asc" }, select: { id: true, name: true, code: true } }),
    prisma.invitation.findMany({
      where: { organizationId: ctx.organizationId, status: "PENDING" },
      include: { role: { select: { name: true } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardHeader><CardTitle>Members ({members.total})</CardTitle></CardHeader>
        <CardContent>
          <ListToolbar params={params} placeholder="Name or email" filters={[{ name: "status", label: "Status", options: [{ value: "ACTIVE", label: "Active" }, { value: "DISABLED", label: "Suspended" }] }]} />
          <RecordsTable
            columns={[{ key: "user", label: "User" }, { key: "role", label: "Role" }, { key: "scopes", label: "Company access" }, { key: "status", label: "Status" }, { key: "actions", label: "" }]}
            empty="No members match."
          >
            {members.items.map((m) => {
              const self = m.userId === ctx.userId;
              const manageable = !self && (ctx.isOwner || !m.isOwner);
              return (
                <RecordsTableRow key={m.id}>
                  <RecordsTableCell>
                    <div className="flex items-center gap-2.5">
                      <Avatar name={m.user.name} src={m.user.image} size="sm" />
                      <div>
                        <p className="font-medium">{m.user.name ?? "—"} {m.isOwner ? <Badge tone="primary">Owner</Badge> : null}</p>
                        <p className="text-xs text-muted">{m.user.email}</p>
                      </div>
                    </div>
                  </RecordsTableCell>
                  <RecordsTableCell>
                    {changeRole && manageable ? (
                      <ApiForm path={`/admin/members/${m.id}/role`} submitLabel="Change" successMessage="Role changed" className="flex items-center gap-2 space-y-0">
                        <Select name="roleId" defaultValue={m.roleId} aria-label="Role" className="max-w-[180px]">
                          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                        </Select>
                      </ApiForm>
                    ) : (
                      <Badge tone="neutral">{m.role.name}</Badge>
                    )}
                  </RecordsTableCell>
                  <RecordsTableCell className="text-xs">
                    {m.isOwner ? "All companies" : m.scopes.length ? m.scopes.map((s) => `${s.company.code}${s.branch ? `/${s.branch.code}` : ""}`).join(", ") : "None"}
                  </RecordsTableCell>
                  <RecordsTableCell><Badge tone={m.status === "ACTIVE" ? "success" : "warning"}>{m.status === "ACTIVE" ? "Active" : "Suspended"}</Badge></RecordsTableCell>
                  <RecordsTableCell>
                    {suspend && manageable ? (
                      m.status === "ACTIVE" ? (
                        <ActionButton path={`/admin/members/${m.id}/suspend`} label="Suspend" variant="secondary" confirm="Suspend this member? They lose access immediately." />
                      ) : (
                        <ActionButton path={`/admin/members/${m.id}/reactivate`} label="Reactivate" />
                      )
                    ) : null}
                  </RecordsTableCell>
                </RecordsTableRow>
              );
            })}
          </RecordsTable>
          <Pagination page={members.page} pageSize={members.pageSize} total={members.total} params={params} basePath="/settings/users" />
          {can(ctx, "company.administer") ? (
            <p className="mt-2 text-xs text-muted">Company and branch access is edited under <Link className="text-primary underline" href="/settings/companies">Companies</Link>.</p>
          ) : null}
        </CardContent>
      </Card>

      {invitations.length > 0 ? (
        <Card>
          <CardHeader><CardTitle>Pending invitations</CardTitle></CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {invitations.map((inv) => (
                <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-[var(--ic-surface-muted)] px-3 py-2">
                  <span>{inv.email} — {inv.role.name}</span>
                  <span className="text-2xs text-subtle">Expires {inv.expiresAt.toISOString().slice(0, 10)}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ) : null}

      {can(ctx, "member.invite") ? <InviteMemberForm roles={roles} /> : null}
    </div>
  );
}
