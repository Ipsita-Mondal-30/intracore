"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db/prisma";
import { requirePermission } from "@/lib/tenant";
import { isAppError } from "@/lib/errors";
import { recordActivity } from "@/lib/leads/activity";
import { LEAD_ACTIVITY_TYPES } from "@/lib/leads/activity-types";
import { CALL_OUTCOMES } from "@/lib/leads/call-outcomes";
import { syncLeadNextFollowUpAt } from "@/lib/leads/follow-up-sync";
import {
  buildCallRecordingPath,
  deleteCallRecording,
  uploadCallRecording,
  validateCallRecordingFile,
} from "@/lib/storage/call-recordings";
import { leadVisibilityWhere } from "@/features/leads/scope";
import { assertLeadRefs } from "@/lib/tenant/refs";
import type { ActionResult } from "@/features/auth/types";

export async function createCallRecordAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("lead.log_calls");
    const leadId = String(formData.get("leadId") ?? "");
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, ...leadVisibilityWhere(tenant), archivedAt: null },
    });
    if (!lead) return { ok: false, error: "Lead not found" };

    const outcome = String(formData.get("outcome") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim();
    const phoneNumber =
      String(formData.get("phoneNumber") ?? "").trim() || lead.phone || null;
    const didNumber = String(formData.get("didNumber") ?? "").trim() || null;
    const durationRaw = String(formData.get("durationSec") ?? "").trim();
    const durationSec = durationRaw ? Number(durationRaw) : null;
    const calledAtRaw = String(formData.get("calledAt") ?? "").trim();
    const calledAt = calledAtRaw ? new Date(calledAtRaw) : new Date();
    const callbackAtRaw = String(formData.get("callbackAt") ?? "").trim();
    const callbackAt = callbackAtRaw ? new Date(callbackAtRaw) : null;
    const nextFollowUpRaw = String(formData.get("nextFollowUpAt") ?? "").trim();
    const nextFollowUpAt = nextFollowUpRaw ? new Date(nextFollowUpRaw) : null;
    const recording = formData.get("recording");

    if (outcome && !CALL_OUTCOMES.includes(outcome as (typeof CALL_OUTCOMES)[number])) {
      return { ok: false, error: "Invalid call outcome" };
    }

    let callRecordId = "";

    await prisma.$transaction(async (tx) => {
      const callRecord = await tx.leadCallRecord.create({
        data: {
          organizationId: tenant.organizationId,
          leadId,
          userId: tenant.userId,
          calledAt,
          durationSec: Number.isFinite(durationSec) ? durationSec : null,
          phoneNumber,
          didNumber,
          outcome: outcome || null,
          notes: notes || null,
          callbackAt,
          nextFollowUpAt,
        },
      });
      callRecordId = callRecord.id;

      await tx.lead.update({
        where: { id: leadId },
        data: {
          lastContactedAt: calledAt,
          ...(callbackAt ? { callbackAt } : {}),
        },
      });

      if (nextFollowUpAt) {
        await tx.leadFollowUp.create({
          data: {
            organizationId: tenant.organizationId,
            leadId,
            title: `Call follow-up${outcome ? `: ${outcome}` : ""}`,
            type: "CALL",
            dueAt: nextFollowUpAt,
            assignedUserId: lead.assignedUserId,
            status: "PENDING",
          },
        });
      }
    });

    if (recording instanceof File && recording.size > 0 && callRecordId) {
      try {
        const { mimeType, ext } = validateCallRecordingFile({
          type: recording.type,
          size: recording.size,
        });
        const recordingPath = buildCallRecordingPath(
          tenant.organizationId,
          leadId,
          callRecordId,
          ext,
        );
        const buffer = Buffer.from(await recording.arrayBuffer());
        await uploadCallRecording(recordingPath, buffer, mimeType);
        await prisma.leadCallRecord.update({
          where: { id: callRecordId },
          data: {
            recordingPath,
            recordingFileName: recording.name,
            recordingMimeType: mimeType,
            recordingSizeBytes: recording.size,
          },
        });
      } catch (uploadError) {
        console.error("Call recording upload failed", uploadError);
      }
    }

    await syncLeadNextFollowUpAt(leadId);

    await recordActivity({
      organizationId: tenant.organizationId,
      leadId,
      actorId: tenant.userId,
      type: LEAD_ACTIVITY_TYPES.CALL_LOGGED,
      message: outcome ? `Call logged: ${outcome}` : "Call logged",
      next: {
        outcome,
        phoneNumber,
        durationSec,
        calledAt: calledAt.toISOString(),
        notes: notes || null,
      },
    });

    revalidatePath(`/leads/${leadId}`);
    return { ok: true, message: "Call recorded" };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: "Failed to log call" };
  }
}

export async function uploadCallRecordingAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("lead.log_calls");
    const leadId = String(formData.get("leadId") ?? "");
    const callRecordId = String(formData.get("callRecordId") ?? "").trim();
    const file = formData.get("file");

    if (!leadId || !callRecordId) {
      return { ok: false, error: "Lead and call record are required" };
    }
    if (!file || !(file instanceof File) || file.size === 0) {
      return { ok: false, error: "Recording file is required" };
    }

    const lead = await prisma.lead.findFirst({
      where: { id: leadId, ...leadVisibilityWhere(tenant), archivedAt: null },
    });
    if (!lead) return { ok: false, error: "Lead not found" };

    const callRecord = await prisma.leadCallRecord.findFirst({
      where: {
        id: callRecordId,
        leadId,
        organizationId: tenant.organizationId,
      },
    });
    if (!callRecord) return { ok: false, error: "Call record not found" };

    const recordingDurationRaw = String(
      formData.get("recordingDurationSec") ?? "",
    ).trim();
    const recordingDurationSec = recordingDurationRaw
      ? Number(recordingDurationRaw)
      : null;
    const didNumber =
      String(formData.get("didNumber") ?? "").trim() ||
      callRecord.didNumber ||
      null;

    const { mimeType, ext } = validateCallRecordingFile({
      type: file.type,
      size: file.size,
    });
    const recordingPath = buildCallRecordingPath(
      tenant.organizationId,
      leadId,
      callRecordId,
      ext,
    );
    const buffer = Buffer.from(await file.arrayBuffer());

    if (callRecord.recordingPath && callRecord.recordingPath !== recordingPath) {
      await deleteCallRecording(callRecord.recordingPath);
    }

    await uploadCallRecording(recordingPath, buffer, mimeType);

    await prisma.leadCallRecord.update({
      where: { id: callRecordId },
      data: {
        didNumber,
        recordingPath,
        recordingFileName: file.name,
        recordingMimeType: mimeType,
        recordingSizeBytes: file.size,
        recordingDurationSec: Number.isFinite(recordingDurationSec)
          ? recordingDurationSec
          : null,
      },
    });

    await recordActivity({
      organizationId: tenant.organizationId,
      leadId,
      actorId: tenant.userId,
      type: LEAD_ACTIVITY_TYPES.CALL_RECORDING_UPLOADED,
      message: `Call recording uploaded: ${file.name}`,
      next: {
        callRecordId,
        recordingFileName: file.name,
        recordingMimeType: mimeType,
        recordingSizeBytes: file.size,
        recordingDurationSec: Number.isFinite(recordingDurationSec)
          ? recordingDurationSec
          : null,
      },
    });

    revalidatePath(`/leads/${leadId}`);
    return { ok: true, message: "Recording uploaded" };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: "Failed to upload recording" };
  }
}

export async function reengageLeadAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("lead.reengage");
    const leadId = String(formData.get("leadId") ?? "");
    const lead = await prisma.lead.findFirst({
      where: { id: leadId, ...leadVisibilityWhere(tenant), archivedAt: null },
      include: { stage: true },
    });
    if (!lead) return { ok: false, error: "Lead not found" };

    const reason = String(formData.get("reason") ?? "").trim();
    const notes = String(formData.get("notes") ?? "").trim();
    const stageId = String(formData.get("stageId") ?? "").trim() || lead.stageId;
    const assignedUserId =
      String(formData.get("assignedUserId") ?? "").trim() || lead.assignedUserId;
    await assertLeadRefs(tenant.organizationId, { stageId, assignedUserId });
    const nextCallDueRaw = String(formData.get("nextCallDueAt") ?? "").trim();
    const followUpRaw = String(formData.get("followUpAt") ?? "").trim();
    const nextCallDueAt = nextCallDueRaw ? new Date(nextCallDueRaw) : null;
    const followUpAt = followUpRaw ? new Date(followUpRaw) : null;
    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.leadReengagement.create({
        data: {
          organizationId: tenant.organizationId,
          leadId,
          reengagedAt: now,
          reason: reason || null,
          previousStageId: lead.stageId,
          newStageId: stageId || null,
          assignedUserId: assignedUserId || null,
          nextCallDueAt,
          followUpAt,
          notes: notes || null,
          createdById: tenant.userId,
        },
      });

      await tx.lead.update({
        where: { id: leadId },
        data: {
          reEngagedAt: now,
          status: lead.status === "LOST" || lead.status === "CONVERTED" ? "OPEN" : lead.status,
          lostReason: lead.status === "LOST" ? null : lead.lostReason,
          lostComment: lead.status === "LOST" ? null : lead.lostComment,
          stageId: stageId || lead.stageId,
          assignedUserId: assignedUserId || lead.assignedUserId,
          callbackAt: nextCallDueAt ?? lead.callbackAt,
          nextFollowUpAt: followUpAt ?? lead.nextFollowUpAt,
        },
      });

      if (followUpAt) {
        await tx.leadFollowUp.create({
          data: {
            organizationId: tenant.organizationId,
            leadId,
            title: "Re-engagement follow-up",
            type: "CALL",
            dueAt: followUpAt,
            assignedUserId: assignedUserId || lead.assignedUserId,
            description: notes || reason || null,
            status: "PENDING",
          },
        });
      }
    });

    await syncLeadNextFollowUpAt(leadId);

    await recordActivity({
      organizationId: tenant.organizationId,
      leadId,
      actorId: tenant.userId,
      type: LEAD_ACTIVITY_TYPES.REENGAGED,
      message: reason ? `Lead re-engaged: ${reason}` : "Lead re-engaged",
      previous: { stageId: lead.stageId, status: lead.status },
      next: {
        stageId: stageId || lead.stageId,
        reason,
        notes: notes || null,
        nextCallDueAt: nextCallDueAt?.toISOString() ?? null,
        followUpAt: followUpAt?.toISOString() ?? null,
      },
    });

    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/leads");
    return { ok: true, message: "Lead re-engaged" };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: "Re-engagement failed" };
  }
}
