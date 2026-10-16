import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionContext } from "@/lib/tenant";
import { listMyPortals } from "@/features/portal/context";

const LABELS: Record<string, string> = {
  CUSTOMER: "Customer portal",
  DEALER: "Dealer portal",
  VENDOR: "Supplier portal",
  EMPLOYEE: "Employee self-service",
  TECHNICIAN: "Technician jobs",
};

const href = (organizationId: string, kind: string) =>
  `/api/portal/select-org?organizationId=${encodeURIComponent(organizationId)}&next=${encodeURIComponent(`/portal/${kind.toLowerCase()}`)}`;

export default async function PortalHome({ searchParams }: { searchParams: Promise<{ choose?: string }> }) {
  if (!(await getSessionContext())) redirect("/login");
  const portals = await listMyPortals();
  // ?choose=1 comes back from a portal that refused access: show the list instead of looping.
  if (portals.length === 1 && !(await searchParams).choose) redirect(href(portals[0].organization.id, portals[0].kind));
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold tracking-tight">Your portals</h1>
      {portals.length === 0 ? (
        <p className="text-sm text-muted">You have no active portal access. Ask the organization to send you an invitation, then open its link.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2">
          {portals.map((p) => (
            <li key={p.id}>
              <a href={href(p.organization.id, p.kind)} className="ic-panel block p-4 hover:shadow">
                <p className="text-xs uppercase tracking-wide text-subtle">{p.organization.name}</p>
                <p className="font-semibold">{LABELS[p.kind] ?? p.kind}</p>
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-subtle">
        Staff member? <Link href="/dashboard" className="underline">Go to the app</Link>
      </p>
    </div>
  );
}
