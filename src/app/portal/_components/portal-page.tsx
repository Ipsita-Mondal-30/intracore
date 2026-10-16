import type { ReactNode } from "react";
import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { getPortalContext, PORTAL_ORG_COOKIE, type PortalKind } from "@/features/portal/context";

/** Portal context for a server page: signed out → /login, no account / org choice needed → /portal. */
export async function pagePortal(kind: PortalKind) {
  const org = (await cookies()).get(PORTAL_ORG_COOKIE)?.value ?? null;
  try {
    return await getPortalContext(kind, org, true);
  } catch (error) {
    if (isAppError(error) && error.status === 401) redirect("/login");
    if (isAppError(error) && (error.status === 403 || error.status === 409)) redirect("/portal?choose=1");
    throw error;
  }
}

/** /portal/[portal]/… segment → CUSTOMER | DEALER (anything else 404). */
export function salesKind(portal: string): PortalKind {
  if (portal === "customer") return "CUSTOMER";
  if (portal === "dealer") return "DEALER";
  notFound();
}

/** 404 AppErrors from portal services render the not-found page. */
export async function orNotFound<T>(load: Promise<T>): Promise<T> {
  try {
    return await load;
  } catch (error) {
    if (isAppError(error) && error.status === 404) notFound();
    throw error;
  }
}

export function PortalHeader({ title, organization, links }: { title: string; organization: string; links: { href: string; label: string }[] }) {
  return (
    <header className="mb-6 space-y-3">
      <div>
        <p className="text-xs uppercase tracking-wide text-subtle">{organization}</p>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
      </div>
      <nav className="flex flex-wrap gap-2 text-sm">
        {links.map((l) => (
          <Link key={l.href} href={l.href} className="rounded-full border border-[var(--ic-border)] px-3 py-1 hover:bg-[var(--ic-table-header)]">
            {l.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ic-panel mb-4 p-4 sm:p-5">
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}
