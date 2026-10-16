import { createHash, randomBytes } from "crypto";
import { z } from "zod";
import { EmployeeStatus, MemberStatus, RecordStatus, type Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { AppError } from "@/lib/errors";
import { assertCan, type AccessContext } from "@/lib/access";
import { audit } from "@/lib/audit";
import { getSiteUrl } from "@/lib/config/env";
import { sendEmail } from "@/lib/email/send";
import { PORTAL_KINDS, type PortalKind } from "@/features/portal/context";

/**
 * Internal administration of portal identities (permission portal.manage).
 *
 * Invitation → party link per kind:
 *   CUSTOMER   customerId (active customer of the tenant)
 *   DEALER     customerId whose customer.isDealer is true
 *   VENDOR     vendorId
 *   EMPLOYEE   employeeId (not exited); if the employee already has a login, the email must be that login's
 *   TECHNICIAN no party: the email must belong to an ACTIVE member of this organization, because
 *              visits/jobs are assigned to member user ids (service/field.ts assertTechnician)
 * The token is 32 random bytes; only its sha256 is stored. The accept URL is returned to the
 * inviting admin once (and emailed when email is configured). Inviting again for the same
 * email + kind revokes the earlier pending invitation.
 */

const INVITE_DAYS = 7;
export const hashPortalToken = (token: string) => createHash("sha256").update(token).digest("hex");

const inviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  kind: z.enum(PORTAL_KINDS),
  customerId: z.string().min(1).nullish(),
  vendorId: z.string().min(1).nullish(),
  employeeId: z.string().min(1).nullish(),
});

type Party = { customerId: string | null; vendorId: string | null; employeeId: string | null };

async function resolveParty(organizationId: string, kind: PortalKind, email: string, d: z.infer<typeof inviteSchema>): Promise<Party> {
  const none: Party = { customerId: null, vendorId: null, employeeId: null };
  const required = (field: string) => new AppError("VALIDATION_ERROR", `${field} is required for a ${kind.toLowerCase()} portal`, 422, [{ path: field, message: "Required" }]);
  switch (kind) {
    case "CUSTOMER":
    case "DEALER": {
      if (!d.customerId) throw required("customerId");
      const c = await prisma.customer.findFirst({ where: { id: d.customerId, organizationId }, select: { id: true, isDealer: true, status: true } });
      if (!c) throw new AppError("NOT_FOUND", "Customer not found", 404);
      if (c.status !== RecordStatus.ACTIVE) throw new AppError("INVALID_STATE", "Customer is not active", 422);
      if (kind === "DEALER" && !c.isDealer) throw new AppError("INVALID_STATE", "Mark the customer as a dealer first", 422);
      return { ...none, customerId: c.id };
    }
    case "VENDOR": {
      if (!d.vendorId) throw required("vendorId");
      const v = await prisma.vendor.findFirst({ where: { id: d.vendorId, organizationId }, select: { id: true } });
      if (!v) throw new AppError("NOT_FOUND", "Vendor not found", 404);
      return { ...none, vendorId: v.id };
    }
    case "EMPLOYEE": {
      if (!d.employeeId) throw required("employeeId");
      const e = await prisma.employee.findFirst({ where: { id: d.employeeId, organizationId }, select: { id: true, status: true, user: { select: { email: true } } } });
      if (!e) throw new AppError("NOT_FOUND", "Employee not found", 404);
      if (e.status === EmployeeStatus.EXITED) throw new AppError("INVALID_STATE", "Employee has exited", 422);
      if (e.user && e.user.email.toLowerCase() !== email) throw new AppError("INVALID_STATE", "This employee is linked to a different login; invite that email", 422);
      return { ...none, employeeId: e.id };
    }
    case "TECHNICIAN": {
      const member = await prisma.organizationMember.findFirst({ where: { organizationId, status: MemberStatus.ACTIVE, user: { email } }, select: { id: true } });
      if (!member) throw new AppError("INVALID_STATE", "Technicians must be active members of this organization (visits are assigned to members)", 422);
      return none;
    }
  }
}

export async function invitePortalUser(ctx: AccessContext, input: unknown) {
  assertCan(ctx, "portal.manage");
  const data = inviteSchema.parse(input);
  const party = await resolveParty(ctx.organizationId, data.kind, data.email, data);
  const existing = await prisma.portalAccount.findFirst({ where: { organizationId: ctx.organizationId, kind: data.kind, user: { email: data.email } }, select: { id: true } });
  if (existing) throw new AppError("CONFLICT", "This email already has this portal; reactivate it instead", 409);

  const token = randomBytes(32).toString("base64url");
  const acceptUrl = `${getSiteUrl().replace(/\/$/, "")}/portal/accept?token=${token}`;
  const invitation = await prisma.$transaction(async (tx) => {
    await tx.portalInvitation.updateMany({
      where: { organizationId: ctx.organizationId, email: data.email, kind: data.kind, acceptedAt: null, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    const row = await tx.portalInvitation.create({
      data: {
        organizationId: ctx.organizationId,
        email: data.email,
        kind: data.kind,
        ...party,
        tokenHash: hashPortalToken(token),
        expiresAt: new Date(Date.now() + INVITE_DAYS * 86_400_000),
        invitedById: ctx.userId,
      },
      select: invitationSelect,
    });
    await audit(tx, ctx, { action: "portal_invitation.created", entity: "portal_invitation", entityId: row.id, next: { email: row.email, kind: row.kind, ...party } });
    return row;
  });

  const label = data.kind.toLowerCase();
  const sent = await sendEmail({
    to: data.email,
    subject: `${ctx.organizationName}: your ${label} portal invitation`,
    html: `<p>${escapeHtml(ctx.organizationName)} invited you to its ${label} portal.</p><p>Sign in (or create an account) with this email address, then open:<br><a href="${acceptUrl}">${acceptUrl}</a></p><p>The link expires in ${INVITE_DAYS} days and works once.</p>`,
    text: `${ctx.organizationName} invited you to its ${label} portal. Sign in (or create an account) with ${data.email}, then open ${acceptUrl} (expires in ${INVITE_DAYS} days).`,
  });
  // The URL is shown to the inviting admin once; it is not stored anywhere.
  return { invitation: withState(invitation), acceptUrl, emailSent: sent.ok };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const invitationSelect = {
  id: true,
  email: true,
  kind: true,
  customerId: true,
  vendorId: true,
  employeeId: true,
  expiresAt: true,
  acceptedAt: true,
  revokedAt: true,
  createdAt: true,
} satisfies Prisma.PortalInvitationSelect;

function withState<T extends { acceptedAt: Date | null; revokedAt: Date | null; expiresAt: Date }>(i: T) {
  const state = i.acceptedAt ? "ACCEPTED" : i.revokedAt ? "REVOKED" : i.expiresAt < new Date() ? "EXPIRED" : "PENDING";
  return { ...i, state };
}

export async function listPortalInvitations(ctx: AccessContext) {
  assertCan(ctx, "portal.manage");
  const rows = await prisma.portalInvitation.findMany({ where: { organizationId: ctx.organizationId }, select: invitationSelect, orderBy: { createdAt: "desc" }, take: 200 });
  return rows.map(withState);
}

export async function revokePortalInvitation(ctx: AccessContext, id: string) {
  assertCan(ctx, "portal.manage");
  return prisma.$transaction(async (tx) => {
    const inv = await tx.portalInvitation.findFirst({ where: { id, organizationId: ctx.organizationId }, select: invitationSelect });
    if (!inv) throw new AppError("NOT_FOUND", "Invitation not found", 404);
    if (inv.acceptedAt) throw new AppError("INVALID_STATE", "The invitation was already accepted; suspend the account instead", 422);
    if (inv.revokedAt) return withState(inv);
    const row = await tx.portalInvitation.update({ where: { id }, data: { revokedAt: new Date() }, select: invitationSelect });
    await audit(tx, ctx, { action: "portal_invitation.revoked", entity: "portal_invitation", entityId: id, next: { email: row.email, kind: row.kind } });
    return withState(row);
  });
}

const accountSelect = {
  id: true,
  kind: true,
  status: true,
  createdAt: true,
  lastSeenAt: true,
  user: { select: { id: true, email: true, name: true } },
  customer: { select: { id: true, name: true } },
  vendor: { select: { id: true, name: true } },
  employee: { select: { id: true, fullName: true, employeeNumber: true } },
} satisfies Prisma.PortalAccountSelect;

export async function listPortalAccounts(ctx: AccessContext, query: unknown = {}) {
  assertCan(ctx, "portal.manage");
  const q = z.object({ kind: z.enum(PORTAL_KINDS).optional(), status: z.enum(["ACTIVE", "SUSPENDED"]).optional() }).parse(query);
  return prisma.portalAccount.findMany({ where: { organizationId: ctx.organizationId, kind: q.kind, status: q.status }, select: accountSelect, orderBy: { createdAt: "desc" }, take: 500 });
}

export async function setPortalAccountStatus(ctx: AccessContext, id: string, action: string) {
  assertCan(ctx, "portal.manage");
  const status = action === "suspend" ? "SUSPENDED" : action === "reactivate" ? "ACTIVE" : null;
  if (!status) throw new AppError("NOT_FOUND", "Unknown action", 404);
  return prisma.$transaction(async (tx) => {
    const before = await tx.portalAccount.findFirst({ where: { id, organizationId: ctx.organizationId }, select: { status: true } });
    if (!before) throw new AppError("NOT_FOUND", "Portal account not found", 404);
    if (before.status === status) return tx.portalAccount.findUniqueOrThrow({ where: { id }, select: accountSelect });
    const row = await tx.portalAccount.update({ where: { id }, data: { status }, select: accountSelect });
    await audit(tx, ctx, { action: `portal_account.${action}`, entity: "portal_account", entityId: id, previous: { status: before.status }, next: { status } });
    return row;
  });
}

/** Choices for the invite form (names only). ponytail: first 500 of each, add search when tenants outgrow it. */
export async function portalInviteOptions(ctx: AccessContext) {
  assertCan(ctx, "portal.manage");
  const organizationId = ctx.organizationId;
  const [customers, vendors, employees] = await Promise.all([
    prisma.customer.findMany({ where: { organizationId, status: RecordStatus.ACTIVE }, select: { id: true, name: true, isDealer: true }, orderBy: { name: "asc" }, take: 500 }),
    prisma.vendor.findMany({ where: { organizationId, status: RecordStatus.ACTIVE }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 }),
    prisma.employee.findMany({ where: { organizationId, status: { not: EmployeeStatus.EXITED } }, select: { id: true, fullName: true, employeeNumber: true }, orderBy: { fullName: "asc" }, take: 500 }),
  ]);
  return { customers, vendors, employees };
}

// ─── Accept ───────────────────────────────────────────────────────────────────

/**
 * Accept an invitation as the signed-in user. The user's email must equal the invited email
 * (case-insensitive); the token must be unexpired, unrevoked and unused. Single use: a second
 * call by the same user returns the same account, anyone else gets 422 INVITATION_USED.
 */
export async function acceptPortalInvitation(user: { userId: string; email: string }, input: unknown) {
  const { token } = z.object({ token: z.string().min(16).max(200) }).parse(input);
  const tokenHash = hashPortalToken(token);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 FROM "portal_invitations" WHERE "tokenHash" = ${tokenHash} FOR UPDATE`;
    const inv = await tx.portalInvitation.findUnique({ where: { tokenHash } });
    if (!inv) throw new AppError("INVALID_TOKEN", "This invitation link is not valid", 404);
    if (inv.email.toLowerCase() !== user.email.toLowerCase()) throw new AppError("EMAIL_MISMATCH", "Sign in with the email address the invitation was sent to", 403);
    const where = { organizationId_userId_kind: { organizationId: inv.organizationId, userId: user.userId, kind: inv.kind } };
    if (inv.acceptedAt) {
      if (inv.acceptedUserId !== user.userId) throw new AppError("INVITATION_USED", "This invitation was already used", 422);
      return { account: await tx.portalAccount.findUniqueOrThrow({ where, select: { id: true, kind: true, status: true, organizationId: true } }), alreadyAccepted: true };
    }
    if (inv.revokedAt) throw new AppError("INVITATION_REVOKED", "This invitation was revoked", 422);
    if (inv.expiresAt < new Date()) throw new AppError("INVITATION_EXPIRED", "This invitation has expired", 422);

    // Re-check the party link: things may have changed since the invite was sent.
    if (inv.kind === "EMPLOYEE" && inv.employeeId) {
      const e = await tx.employee.findFirst({ where: { id: inv.employeeId, organizationId: inv.organizationId }, select: { userId: true, status: true } });
      if (!e || e.status === EmployeeStatus.EXITED) throw new AppError("INVALID_STATE", "The employee record is no longer active", 422);
      if (e.userId && e.userId !== user.userId) throw new AppError("INVALID_STATE", "This employee is linked to a different login", 422);
    }
    if (inv.kind === "DEALER" && inv.customerId) {
      const c = await tx.customer.findFirst({ where: { id: inv.customerId, organizationId: inv.organizationId }, select: { isDealer: true } });
      if (!c?.isDealer) throw new AppError("INVALID_STATE", "The customer is no longer a dealer", 422);
    }
    if (inv.kind === "TECHNICIAN") {
      const m = await tx.organizationMember.findFirst({ where: { organizationId: inv.organizationId, userId: user.userId, status: MemberStatus.ACTIVE }, select: { id: true } });
      if (!m) throw new AppError("INVALID_STATE", "Technicians must be active members of the organization", 422);
    }

    const party = { customerId: inv.customerId, vendorId: inv.vendorId, employeeId: inv.employeeId };
    const account = await tx.portalAccount.upsert({
      where,
      create: { organizationId: inv.organizationId, userId: user.userId, kind: inv.kind, ...party, invitedById: inv.invitedById },
      update: { ...party, status: "ACTIVE" },
      select: { id: true, kind: true, status: true, organizationId: true },
    });
    await tx.portalInvitation.update({ where: { id: inv.id }, data: { acceptedAt: new Date(), acceptedUserId: user.userId } });
    await audit(tx, { organizationId: inv.organizationId, userId: user.userId }, { action: "portal_invitation.accepted", entity: "portal_account", entityId: account.id, next: { kind: inv.kind, ...party, invitationId: inv.id } });
    return { account, alreadyAccepted: false };
  });
}
