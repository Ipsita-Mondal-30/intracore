"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db/prisma";
import { requirePermission } from "@/lib/tenant";
import { leadVisibilityWhere } from "@/features/leads/scope";
import { isAppError } from "@/lib/errors";
import type { ActionResult } from "@/features/auth/types";
import { computeFullName } from "@/lib/validations/leads";
import {
  dialUpdateSchema,
  parseDialUpdateDate,
  type DialUpdateInput,
} from "@/lib/validations/dial-update";
import { recordActivity } from "@/lib/leads/activity";
import { LEAD_ACTIVITY_TYPES } from "@/lib/leads/activity-types";
import { syncLeadNextFollowUpAt } from "@/lib/leads/follow-up-sync";

export async function dialUpdateCustomerAction(
  input: DialUpdateInput,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("lead.edit");
    const parsed = dialUpdateSchema.safeParse(input);

    if (!parsed.success) {
      return {
        ok: false,
        error: parsed.error.issues[0]?.message ?? "Invalid input",
      };
    }

    const data = parsed.data;
    const lead = await prisma.lead.findFirst({
      where: { id: data.leadId, ...leadVisibilityWhere(tenant) },
    });
    if (!lead) return { ok: false, error: "Lead not found" };

    if (data.stageId) {
      const stage = await prisma.leadStage.findFirst({
        where: { id: data.stageId, organizationId: tenant.organizationId },
      });
      if (!stage) return { ok: false, error: "Stage not found" };
    }

    const fullName = computeFullName({
      firstName: data.firstName,
      lastName: data.lastName,
      company: lead.company,
    });

    const nextFollowUpAt =
      parseDialUpdateDate(data.nextFollowUpAt) ?? lead.nextFollowUpAt;
    const callbackAt = parseDialUpdateDate(data.callbackAt) ?? lead.callbackAt;
    const now = new Date();
    const newStageId = data.stageId || lead.stageId;

    await prisma.$transaction(async (tx) => {
      await tx.leadReengagement.create({
        data: {
          organizationId: tenant.organizationId,
          leadId: lead.id,
          reengagedAt: now,
          previousStageId: lead.stageId,
          newStageId: newStageId || null,
          followUpAt: nextFollowUpAt,
          nextCallDueAt: callbackAt,
          notes: data.comments?.trim() || null,
          createdById: tenant.userId,
        },
      });

      await tx.lead.update({
        where: { id: lead.id },
        data: {
          firstName: data.firstName || null,
          lastName: data.lastName || null,
          fullName,
          email: data.email || null,
          phone: data.phone,
          alternatePhone: data.alternatePhone || null,
          address: data.address || null,
          stageId: newStageId,
          status: data.status ?? lead.status,
          priority: data.priority ?? lead.priority,
          nextFollowUpAt,
          callbackAt,
          reEngagedAt: now,
          lastContactedAt: now,
        },
      });

      if (data.comments?.trim()) {
        await tx.leadNote.create({
          data: {
            organizationId: tenant.organizationId,
            leadId: lead.id,
            authorId: tenant.userId,
            content: data.comments.trim(),
          },
        });
      }

      if (data.customFields && Object.keys(data.customFields).length > 0) {
        const fields = await tx.leadCustomFieldDefinition.findMany({
          where: { organizationId: tenant.organizationId, isActive: true },
        });
        for (const field of fields) {
          const value = data.customFields[field.key]?.trim() ?? "";
          await tx.leadCustomFieldValue.upsert({
            where: { leadId_fieldId: { leadId: lead.id, fieldId: field.id } },
            create: {
              organizationId: tenant.organizationId,
              leadId: lead.id,
              fieldId: field.id,
              value: value || null,
            },
            update: { value: value || null },
          });
        }
      }
    });

    await syncLeadNextFollowUpAt(lead.id);

    if (data.priority && data.priority !== lead.priority) {
      await recordActivity({
        organizationId: tenant.organizationId,
        leadId: lead.id,
        actorId: tenant.userId,
        type: LEAD_ACTIVITY_TYPES.PRIORITY_CHANGED,
        message: `Priority changed to ${data.priority}`,
        previous: { priority: lead.priority },
        next: { priority: data.priority },
      });
    }

    if (data.phone !== lead.phone) {
      await recordActivity({
        organizationId: tenant.organizationId,
        leadId: lead.id,
        actorId: tenant.userId,
        type: LEAD_ACTIVITY_TYPES.PHONE_CHANGED,
        message: "Phone number updated",
        previous: { phone: lead.phone },
        next: { phone: data.phone },
      });
    }

    if (newStageId && newStageId !== lead.stageId) {
      await recordActivity({
        organizationId: tenant.organizationId,
        leadId: lead.id,
        actorId: tenant.userId,
        type: LEAD_ACTIVITY_TYPES.STAGE_CHANGED,
        message: "Stage updated from dial & update",
        previous: { stageId: lead.stageId },
        next: { stageId: newStageId },
      });
    }

    await recordActivity({
      organizationId: tenant.organizationId,
      leadId: lead.id,
      actorId: tenant.userId,
      type: LEAD_ACTIVITY_TYPES.REENGAGED,
      message: "Dial & update customer info saved",
      previous: {
        status: lead.status,
        stageId: lead.stageId,
        phone: lead.phone,
      },
      next: {
        status: data.status ?? lead.status,
        stageId: newStageId,
        phone: data.phone,
      },
    });

    revalidatePath("/leads/re-engaged");
    revalidatePath(`/leads/re-engaged/${lead.id}`);
    revalidatePath(`/leads/${lead.id}`);
    return { ok: true, message: "Lead updated" };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    console.error(error);
    return { ok: false, error: "Failed to update lead" };
  }
}

/** @deprecated Use dialUpdateCustomerAction */
export async function updateReEngagedLeadAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const customFields: Record<string, string> = {};
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("cf_") && typeof value === "string") {
      customFields[key.slice(3)] = value;
    }
  }

  return dialUpdateCustomerAction({
    leadId: String(formData.get("leadId") ?? ""),
    firstName: String(formData.get("firstName") ?? "") || undefined,
    lastName: String(formData.get("lastName") ?? "") || undefined,
    email: String(formData.get("email") ?? ""),
    phone: String(formData.get("phone") ?? ""),
    alternatePhone: String(formData.get("alternatePhone") ?? "") || undefined,
    address: String(formData.get("address") ?? "") || undefined,
    stageId: String(formData.get("stageId") ?? "") || undefined,
    status: (String(formData.get("status") ?? "") || undefined) as DialUpdateInput["status"],
    priority: (String(formData.get("priority") ?? "") || undefined) as DialUpdateInput["priority"],
    nextFollowUpAt: String(formData.get("nextFollowUpAt") ?? "") || undefined,
    callbackAt:
      String(formData.get("callbackAt") ?? formData.get("callbackDate") ?? "") ||
      undefined,
    comments: String(formData.get("comments") ?? "") || undefined,
    customFields: Object.keys(customFields).length > 0 ? customFields : undefined,
  });
}

export async function markLeadReEngagedAction(
  leadId: string,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("lead.edit");
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, ...leadVisibilityWhere(tenant) },
    });
    if (!lead) return { ok: false, error: "Lead not found" };

    await prisma.lead.update({
      where: { id: leadId },
      data: { reEngagedAt: lead.reEngagedAt ?? new Date() },
    });
    await recordActivity({
      organizationId: tenant.organizationId,
      leadId,
      actorId: tenant.userId,
      type: LEAD_ACTIVITY_TYPES.REENGAGED,
      message: `Re-engaged on ${new Date().toLocaleDateString("en-GB")}`,
    });

    revalidatePath("/leads/re-engaged");
    revalidatePath(`/leads/re-engaged/${leadId}`);
    revalidatePath(`/leads/${leadId}`);
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: "Failed to mark re-engaged" };
  }
}
