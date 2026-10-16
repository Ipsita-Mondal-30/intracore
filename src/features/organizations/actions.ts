"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db/prisma";
import { requireAuth, requirePermission } from "@/lib/tenant";
import { seedOrganizationRoles } from "@/lib/permissions/seed-org-roles";
import { seedOrganizationLeadDefaults } from "@/lib/leads/seed-defaults";
import { seedDefaultCompany } from "@/features/companies/service";
import {
  createOrganizationSchema,
  slugify,
  updateOrganizationSchema,
} from "@/lib/validations/auth";
import { isAppError } from "@/lib/errors";
import { getDatabaseErrorMessage } from "@/lib/db/error-message";
import type { ActionResult } from "@/features/auth/types";
import { ensurePermissionsSeeded } from "@/lib/permissions/seed-org-roles";

async function uniqueSlug(base: string): Promise<string> {
  const slug = slugify(base) || "organization";
  let candidate = slug;
  let i = 1;
  while (await prisma.organization.findUnique({ where: { slug: candidate } })) {
    candidate = `${slug}-${i}`;
    i += 1;
  }
  return candidate;
}

export async function createOrganizationAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const session = await requireAuth();

    const parsed = createOrganizationSchema.safeParse({
      name: formData.get("name"),
      industry: formData.get("industry") || undefined,
      country: formData.get("country") || undefined,
      currency: formData.get("currency") || "USD",
      timezone: formData.get("timezone") || "UTC",
      contactEmail: formData.get("contactEmail") || undefined,
      contactPhone: formData.get("contactPhone") || undefined,
    });

    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Invalid input",
      };
    }

    const existingMembership = await prisma.organizationMember.findFirst({
      where: { userId: session.userId, status: "ACTIVE" },
    });
    if (existingMembership) {
      return {
        ok: false,
        error: "You already belong to an organization",
      };
    }

    const slug = await uniqueSlug(parsed.data.name);

    // Global permission catalog is shared across orgs; seed outside the transaction
    // to keep org creation fast enough for serverless timeouts.
    await ensurePermissionsSeeded(prisma);

    await prisma.$transaction(
      async (tx) => {
        const org = await tx.organization.create({
          data: {
            name: parsed.data.name,
            slug,
            industry: parsed.data.industry,
            country: parsed.data.country,
            currency: parsed.data.currency,
            timezone: parsed.data.timezone,
            contactEmail: parsed.data.contactEmail || null,
            contactPhone: parsed.data.contactPhone || null,
          },
        });

        const rolesByCode = await seedOrganizationRoles(tx, org.id, {
          skipPermissionSeed: true,
        });
        await seedOrganizationLeadDefaults(tx, org.id);
        await seedDefaultCompany(tx, org);
        const ownerRoleId = rolesByCode.get("owner");
        if (!ownerRoleId) {
          throw new Error("Owner role was not created");
        }

        await tx.organizationMember.create({
          data: {
            organizationId: org.id,
            userId: session.userId,
            roleId: ownerRoleId,
            isOwner: true,
            status: "ACTIVE",
          },
        });

        await tx.user.update({
          where: { id: session.userId },
          data: { activeOrganizationId: org.id },
        });

        await tx.auditLog.create({
          data: {
            organizationId: org.id,
            userId: session.userId,
            action: "organization.created",
            entity: "Organization",
            entityId: org.id,
            next: { name: org.name, slug: org.slug },
          },
        });
      },
      { timeout: 60_000 },
    );

    revalidatePath("/", "layout");
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    console.error("createOrganizationAction failed", error);
    const message =
      error instanceof Error && error.message.includes("P2028")
        ? "Organization setup timed out. Please try again."
        : getDatabaseErrorMessage(error);
    return { ok: false, error: message, code: "ORG_CREATE" };
  }
}

export async function updateOrganizationAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("org.update");

    const parsed = updateOrganizationSchema.safeParse({
      name: formData.get("name") || undefined,
      industry: formData.get("industry") || null,
      country: formData.get("country") || null,
      currency: formData.get("currency") || undefined,
      timezone: formData.get("timezone") || undefined,
      contactEmail: formData.get("contactEmail") || null,
      contactPhone: formData.get("contactPhone") || null,
    });

    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Invalid input",
      };
    }

    const previous = await prisma.organization.findUnique({
      where: { id: tenant.organizationId },
    });

    await prisma.organization.update({
      where: { id: tenant.organizationId },
      data: {
        ...parsed.data,
        contactEmail: parsed.data.contactEmail || null,
      },
    });

    await prisma.auditLog.create({
      data: {
        organizationId: tenant.organizationId,
        userId: tenant.userId,
        action: "organization.updated",
        entity: "Organization",
        entityId: tenant.organizationId,
        previous: previous
          ? {
              name: previous.name,
              industry: previous.industry,
              country: previous.country,
            }
          : undefined,
        next: parsed.data,
      },
    });

    revalidatePath("/settings/organization");
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    console.error(error);
    return { ok: false, error: "Failed to update organization" };
  }
}
