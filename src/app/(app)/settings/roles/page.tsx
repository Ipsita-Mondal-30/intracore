import { can, getAccessContext } from "@/lib/access";
import { getPermissionMatrix, listRoles } from "@/features/admin/roles";
import { RoleEditor } from "@/features/admin/role-editor";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ActionButton } from "@/components/erp/action-button";

export default async function RolesSettingsPage() {
  const ctx = await getAccessContext();
  const header = (
    <PageHeader
      breadcrumbs={["Settings", "Roles"]}
      title="Roles & permissions"
      subtitle="System roles follow the built-in catalog and are read-only. Custom roles grant exactly the permissions ticked; you can only grant access you hold yourself."
    />
  );
  if (!can(ctx, "role.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view roles.</p></div>;
  }
  const manage = can(ctx, "role.manage");
  const [matrix, roles] = await Promise.all([getPermissionMatrix(ctx), listRoles(ctx)]);

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardHeader><CardTitle>Permission matrix</CardTitle></CardHeader>
        <CardContent>
          <p className="mb-2 text-xs text-muted">Granted / available permissions per module.</p>
          <div className="overflow-x-auto">
            <table className="border-collapse text-xs">
              <thead>
                <tr>
                  <th className="sticky left-0 bg-[var(--ic-surface)] px-2 py-1 text-left">Role</th>
                  {matrix.modules.map((m) => <th key={m.module} className="px-1.5 py-1 font-medium [writing-mode:vertical-rl]">{m.module}</th>)}
                </tr>
              </thead>
              <tbody>
                {matrix.roles.map((r) => (
                  <tr key={r.id} className="border-t border-[var(--ic-border)]">
                    <td className="sticky left-0 whitespace-nowrap bg-[var(--ic-surface)] px-2 py-1 font-medium">{r.name}{r.isSystem ? "" : " *"}</td>
                    {matrix.modules.map((m) => {
                      const n = r.modules[m.module];
                      const full = n === m.permissions.length;
                      return (
                        <td key={m.module} className={`px-1.5 py-1 text-center ${full ? "bg-emerald-50 text-success" : n ? "bg-amber-50 text-warning" : "text-subtle"}`}>
                          {n ? (full ? "all" : `${n}/${m.permissions.length}`) : "·"}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-2xs text-subtle">* custom role</p>
        </CardContent>
      </Card>

      {manage ? (
        <Card>
          <CardHeader><CardTitle>New custom role</CardTitle></CardHeader>
          <CardContent><RoleEditor modules={matrix.modules} /></CardContent>
        </Card>
      ) : null}

      {roles.filter((r) => !r.isSystem).map((role) => (
        <Card key={role.id}>
          <CardHeader>
            <div>
              <CardTitle>{role.name}</CardTitle>
              <p className="mt-1 text-2xs text-subtle">{role.code} · {role.permissions.length} permissions</p>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone="neutral">{role.memberCount} members</Badge>
              {manage ? <ActionButton path={`/admin/roles/${role.id}`} method="DELETE" label="Delete" confirm={`Delete role ${role.name}?`} /> : null}
            </div>
          </CardHeader>
          <CardContent>
            {manage ? (
              <details>
                <summary className="cursor-pointer text-sm text-primary">Edit</summary>
                <div className="mt-3"><RoleEditor modules={matrix.modules} role={role} /></div>
              </details>
            ) : (
              <div className="flex flex-wrap gap-1.5">{role.permissions.map((code) => <Badge key={code} tone="neutral">{code}</Badge>)}</div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
