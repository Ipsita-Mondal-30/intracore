import { RecordStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { getSessionContext } from "@/lib/tenant";

/**
 * Portal identity. A portal request is authorized ONLY by an ACTIVE PortalAccount of the
 * requested kind and the single party (customer / vendor / employee / technician user) it
 * is linked to. It never builds an internal AccessContext and never calls assertCan, so
 * an external user cannot inherit any internal role permission, and an internal member
 * using a portal sees only what the portal shows.
 */

export const PORTAL_KINDS = ["CUSTOMER", "DEALER", "VENDOR", "EMPLOYEE", "TECHNICIAN"] as const;
export type PortalKind = (typeof PORTAL_KINDS)[number];

export type PortalContext = {
  accountId: string;
  organizationId: string;
  organizationName: string;
  userId: string;
  email: string;
  kind: PortalKind;
  customerId: string | null;
  vendorId: string | null;
  employeeId: string | null;
};

/** Cookie / query parameter naming the organization when a user has portals in several. */
export const PORTAL_ORG_COOKIE = "portalOrg";

export async function requirePortalUser() {
  const session = await getSessionContext();
  if (!session) throw new AppError("UNAUTHORIZED", "Authentication required", 401);
  return { userId: session.userId, email: (session.email ?? "").toLowerCase() };
}

/** Active portal accounts of the signed-in user (for the portal chooser). */
export async function listMyPortals() {
  const { userId } = await requirePortalUser();
  return prisma.portalAccount.findMany({
    where: { userId, status: "ACTIVE" },
    select: { id: true, kind: true, organization: { select: { id: true, name: true } } },
    orderBy: [{ organization: { name: "asc" } }, { kind: "asc" }],
  });
}

/**
 * `organizationId` picks the organization when the user has this portal in several. An
 * explicit choice is strict (no account there → 403); a remembered one (`orgIsHint`, the
 * portalOrg cookie) only disambiguates and is ignored when it matches no account.
 */
export async function getPortalContext(kind: PortalKind, organizationId?: string | null, orgIsHint = false): Promise<PortalContext> {
  const user = await requirePortalUser();
  const accounts = await prisma.portalAccount.findMany({
    where: { userId: user.userId, kind },
    include: { organization: { select: { name: true } }, customer: { select: { isDealer: true, status: true } } },
  });
  let active = accounts.filter((a) => a.status === "ACTIVE");
  if (organizationId) {
    const inOrg = active.filter((a) => a.organizationId === organizationId);
    if (inOrg.length || !orgIsHint) active = inOrg;
  }
  if (active.length === 0) throw new AppError("FORBIDDEN", `No active ${kind.toLowerCase()} portal account`, 403);
  if (active.length > 1) {
    throw new AppError("ORGANIZATION_REQUIRED", "Choose the organization for this portal", 409, {
      organizations: active.map((a) => ({ id: a.organizationId, name: a.organization.name })),
    });
  }
  const a = active[0];
  // The party link must still be valid: a dealer whose dealer flag was removed loses the dealer portal.
  if (kind === "DEALER" && !a.customer?.isDealer) throw new AppError("FORBIDDEN", "This customer is no longer a dealer", 403);
  if ((kind === "CUSTOMER" || kind === "DEALER") && a.customer?.status !== RecordStatus.ACTIVE) {
    throw new AppError("FORBIDDEN", "This customer account is inactive", 403);
  }
  if ((kind === "CUSTOMER" || kind === "DEALER") && !a.customerId) throw new AppError("FORBIDDEN", "Portal account has no customer", 403);
  if (kind === "VENDOR" && !a.vendorId) throw new AppError("FORBIDDEN", "Portal account has no vendor", 403);
  if (kind === "EMPLOYEE" && !a.employeeId) throw new AppError("FORBIDDEN", "Portal account has no employee", 403);
  return {
    accountId: a.id,
    organizationId: a.organizationId,
    organizationName: a.organization.name,
    userId: user.userId,
    email: user.email,
    kind,
    customerId: a.customerId,
    vendorId: a.vendorId,
    employeeId: a.employeeId,
  };
}

/** 404 for anything outside the account's party, so foreign ids are never confirmed. */
export const notFound = (what: string) => new AppError("NOT_FOUND", `${what} not found`, 404);
