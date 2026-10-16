"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db/prisma";
import { requirePermission } from "@/lib/tenant";
import { leadVisibilityWhere } from "@/features/leads/scope";
import { isAppError } from "@/lib/errors";
import { recordActivity } from "@/lib/leads/activity";
import { LEAD_ACTIVITY_TYPES } from "@/lib/leads/activity-types";
import type { CustomFieldType } from "@prisma/client";

function slugKey(label: string) {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 40);
}

export async function createCustomFieldAction(formData: FormData): Promise<void> {
  try {
    const tenant = await requirePermission("lead.manage_custom_fields");
    const label = String(formData.get("label") ?? "").trim();
    if (!label) return;
    const type = String(formData.get("type") ?? "TEXT") as CustomFieldType;
    const section = String(formData.get("section") ?? "profile").trim() || "profile";
    const key = slugKey(String(formData.get("key") ?? label));
    const optionsRaw = String(formData.get("options") ?? "").trim();
    const options = optionsRaw
      ? optionsRaw.split(",").map((o) => o.trim()).filter(Boolean)
      : null;

    await prisma.leadCustomFieldDefinition.create({
      data: {
        organizationId: tenant.organizationId,
        key,
        label,
        type,
        section,
        options: options ? options : undefined,
      },
    });
    revalidatePath("/settings/custom-fields");
  } catch (error) {
    if (!isAppError(error)) console.error(error);
  }
}

export async function toggleCustomFieldAction(formData: FormData): Promise<void> {
  try {
    const tenant = await requirePermission("lead.manage_custom_fields");
    const id = String(formData.get("id") ?? "");
    const field = await prisma.leadCustomFieldDefinition.findFirst({
      where: { id, organizationId: tenant.organizationId },
    });
    if (!field) return;
    await prisma.leadCustomFieldDefinition.update({
      where: { id },
      data: { isActive: !field.isActive },
    });
    revalidatePath("/settings/custom-fields");
  } catch (error) {
    if (!isAppError(error)) console.error(error);
  }
}

export async function saveLeadCustomFieldsAction(
  leadId: string,
  values: Record<string, string>,
): Promise<void> {
  const tenant = await requirePermission("lead.edit");
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, ...leadVisibilityWhere(tenant) },
  });
  if (!lead) return;

  const fields = await prisma.leadCustomFieldDefinition.findMany({
    where: { organizationId: tenant.organizationId, isActive: true },
  });

  for (const field of fields) {
    const value = values[field.key]?.trim() ?? "";
    await prisma.leadCustomFieldValue.upsert({
      where: { leadId_fieldId: { leadId, fieldId: field.id } },
      create: {
        organizationId: tenant.organizationId,
        leadId,
        fieldId: field.id,
        value: value || null,
      },
      update: { value: value || null },
    });
  }

  await recordActivity({
    organizationId: tenant.organizationId,
    leadId,
    actorId: tenant.userId,
    type: LEAD_ACTIVITY_TYPES.CUSTOM_FIELD_UPDATED,
    message: "Custom fields updated",
  });

  revalidatePath(`/leads/${leadId}`);
}

export async function createFlagDefinitionAction(formData: FormData): Promise<void> {
  try {
    const tenant = await requirePermission("lead.manage_flags");
    const label = String(formData.get("label") ?? "").trim();
    if (!label) return;
    const key = slugKey(String(formData.get("key") ?? label));
    const color = String(formData.get("color") ?? "").trim() || null;
    await prisma.leadFlagDefinition.create({
      data: {
        organizationId: tenant.organizationId,
        key,
        label,
        color,
      },
    });
    revalidatePath("/settings/lead-flags");
  } catch (error) {
    if (!isAppError(error)) console.error(error);
  }
}

export async function toggleFlagDefinitionAction(formData: FormData): Promise<void> {
  try {
    const tenant = await requirePermission("lead.manage_flags");
    const id = String(formData.get("id") ?? "");
    const flag = await prisma.leadFlagDefinition.findFirst({
      where: { id, organizationId: tenant.organizationId },
    });
    if (!flag) return;
    await prisma.leadFlagDefinition.update({
      where: { id },
      data: { isActive: !flag.isActive },
    });
    revalidatePath("/settings/lead-flags");
  } catch (error) {
    if (!isAppError(error)) console.error(error);
  }
}

export async function syncLeadFlagsAction(
  leadId: string,
  flagKeys: string[],
): Promise<void> {
  const tenant = await requirePermission("lead.edit");
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, ...leadVisibilityWhere(tenant) },
  });
  if (!lead) return;

  const flags = await prisma.leadFlagDefinition.findMany({
    where: {
      organizationId: tenant.organizationId,
      key: { in: flagKeys },
      isActive: true,
    },
  });

  await prisma.leadFlagOnLead.deleteMany({ where: { leadId } });
  if (flags.length > 0) {
    await prisma.leadFlagOnLead.createMany({
      data: flags.map((flag) => ({ leadId, flagId: flag.id })),
      skipDuplicates: true,
    });
  }

  await recordActivity({
    organizationId: tenant.organizationId,
    leadId,
    actorId: tenant.userId,
    type: LEAD_ACTIVITY_TYPES.FLAG_CHANGED,
    message: "Lead flags updated",
    next: { flags: flagKeys },
  });

  revalidatePath(`/leads/${leadId}`);
}

export async function updateLeadScoreAction(
  leadId: string,
  score: number,
  breakdown?: Record<string, number>,
): Promise<void> {
  const tenant = await requirePermission("lead.edit");
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, ...leadVisibilityWhere(tenant) },
  });
  if (!lead) return;

  const now = new Date();
  await prisma.$transaction([
    prisma.lead.update({
      where: { id: leadId },
      data: { leadScore: score, lastScoreUpdatedAt: now },
    }),
    prisma.leadScoreSnapshot.create({
      data: {
        organizationId: tenant.organizationId,
        leadId,
        score,
        breakdown: breakdown ?? undefined,
      },
    }),
  ]);

  await recordActivity({
    organizationId: tenant.organizationId,
    leadId,
    actorId: tenant.userId,
    type: LEAD_ACTIVITY_TYPES.SCORE_UPDATED,
    message: `Score updated to ${score}`,
    previous: { leadScore: lead.leadScore },
    next: { leadScore: score, breakdown: breakdown ?? null },
  });

  revalidatePath(`/leads/${leadId}`);
}
