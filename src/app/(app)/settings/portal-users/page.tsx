import { can, getAccessContext } from "@/lib/access";
import { listPortalAccounts, listPortalInvitations, portalInviteOptions } from "@/features/portal/admin";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, humanize } from "@/components/erp/format";
import { InviteForm } from "./invite-form";

export default async function PortalUsersPage() {
  const ctx = await getAccessContext();
  const header = (
    <PageHeader
      breadcrumbs={["Settings", "Portal users"]}
      title="Portal users"
      subtitle="Customers, dealers, suppliers, employees and technicians with access to their own records. Portal access grants no internal permissions."
    />
  );
  if (!can(ctx, "portal.manage")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to manage portal users.</p></div>;
  }
  const [accounts, invitations, options] = await Promise.all([listPortalAccounts(ctx), listPortalInvitations(ctx), portalInviteOptions(ctx)]);
  const party = (a: (typeof accounts)[number]) => a.customer?.name ?? a.vendor?.name ?? (a.employee ? `${a.employee.fullName} (${a.employee.employeeNumber})` : "—");

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardHeader><CardTitle>Invite</CardTitle></CardHeader>
        <CardContent><InviteForm {...options} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Accounts ({accounts.length})</CardTitle></CardHeader>
        <CardContent>
          <RecordsTable columns={[{ key: "u", label: "User" }, { key: "k", label: "Portal" }, { key: "p", label: "Linked to" }, { key: "s", label: "Status" }, { key: "c", label: "Since" }, { key: "a", label: "" }]} empty="No portal accounts yet.">
            {accounts.length
              ? accounts.map((a) => (
                  <RecordsTableRow key={a.id}>
                    <RecordsTableCell>{a.user.name ?? a.user.email}<span className="block text-2xs text-subtle">{a.user.email}</span></RecordsTableCell>
                    <RecordsTableCell>{humanize(a.kind)}</RecordsTableCell>
                    <RecordsTableCell>{party(a)}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={a.status} /></RecordsTableCell>
                    <RecordsTableCell>{formatDate(a.createdAt)}</RecordsTableCell>
                    <RecordsTableCell>
                      {a.status === "ACTIVE"
                        ? <ActionButton path={`/portal-accounts/${a.id}/suspend`} label="Suspend" confirm="Suspend this portal account?" />
                        : <ActionButton path={`/portal-accounts/${a.id}/reactivate`} label="Reactivate" />}
                    </RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Invitations</CardTitle></CardHeader>
        <CardContent>
          <RecordsTable columns={[{ key: "e", label: "Email" }, { key: "k", label: "Portal" }, { key: "s", label: "State" }, { key: "x", label: "Expires" }, { key: "a", label: "" }]} empty="No invitations.">
            {invitations.length
              ? invitations.map((i) => (
                  <RecordsTableRow key={i.id}>
                    <RecordsTableCell>{i.email}</RecordsTableCell>
                    <RecordsTableCell>{humanize(i.kind)}</RecordsTableCell>
                    <RecordsTableCell><StatusBadge status={i.state} /></RecordsTableCell>
                    <RecordsTableCell>{formatDate(i.expiresAt)}</RecordsTableCell>
                    <RecordsTableCell>{i.state === "PENDING" ? <ActionButton path={`/portal-invitations/${i.id}/revoke`} label="Revoke" confirm="Revoke this invitation?" /> : null}</RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
        </CardContent>
      </Card>
    </div>
  );
}
