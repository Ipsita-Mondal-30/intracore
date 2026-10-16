"use server";

import { revalidatePath } from "next/cache";
import { FollowUpType, LeadPriority, TaskStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requirePermission, type TenantContext } from "@/lib/tenant";
import { leadVisibilityWhere } from "@/features/leads/scope";
import { assertActiveMember } from "@/lib/tenant/refs";
import { isAppError } from "@/lib/errors";
import type { ActionResult } from "@/features/auth/types";
import {
  followUpSchema,
  logActivitySchema,
  noteSchema,
  taskSchema,
} from "@/lib/validations/leads";
import { recordActivity } from "@/lib/leads/activity";
import {
  notifyFollowUpCreated,
  notifyMeetingLogged,
} from "@/lib/email/crm-notify";
import { syncLeadNextFollowUpAt } from "@/lib/leads/follow-up-sync";

async function requireLead(tenant: TenantContext, leadId: string) {
  return prisma.lead.findFirst({
    where: { id: leadId, ...leadVisibilityWhere(tenant) },
  });
}

function revalidateLead(leadId: string) {
  revalidatePath(`/leads/${leadId}`);
  revalidatePath("/leads/tasks");
  revalidatePath("/leads/follow-ups");
  revalidatePath("/dashboard");
}

export async function addNoteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("lead.edit");
    const leadId = String(formData.get("leadId") ?? "");
    const parsed = noteSchema.safeParse({ content: formData.get("content") });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
    }
    const lead = await requireLead(tenant, leadId);
    if (!lead) return { ok: false, error: "Lead not found" };

    await prisma.leadNote.create({
      data: {
        organizationId: tenant.organizationId,
        leadId,
        authorId: tenant.userId,
        content: parsed.data.content,
      },
    });
    await recordActivity({
      organizationId: tenant.organizationId,
      leadId,
      actorId: tenant.userId,
      type: "NOTE_ADDED",
      message: "Note added",
    });
    revalidateLead(leadId);
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) return { ok: false, error: error.message, code: error.code };
    return { ok: false, error: "Failed to add note" };
  }
}

export async function updateNoteAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("lead.edit");
    const noteId = String(formData.get("noteId") ?? "");
    const parsed = noteSchema.safeParse({ content: formData.get("content") });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
    }
    const note = await prisma.leadNote.findFirst({
      where: { id: noteId, organizationId: tenant.organizationId, lead: leadVisibilityWhere(tenant) },
    });
    if (!note) return { ok: false, error: "Note not found" };
    await prisma.leadNote.update({
      where: { id: noteId },
      data: { content: parsed.data.content },
    });
    revalidateLead(note.leadId);
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) return { ok: false, error: error.message, code: error.code };
    return { ok: false, error: "Failed to update note" };
  }
}

export async function deleteNoteAction(formData: FormData): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("lead.edit");
    const noteId = String(formData.get("noteId") ?? "");
    const note = await prisma.leadNote.findFirst({
      where: { id: noteId, organizationId: tenant.organizationId, lead: leadVisibilityWhere(tenant) },
    });
    if (!note) return { ok: false, error: "Note not found" };
    await prisma.leadNote.delete({ where: { id: noteId } });
    revalidateLead(note.leadId);
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) return { ok: false, error: error.message, code: error.code };
    return { ok: false, error: "Failed to delete note" };
  }
}

export async function createTaskAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("lead.edit");
    const leadId = String(formData.get("leadId") ?? "");
    const parsed = taskSchema.safeParse({
      title: formData.get("title"),
      description: formData.get("description") || undefined,
      assignedUserId: formData.get("assignedUserId") || "",
      dueDate: formData.get("dueDate") || undefined,
      priority: formData.get("priority") || undefined,
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
    }
    const lead = await requireLead(tenant, leadId);
    if (!lead) return { ok: false, error: "Lead not found" };

    if (parsed.data.assignedUserId) await assertActiveMember(tenant.organizationId, parsed.data.assignedUserId);
    await prisma.leadTask.create({
      data: {
        organizationId: tenant.organizationId,
        leadId,
        title: parsed.data.title,
        description: parsed.data.description,
        assignedUserId: parsed.data.assignedUserId || tenant.userId,
        dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : null,
        priority: parsed.data.priority ?? LeadPriority.MEDIUM,
      },
    });
    await recordActivity({
      organizationId: tenant.organizationId,
      leadId,
      actorId: tenant.userId,
      type: "TASK_CREATED",
      message: `Task created: ${parsed.data.title}`,
    });
    revalidateLead(leadId);
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) return { ok: false, error: error.message, code: error.code };
    return { ok: false, error: "Failed to create task" };
  }
}

export async function updateTaskAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("lead.edit");
    const taskId = String(formData.get("taskId") ?? "");
    const parsed = taskSchema.safeParse({
      title: formData.get("title"),
      description: formData.get("description") || undefined,
      assignedUserId: formData.get("assignedUserId") || "",
      dueDate: formData.get("dueDate") || undefined,
      priority: formData.get("priority") || undefined,
      status: formData.get("status") || undefined,
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
    }
    const task = await prisma.leadTask.findFirst({
      where: { id: taskId, organizationId: tenant.organizationId, lead: leadVisibilityWhere(tenant) },
    });
    if (!task) return { ok: false, error: "Task not found" };
    if (parsed.data.assignedUserId) await assertActiveMember(tenant.organizationId, parsed.data.assignedUserId);
    await prisma.leadTask.update({
      where: { id: taskId },
      data: {
        title: parsed.data.title,
        description: parsed.data.description,
        assignedUserId: parsed.data.assignedUserId || task.assignedUserId,
        dueDate: parsed.data.dueDate ? new Date(parsed.data.dueDate) : task.dueDate,
        priority: parsed.data.priority ?? task.priority,
        status: parsed.data.status ?? task.status,
      },
    });
    revalidateLead(task.leadId);
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) return { ok: false, error: error.message, code: error.code };
    return { ok: false, error: "Failed to update task" };
  }
}

export async function deleteTaskAction(formData: FormData): Promise<void> {
  try {
    const tenant = await requirePermission("lead.edit");
    const taskId = String(formData.get("taskId") ?? "");
    const task = await prisma.leadTask.findFirst({
      where: { id: taskId, organizationId: tenant.organizationId, lead: leadVisibilityWhere(tenant) },
    });
    if (!task) return;
    await prisma.leadTask.delete({ where: { id: taskId } });
    revalidateLead(task.leadId);
  } catch (error) {
    if (!isAppError(error)) console.error(error);
  }
}

export async function completeTaskAction(formData: FormData): Promise<void> {
  const tenant = await requirePermission("lead.edit");
  const taskId = String(formData.get("taskId") ?? "");
  const task = await prisma.leadTask.findFirst({
    where: { id: taskId, organizationId: tenant.organizationId, lead: leadVisibilityWhere(tenant) },
  });
  if (!task) return;
  await prisma.leadTask.update({
    where: { id: taskId },
    data: { status: TaskStatus.COMPLETED },
  });
  revalidateLead(task.leadId);
}

export async function createFollowUpAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("lead.edit");
    const leadId = String(formData.get("leadId") ?? "");
    const parsed = followUpSchema.safeParse({
      title: formData.get("title"),
      description: formData.get("description") || undefined,
      type: formData.get("type") || FollowUpType.CALL,
      dueAt: formData.get("dueAt"),
      assignedUserId: formData.get("assignedUserId") || "",
      priority: formData.get("priority") || undefined,
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
    }
    const lead = await requireLead(tenant, leadId);
    if (!lead) return { ok: false, error: "Lead not found" };

    const dueAt = new Date(parsed.data.dueAt);
    if (parsed.data.assignedUserId) await assertActiveMember(tenant.organizationId, parsed.data.assignedUserId);
    const assignedUserId = parsed.data.assignedUserId || tenant.userId;
    const followUp = await prisma.leadFollowUp.create({
      data: {
        organizationId: tenant.organizationId,
        leadId,
        title: parsed.data.title,
        description: parsed.data.description,
        type: parsed.data.type ?? FollowUpType.CALL,
        dueAt,
        assignedUserId,
        priority: parsed.data.priority ?? LeadPriority.MEDIUM,
      },
    });
    await prisma.lead.update({
      where: { id: leadId },
      data: { nextFollowUpAt: dueAt },
    });
    await recordActivity({
      organizationId: tenant.organizationId,
      leadId,
      actorId: tenant.userId,
      type: "FOLLOW_UP_CREATED",
      message: `Follow-up scheduled: ${parsed.data.title}`,
    });
    await notifyFollowUpCreated({
      organizationId: tenant.organizationId,
      organizationName: tenant.organizationName,
      leadId,
      leadName: lead.fullName,
      followUpId: followUp.id,
      title: parsed.data.title,
      dueAt,
      assignedUserId,
    });
    await syncLeadNextFollowUpAt(leadId);
    revalidateLead(leadId);
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) return { ok: false, error: error.message, code: error.code };
    return { ok: false, error: "Failed to schedule follow-up" };
  }
}

export async function updateFollowUpAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("lead.edit");
    const followUpId = String(formData.get("followUpId") ?? "");
    const parsed = followUpSchema.safeParse({
      title: formData.get("title"),
      description: formData.get("description") || undefined,
      type: formData.get("type") || FollowUpType.CALL,
      dueAt: formData.get("dueAt"),
      assignedUserId: formData.get("assignedUserId") || "",
      priority: formData.get("priority") || undefined,
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
    }
    const item = await prisma.leadFollowUp.findFirst({
      where: { id: followUpId, organizationId: tenant.organizationId, lead: leadVisibilityWhere(tenant) },
    });
    if (!item) return { ok: false, error: "Follow-up not found" };
    const dueAt = new Date(parsed.data.dueAt);
    if (parsed.data.assignedUserId) await assertActiveMember(tenant.organizationId, parsed.data.assignedUserId);
    await prisma.leadFollowUp.update({
      where: { id: followUpId },
      data: {
        title: parsed.data.title,
        description: parsed.data.description,
        type: parsed.data.type ?? item.type,
        dueAt,
        assignedUserId: parsed.data.assignedUserId || item.assignedUserId,
        priority: parsed.data.priority ?? item.priority,
        status: TaskStatus.PENDING,
      },
    });
    await prisma.lead.update({
      where: { id: item.leadId },
      data: { nextFollowUpAt: dueAt },
    });
    await syncLeadNextFollowUpAt(item.leadId);
    revalidateLead(item.leadId);
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) return { ok: false, error: error.message, code: error.code };
    return { ok: false, error: "Failed to update follow-up" };
  }
}

export async function cancelFollowUpAction(formData: FormData): Promise<void> {
  try {
    const tenant = await requirePermission("lead.edit");
    const followUpId = String(formData.get("followUpId") ?? "");
    const item = await prisma.leadFollowUp.findFirst({
      where: { id: followUpId, organizationId: tenant.organizationId, lead: leadVisibilityWhere(tenant) },
    });
    if (!item) return;
    await prisma.leadFollowUp.update({
      where: { id: followUpId },
      data: { status: TaskStatus.CANCELLED },
    });
    await syncLeadNextFollowUpAt(item.leadId);
    revalidateLead(item.leadId);
  } catch (error) {
    if (!isAppError(error)) console.error(error);
  }
}

export async function completeFollowUpAction(
  formData: FormData,
): Promise<void> {
  const tenant = await requirePermission("lead.edit");
  const followUpId = String(formData.get("followUpId") ?? "");
  const item = await prisma.leadFollowUp.findFirst({
    where: { id: followUpId, organizationId: tenant.organizationId, lead: leadVisibilityWhere(tenant) },
  });
  if (!item) return;

  await prisma.leadFollowUp.update({
    where: { id: followUpId },
    data: { status: TaskStatus.COMPLETED },
  });
  await prisma.lead.update({
    where: { id: item.leadId },
    data: { lastContactedAt: new Date() },
  });
  await recordActivity({
    organizationId: tenant.organizationId,
    leadId: item.leadId,
    actorId: tenant.userId,
    type: "FOLLOW_UP_COMPLETED",
    message: `Follow-up completed: ${item.title}`,
  });
  await syncLeadNextFollowUpAt(item.leadId);
  revalidateLead(item.leadId);
}

export async function updateFollowUpFormAction(formData: FormData): Promise<void> {
  await updateFollowUpAction(null, formData);
}

export async function updateTaskFormAction(formData: FormData): Promise<void> {
  await updateTaskAction(null, formData);
}

export async function logActivityAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("lead.edit");
    const leadId = String(formData.get("leadId") ?? "");
    const parsed = logActivitySchema.safeParse({
      kind: formData.get("kind"),
      notes: formData.get("notes") || undefined,
      occurredAt: formData.get("occurredAt") || undefined,
      outcome: formData.get("outcome") || undefined,
      duration: formData.get("duration") || undefined,
      subject: formData.get("subject") || undefined,
      meetingTitle: formData.get("meetingTitle") || undefined,
      participants: formData.get("participants") || undefined,
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid" };
    }
    const lead = await requireLead(tenant, leadId);
    if (!lead) return { ok: false, error: "Lead not found" };

    const kind = parsed.data.kind;
    const title =
      kind === "CALL"
        ? `Call logged${parsed.data.duration ? ` (${parsed.data.duration})` : ""}`
        : kind === "EMAIL"
          ? `Email logged${parsed.data.subject ? `: ${parsed.data.subject}` : ""}`
          : kind === "MEETING"
            ? `Meeting logged${parsed.data.meetingTitle ? `: ${parsed.data.meetingTitle}` : ""}`
            : "WhatsApp activity logged";
    await recordActivity({
      organizationId: tenant.organizationId,
      leadId,
      actorId: tenant.userId,
      type: kind,
      message: parsed.data.notes ? `${title}. ${parsed.data.notes}` : title,
      next: {
        kind,
        outcome: parsed.data.outcome ?? null,
        occurredAt: parsed.data.occurredAt ?? null,
        participants: parsed.data.participants ?? null,
      },
    });
    await prisma.lead.update({
      where: { id: leadId },
      data: { lastContactedAt: new Date() },
    });
    if (kind === "MEETING" && lead.assignedUserId) {
      await notifyMeetingLogged({
        organizationId: tenant.organizationId,
        organizationName: tenant.organizationName,
        leadId,
        leadName: lead.fullName,
        assignedUserId: lead.assignedUserId,
        actorUserId: tenant.userId,
        meetingTitle: parsed.data.meetingTitle,
        notes: parsed.data.notes,
      });
    }
    revalidateLead(leadId);
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) return { ok: false, error: error.message, code: error.code };
    return { ok: false, error: "Failed to log activity" };
  }
}
