"use server";

import { createHash, randomBytes } from "crypto";
import { revalidatePath } from "next/cache";
import { InvitationStatus, MemberStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requireAuth, requirePermission } from "@/lib/tenant";
import { createClient } from "@/lib/supabase/server";
import { ensurePrismaUser } from "@/lib/auth/ensure-user";
import {
  acceptInvitationSchema,
  inviteMemberSchema,
} from "@/lib/validations/auth";
import { isAppError } from "@/lib/errors";
import { systemRolePermissions } from "@/lib/permissions/catalog";
import type { ActionResult } from "@/features/auth/types";
import { isEmailConfigured } from "@/lib/email/client";
import { sendEmail } from "@/lib/email/send";
import { memberInvitationEmail } from "@/lib/email/templates";

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function siteUrl() {
  return process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
}

export async function inviteMemberAction(
  _prev: (ActionResult & { inviteUrl?: string; emailSent?: boolean }) | null,
  formData: FormData,
): Promise<ActionResult & { inviteUrl?: string; emailSent?: boolean }> {
  try {
    const tenant = await requirePermission("member.invite");

    const parsed = inviteMemberSchema.safeParse({
      email: formData.get("email"),
      roleId: formData.get("roleId"),
    });

    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Invalid input",
      };
    }

    const email = parsed.data.email.toLowerCase();

    const role = await prisma.role.findFirst({
      where: {
        id: parsed.data.roleId,
        organizationId: tenant.organizationId,
      },
      include: { permissions: { include: { permission: { select: { code: true } } } } },
    });
    if (!role) {
      return { ok: false, error: "Invalid role for this organization" };
    }
    // Nobody can hand out more access than they hold themselves.
    if (!tenant.isOwner) {
      const granted = [
        ...role.permissions.map((rp) => rp.permission.code),
        ...(role.isSystem ? systemRolePermissions(role.code) : []),
      ];
      if (role.code === "owner" || granted.some((code) => !tenant.permissions.has(code))) {
        return {
          ok: false,
          error: "You cannot invite someone to a role with more access than your own",
        };
      }
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      const existingMember = await prisma.organizationMember.findUnique({
        where: {
          organizationId_userId: {
            organizationId: tenant.organizationId,
            userId: existingUser.id,
          },
        },
      });
      if (existingMember) {
        return { ok: false, error: "User is already a member" };
      }
    }

    const pending = await prisma.invitation.findFirst({
      where: {
        organizationId: tenant.organizationId,
        email,
        status: InvitationStatus.PENDING,
      },
    });
    if (pending) {
      return { ok: false, error: "A pending invitation already exists" };
    }

    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = hashToken(rawToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await prisma.invitation.create({
      data: {
        organizationId: tenant.organizationId,
        email,
        roleId: role.id,
        tokenHash,
        invitedByUserId: tenant.userId,
        expiresAt,
        status: InvitationStatus.PENDING,
      },
    });

    await prisma.auditLog.create({
      data: {
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        action: "member.invited",
        entity: "Invitation",
        next: { email, roleId: role.id },
      },
    });

    const inviteUrl = `${siteUrl()}/accept-invite?token=${rawToken}`;

    const org = await prisma.organization.findUnique({
      where: { id: tenant.organizationId },
      select: { name: true },
    });
    const inviter = await prisma.user.findUnique({
      where: { id: tenant.userId },
      select: { name: true, email: true },
    });

    const template = memberInvitationEmail({
      organizationName: org?.name ?? "your organization",
      roleName: role.name,
      inviteUrl,
      invitedByName: inviter?.name ?? inviter?.email,
    });

    const mail = await sendEmail({
      to: email,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });

    const emailSent = mail.ok === true;
    if (!emailSent) {
      const detail =
        mail.ok === false && mail.skipped
          ? mail.reason
          : mail.ok === false
            ? mail.error
            : "";
      console.info("[invite] Invitation URL (email not sent):", inviteUrl, detail);
    }

    revalidatePath("/settings/users");
    return {
      ok: true,
      // Show copyable URL when Resend is not configured or send failed
      inviteUrl: emailSent ? undefined : inviteUrl,
      emailSent,
      message: emailSent
        ? "Invitation sent"
        : isEmailConfigured()
          ? "Invitation created (email failed — share the link below)"
          : "Invitation created (email not configured — share the link below)",
    };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    console.error(error);
    return { ok: false, error: "Failed to invite member" };
  }
}

export async function acceptInvitationAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const parsed = acceptInvitationSchema.safeParse({
      token: formData.get("token"),
      name: formData.get("name") || undefined,
      password: formData.get("password") || undefined,
    });

    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Invalid input",
      };
    }

    const tokenHash = hashToken(parsed.data.token);
    const invitation = await prisma.invitation.findUnique({
      where: { tokenHash },
    });

    if (!invitation || invitation.status !== InvitationStatus.PENDING) {
      return { ok: false, error: "Invitation is invalid or already used" };
    }
    if (invitation.expiresAt < new Date()) {
      await prisma.invitation.update({
        where: { id: invitation.id },
        data: { status: InvitationStatus.EXPIRED },
      });
      return { ok: false, error: "Invitation has expired" };
    }

    const session = await requireAuth().catch(() => null);
    let userId = session?.userId;

    if (!userId) {
      if (!parsed.data.password || !parsed.data.name) {
        return {
          ok: false,
          error: "Name and password are required to create an account",
        };
      }

      const email = invitation.email.toLowerCase();
      const supabase = await createClient();
      const { data, error } = await supabase.auth.signUp({
        email,
        password: parsed.data.password,
        options: {
          data: { name: parsed.data.name },
          emailRedirectTo: `${siteUrl()}/auth/callback?next=/accept-invite?token=${parsed.data.token}`,
        },
      });
      if (error) {
        return { ok: false, error: error.message };
      }
      if (!data.user) {
        return { ok: false, error: "Could not create account" };
      }
      await ensurePrismaUser({
        ...data.user,
        user_metadata: { ...data.user.user_metadata, name: parsed.data.name },
      });
      userId = data.user.id;

      if (!data.session) {
        return {
          ok: true,
          needsVerification: true,
          message: "Confirm your email, then open the invite link again.",
        };
      }
    } else {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (
        user?.email &&
        user.email.toLowerCase() !== invitation.email.toLowerCase()
      ) {
        return {
          ok: false,
          error: "Signed-in email does not match the invitation",
        };
      }
    }

    await prisma.$transaction(async (tx) => {
      const member = await tx.organizationMember.create({
        data: {
          organizationId: invitation.organizationId,
          userId: userId!,
          roleId: invitation.roleId,
          isOwner: false,
          status: MemberStatus.ACTIVE,
        },
      });

      // New members start with access to the default company; admins adjust scopes later.
      const defaultCompany = await tx.company.findFirst({
        where: { organizationId: invitation.organizationId, isDefault: true },
        select: { id: true },
      });
      if (defaultCompany) {
        await tx.memberScope.create({
          data: {
            organizationId: invitation.organizationId,
            memberId: member.id,
            companyId: defaultCompany.id,
          },
        });
      }

      await tx.user.update({
        where: { id: userId! },
        data: { activeOrganizationId: invitation.organizationId },
      });

      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: InvitationStatus.ACCEPTED },
      });

      await tx.auditLog.create({
        data: {
          organizationId: invitation.organizationId,
          userId: userId!,
          action: "member.joined",
          entity: "OrganizationMember",
          next: { invitationId: invitation.id },
        },
      });
    });

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    console.error(error);
    return { ok: false, error: "Failed to accept invitation" };
  }
}
