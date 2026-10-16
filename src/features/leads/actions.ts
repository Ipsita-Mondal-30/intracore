"use server";

import { revalidatePath } from "next/cache";
import { LeadPriority, LeadStatus, type Prisma } from "@prisma/client";
import { ZodError } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requirePermission } from "@/lib/tenant";
import { isAppError } from "@/lib/errors";
import type { ActionResult } from "@/features/auth/types";
import {
  computeFullName,
  leadFormSchema,
  parseTagNames,
} from "@/lib/validations/leads";
import { findDuplicateLeads, type DuplicateMatch } from "@/lib/leads/duplicates";
import { recordActivity } from "@/lib/leads/activity";
import { syncLeadTags } from "@/lib/leads/tags";
import { LOST_REASONS } from "@/lib/leads/lost-reasons";
import { leadVisibilityWhere } from "@/features/leads/scope";
import { notifyLeadAssigned } from "@/lib/email/crm-notify";
import { assertActiveMember, assertLeadRefs } from "@/lib/tenant/refs";

const CONVERTED_LOCKED =
  "This lead has been converted to a customer; continue on the customer and opportunity.";

export type LeadActionResult =
  | { ok: true; message?: string; leadId?: string }
  | {
      ok: false;
      error: string;
      code?: string;
      duplicates?: DuplicateMatch[];
    };

function formString(formData: FormData, key: string) {
  const value = String(formData.get(key) ?? "").trim();
  return value.length ? value : undefined;
}

function leadPayload(formData: FormData) {
  return leadFormSchema.parse({
    firstName: formString(formData, "firstName"),
    lastName: formString(formData, "lastName"),
    company: formString(formData, "company"),
    email: formString(formData, "email") ?? "",
    phone: formString(formData, "phone"),
    alternatePhone: formString(formData, "alternatePhone"),
    whatsappNumber: formString(formData, "whatsappNumber"),
    website: formString(formData, "website"),
    gstNo: formString(formData, "gstNo"),
    jobTitle: formString(formData, "jobTitle"),
    address: formString(formData, "address"),
    city: formString(formData, "city"),
    state: formString(formData, "state"),
    country: formString(formData, "country"),
    postalCode: formString(formData, "postalCode"),
    industry: formString(formData, "industry"),
    companySize: formString(formData, "companySize"),
    requirement: formString(formData, "requirement"),
    productId: formString(formData, "productId") ?? "",
    expectedValue: formString(formData, "expectedValue")
      ? Number(formData.get("expectedValue"))
      : undefined,
    budget: formString(formData, "budget"),
    purchaseTimeline: formString(formData, "purchaseTimeline"),
    sourceId: formString(formData, "sourceId"),
    sourceDetail: formString(formData, "sourceDetail"),
    campaign: formString(formData, "campaign"),
    status: formString(formData, "status"),
    stageId: formString(formData, "stageId"),
    pipelineId: formString(formData, "pipelineId"),
    priority: formString(formData, "priority"),
    leadScore: formString(formData, "leadScore"),
    assignedUserId: formString(formData, "assignedUserId") ?? "",
    assignedTeamId: formString(formData, "assignedTeamId") ?? "",
    tags: formString(formData, "tags") ?? "",
    description: formString(formData, "description"),
    initialNote: formString(formData, "initialNote"),
    forceCreate: formData.get("forceCreate") === "true",
  });
}

async function resolvePipeline(
  organizationId: string,
  stageId?: string,
  pipelineId?: string,
) {
  if (pipelineId) return pipelineId;
  if (stageId) {
    const stage = await prisma.leadStage.findFirst({
      where: { id: stageId, organizationId },
    });
    return stage?.pipelineId;
  }
  const def = await prisma.pipeline.findFirst({
    where: { organizationId, isDefault: true },
  });
  return def?.id;
}

async function resolveProductFields(
  organizationId: string,
  productId?: string,
) {
  if (!productId) {
    return { productId: null as string | null, productInterest: null as string | null };
  }
  const product = await prisma.leadProduct.findFirst({
    where: { id: productId, organizationId },
  });
  if (!product) {
    return { productId: null, productInterest: null };
  }
  return { productId: product.id, productInterest: product.name };
}

export async function createLeadAction(
  _prev: LeadActionResult | null,
  formData: FormData,
): Promise<LeadActionResult> {
  try {
    const tenant = await requirePermission("lead.create");
    const data = leadPayload(formData);
    await assertLeadRefs(tenant.organizationId, {
      sourceId: data.sourceId,
      pipelineId: data.pipelineId,
      stageId: data.stageId,
      assignedUserId: data.assignedUserId || null,
      assignedTeamId: data.assignedTeamId || null,
    });
    const email = data.email || null;

    const duplicates = await findDuplicateLeads(tenant.organizationId, {
      email,
      phone: data.phone,
      whatsappNumber: data.whatsappNumber,
      company: data.company,
    });
    if (duplicates.length > 0 && !data.forceCreate) {
      return {
        ok: false,
        error: "Possible duplicates found. Confirm to create anyway.",
        code: "DUPLICATE",
        duplicates,
      };
    }

    const pipelineId = await resolvePipeline(
      tenant.organizationId,
      data.stageId,
      data.pipelineId,
    );
    const fullName = computeFullName(data);
    const productFields = await resolveProductFields(
      tenant.organizationId,
      data.productId,
    );

    const lead = await prisma.lead.create({
      data: {
        organizationId: tenant.organizationId,
        firstName: data.firstName,
        lastName: data.lastName,
        fullName,
        company: data.company,
        email,
        phone: data.phone,
        alternatePhone: data.alternatePhone,
        whatsappNumber: data.whatsappNumber,
        website: data.website || null,
        gstNo: data.gstNo || null,
        address: data.address || null,
        city: data.city || null,
        state: data.state || null,
        country: data.country || null,
        postalCode: data.postalCode || null,
        industry: data.industry,
        jobTitle: data.jobTitle,
        companySize: data.companySize,
        requirement: data.requirement,
        productId: productFields.productId,
        productInterest: productFields.productInterest,
        expectedValue: data.expectedValue,
        budget: data.budget,
        purchaseTimeline: data.purchaseTimeline,
        sourceId: data.sourceId,
        sourceDetail: data.sourceDetail,
        campaign: data.campaign,
        status: data.status ?? LeadStatus.NEW,
        stageId: data.stageId || null,
        pipelineId,
        leadScore: data.leadScore ?? 0,
        priority: data.priority ?? LeadPriority.MEDIUM,
        assignedUserId: data.assignedUserId || null,
        assignedTeamId: data.assignedTeamId || null,
        description: data.description || null,
      },
    });

    await recordActivity({
      organizationId: tenant.organizationId,
      leadId: lead.id,
      actorId: tenant.userId,
      type: "CREATED",
      message: `Lead created: ${fullName}`,
    });

    if (lead.assignedUserId) {
      await recordActivity({
        organizationId: tenant.organizationId,
        leadId: lead.id,
        actorId: tenant.userId,
        type: "ASSIGNED",
        message: "Lead assigned",
        next: { assignedUserId: lead.assignedUserId },
      });
      await notifyLeadAssigned({
        organizationId: tenant.organizationId,
        organizationName: tenant.organizationName,
        leadId: lead.id,
        leadName: fullName,
        assignedUserId: lead.assignedUserId,
        actorUserId: tenant.userId,
        actorName: tenant.userName ?? tenant.userEmail,
      });
    }

    await syncLeadTags(tenant.organizationId, lead.id, data.tags);
    if (data.initialNote) {
      await prisma.leadNote.create({
        data: {
          organizationId: tenant.organizationId,
          leadId: lead.id,
          authorId: tenant.userId,
          content: data.initialNote,
        },
      });
      await recordActivity({
        organizationId: tenant.organizationId,
        leadId: lead.id,
        actorId: tenant.userId,
        type: "NOTE_ADDED",
        message: "Initial note added",
      });
    }

    revalidatePath("/leads");
    revalidatePath("/dashboard");
    return { ok: true, leadId: lead.id };
  } catch (error) {
    if (error instanceof ZodError) {
      return { ok: false, error: error.issues[0]?.message ?? "Invalid lead" };
    }
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    console.error(error);
    return { ok: false, error: "Failed to create lead" };
  }
}

export async function updateLeadAction(
  _prev: LeadActionResult | null,
  formData: FormData,
): Promise<LeadActionResult> {
  try {
    const tenant = await requirePermission("lead.edit");
    const leadId = String(formData.get("leadId") ?? "");
    const existing = await prisma.lead.findFirst({
      where: { id: leadId, ...leadVisibilityWhere(tenant) },
    });
    if (!existing) {
      return { ok: false, error: "Lead not found" };
    }

    const data = leadPayload(formData);
    await assertLeadRefs(tenant.organizationId, {
      sourceId: data.sourceId,
      pipelineId: data.pipelineId,
      stageId: data.stageId,
      assignedUserId: data.assignedUserId || null,
      assignedTeamId: data.assignedTeamId || null,
    });
    const email = data.email || null;
    const fullName = computeFullName(data);
    const pipelineId = await resolvePipeline(
      tenant.organizationId,
      data.stageId,
      data.pipelineId,
    );
    const productFields = await resolveProductFields(
      tenant.organizationId,
      data.productId,
    );

    const callbackAtRaw = String(formData.get("callbackAt") ?? "").trim();
    const nextFollowUpAtRaw = String(formData.get("nextFollowUpAt") ?? "").trim();
    const callbackAt = callbackAtRaw ? new Date(callbackAtRaw) : undefined;
    const nextFollowUpAt = nextFollowUpAtRaw ? new Date(nextFollowUpAtRaw) : undefined;

    await prisma.lead.update({
      where: { id: leadId },
      data: {
        firstName: data.firstName,
        lastName: data.lastName,
        fullName,
        company: data.company,
        email,
        phone: data.phone,
        alternatePhone: data.alternatePhone,
        whatsappNumber: data.whatsappNumber,
        website: data.website || null,
        gstNo: data.gstNo || null,
        address: data.address || null,
        city: data.city || null,
        state: data.state || null,
        country: data.country || null,
        postalCode: data.postalCode || null,
        industry: data.industry,
        jobTitle: data.jobTitle,
        companySize: data.companySize,
        requirement: data.requirement,
        productId: productFields.productId,
        productInterest: productFields.productInterest,
        expectedValue: data.expectedValue,
        budget: data.budget,
        purchaseTimeline: data.purchaseTimeline,
        sourceId: data.sourceId,
        sourceDetail: data.sourceDetail,
        campaign: data.campaign,
        priority: data.priority ?? existing.priority,
        leadScore: data.leadScore ?? existing.leadScore,
        assignedUserId: data.assignedUserId || null,
        assignedTeamId: data.assignedTeamId || null,
        description: data.description,
        pipelineId,
        stageId: data.stageId,
        ...(callbackAtRaw ? { callbackAt: callbackAt ?? null } : {}),
        ...(nextFollowUpAtRaw ? { nextFollowUpAt: nextFollowUpAt ?? null } : {}),
      },
    });

    await syncLeadTags(tenant.organizationId, leadId, data.tags);

    await recordActivity({
      organizationId: tenant.organizationId,
      leadId,
      actorId: tenant.userId,
      type: "UPDATED",
      message: "Lead details updated",
    });

    const nextAssignee = data.assignedUserId || null;
    if (nextAssignee && nextAssignee !== existing.assignedUserId) {
      await notifyLeadAssigned({
        organizationId: tenant.organizationId,
        organizationName: tenant.organizationName,
        leadId,
        leadName: fullName,
        assignedUserId: nextAssignee,
        actorUserId: tenant.userId,
        actorName: tenant.userName ?? tenant.userEmail,
      });
    }

    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/leads");
    return { ok: true, leadId };
  } catch (error) {
    if (error instanceof ZodError) {
      return { ok: false, error: error.issues[0]?.message ?? "Invalid lead" };
    }
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    console.error(error);
    return { ok: false, error: "Failed to update lead" };
  }
}

export async function archiveLeadAction(leadId: string): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("lead.delete");
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, ...leadVisibilityWhere(tenant) },
    });
    if (!lead) return { ok: false, error: "Lead not found" };

    await prisma.lead.update({
      where: { id: leadId },
      data: { archivedAt: new Date() },
    });
    revalidatePath("/leads");
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: "Failed to archive lead" };
  }
}

export async function assignLeadAction(
  leadId: string,
  assignedUserId: string | null,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("lead.assign");
    if (assignedUserId) await assertActiveMember(tenant.organizationId, assignedUserId);
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, ...leadVisibilityWhere(tenant) },
    });
    if (!lead) return { ok: false, error: "Lead not found" };

    await prisma.lead.update({
      where: { id: leadId },
      data: { assignedUserId },
    });
    await recordActivity({
      organizationId: tenant.organizationId,
      leadId,
      actorId: tenant.userId,
      type: "ASSIGNED",
      message: assignedUserId ? "Lead assignment changed" : "Lead unassigned",
      previous: { assignedUserId: lead.assignedUserId },
      next: { assignedUserId },
    });
    if (assignedUserId && assignedUserId !== lead.assignedUserId) {
      await notifyLeadAssigned({
        organizationId: tenant.organizationId,
        organizationName: tenant.organizationName,
        leadId,
        leadName: lead.fullName,
        assignedUserId,
        actorUserId: tenant.userId,
        actorName: tenant.userName ?? tenant.userEmail,
      });
    }
    revalidatePath(`/leads/${leadId}`);
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: "Failed to assign lead" };
  }
}

export async function changeLeadStageAction(
  leadId: string,
  stageId: string,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("lead.change_stage");
    const [lead, stage] = await Promise.all([
      prisma.lead.findFirst({
        where: { id: leadId, ...leadVisibilityWhere(tenant) },
      }),
      prisma.leadStage.findFirst({
        where: { id: stageId, organizationId: tenant.organizationId },
      }),
    ]);
    if (!lead || !stage) return { ok: false, error: "Lead or stage not found" };
    if (lead.convertedCustomerId) return { ok: false, error: CONVERTED_LOCKED };
    if (stage.isWon) await requirePermission("lead.convert");

    let status: LeadStatus | undefined;
    if (stage.isWon) status = LeadStatus.CONVERTED;
    if (stage.isLost) status = LeadStatus.LOST;

    await prisma.lead.update({
      where: { id: leadId },
      data: {
        stageId: stage.id,
        pipelineId: stage.pipelineId,
        ...(status
          ? {
              status,
              convertedAt: status === "CONVERTED" ? new Date() : lead.convertedAt,
            }
          : {}),
      },
    });
    await recordActivity({
      organizationId: tenant.organizationId,
      leadId,
      actorId: tenant.userId,
      type: "STAGE_CHANGED",
      message: `Stage changed to ${stage.name}`,
      previous: { stageId: lead.stageId },
      next: { stageId: stage.id },
    });
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: "Failed to change stage" };
  }
}

export async function changeLeadStatusAction(
  leadId: string,
  status: LeadStatus,
  lostReason?: string,
  lostComment?: string,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("lead.edit");
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, ...leadVisibilityWhere(tenant) },
    });
    if (!lead) return { ok: false, error: "Lead not found" };
    if (lead.convertedCustomerId) return { ok: false, error: CONVERTED_LOCKED };

    if (status === "CONVERTED") {
      await requirePermission("lead.convert");
    }
    if (status === "LOST") {
      const reason = lostReason?.trim();
      if (!reason || !LOST_REASONS.includes(reason as (typeof LOST_REASONS)[number])) {
        return { ok: false, error: "A lost reason is required" };
      }
    }

    await prisma.lead.update({
      where: { id: leadId },
      data: {
        status,
        lostReason: status === "LOST" ? lostReason : null,
        lostComment: status === "LOST" ? lostComment?.trim() || null : null,
        convertedAt: status === "CONVERTED" ? new Date() : lead.convertedAt,
      },
    });
    await recordActivity({
      organizationId: tenant.organizationId,
      leadId,
      actorId: tenant.userId,
      type:
        status === "LOST"
          ? "MARKED_LOST"
          : status === "CONVERTED"
            ? "CONVERTED"
            : "STATUS_CHANGED",
      message:
        status === "LOST"
          ? `Lead marked lost${lostReason ? `: ${lostReason}` : ""}`
          : status === "CONVERTED"
            ? "Lead converted"
            : `Status changed to ${status}`,
      previous: { status: lead.status },
      next: { status, lostReason: lostReason ?? null, lostComment: lostComment ?? null },
    });
    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: "Failed to update status" };
  }
}

async function scopedLeads(ids: string[], tenant: Awaited<ReturnType<typeof requirePermission>>) {
  return prisma.lead.findMany({
    where: {
      id: { in: ids },
      ...leadVisibilityWhere(tenant),
      archivedAt: null,
    },
    select: { id: true, convertedCustomerId: true },
  });
}

export async function bulkLeadAction(formData: FormData): Promise<ActionResult> {
  try {
    const op = String(formData.get("op") ?? "");
    const ids = String(formData.get("leadIds") ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    if (ids.length === 0) return { ok: false, error: "Select at least one lead" };

    const permission =
      op === "archive"
        ? "lead.delete"
        : op === "assign"
          ? "lead.assign"
          : op === "stage"
            ? "lead.change_stage"
            : "lead.edit";
    const tenant = await requirePermission(permission);
    const scoped = (await scopedLeads(ids, tenant)).filter(
      (lead) => !(lead.convertedCustomerId && (op === "stage" || op === "status")),
    );
    const scopedIds = scoped.map((l) => l.id);
    if (scopedIds.length === 0) return { ok: false, error: "No matching leads" };

    const data: Prisma.LeadUncheckedUpdateManyInput = {};
    if (op === "assign") {
      const assignedUserId = String(formData.get("assignedUserId") ?? "") || null;
      if (assignedUserId) await assertActiveMember(tenant.organizationId, assignedUserId);
      data.assignedUserId = assignedUserId;
    } else if (op === "stage") {
      const stageId = String(formData.get("stageId") ?? "");
      const stage = await prisma.leadStage.findFirst({
        where: { id: stageId, organizationId: tenant.organizationId },
      });
      if (!stage) return { ok: false, error: "Stage not found" };
      if (stage.isWon) await requirePermission("lead.convert");
      data.stageId = stage.id;
      data.pipelineId = stage.pipelineId;
    } else if (op === "status") {
      const status = String(formData.get("status") ?? "") as LeadStatus;
      if (status === "LOST") {
        const reason = String(formData.get("lostReason") ?? "").trim();
        if (!LOST_REASONS.includes(reason as (typeof LOST_REASONS)[number])) {
          return { ok: false, error: "A lost reason is required" };
        }
        data.status = LeadStatus.LOST;
        data.lostReason = reason;
      } else if (status === "CONVERTED") {
        await requirePermission("lead.convert");
        data.status = LeadStatus.CONVERTED;
        data.convertedAt = new Date();
      } else {
        data.status = status;
      }
    } else if (op === "priority") {
      data.priority = String(formData.get("priority") ?? "") as LeadPriority;
    } else if (op === "archive") {
      data.archivedAt = new Date();
    } else if (op === "tag") {
      const names = parseTagNames(String(formData.get("tags") ?? ""));
      for (const leadId of scopedIds) {
        const existing = await prisma.leadTagOnLead.findMany({
          where: { leadId },
          include: { tag: true },
        });
        const current = existing.map((row) => row.tag.name).join(",");
        await syncLeadTags(
          tenant.organizationId,
          leadId,
          [...current.split(","), ...names].join(","),
        );
      }
      revalidatePath("/leads");
      return { ok: true, message: `Updated ${scopedIds.length} leads` };
    } else {
      return { ok: false, error: "Unknown bulk action" };
    }

    await prisma.lead.updateMany({
      where: { id: { in: scopedIds }, organizationId: tenant.organizationId },
      data,
    });

    if (op === "assign" && data.assignedUserId) {
      const assigneeId = String(data.assignedUserId);
      const leads = await prisma.lead.findMany({
        where: { id: { in: scopedIds }, organizationId: tenant.organizationId },
        select: { id: true, fullName: true },
      });
      for (const lead of leads) {
        await notifyLeadAssigned({
          organizationId: tenant.organizationId,
          organizationName: tenant.organizationName,
          leadId: lead.id,
          leadName: lead.fullName,
          assignedUserId: assigneeId,
          actorUserId: tenant.userId,
          actorName: tenant.userName ?? tenant.userEmail,
        });
      }
    }

    revalidatePath("/leads");
    revalidatePath("/dashboard");
    return { ok: true, message: `Updated ${scopedIds.length} leads` };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: "Bulk action failed" };
  }
}
