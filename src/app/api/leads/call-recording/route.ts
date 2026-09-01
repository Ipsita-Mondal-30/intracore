import { NextResponse } from "next/server";
import { requirePermission } from "@/lib/tenant";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { leadVisibilityWhere } from "@/features/leads/scope";
import {
  buildCallRecordingPath,
  deleteCallRecording,
  uploadCallRecording,
  validateCallRecordingFile,
} from "@/lib/storage/call-recordings";

export async function POST(request: Request) {
  try {
    const tenant = await requirePermission("lead.log_calls");
    const formData = await request.formData();
    const leadId = String(formData.get("leadId") ?? "");
    const callRecordId = String(formData.get("callRecordId") ?? "");
    const file = formData.get("recording");

    if (!leadId || !callRecordId || !(file instanceof File)) {
      return NextResponse.json({ ok: false, error: "Missing fields" }, { status: 400 });
    }

    const lead = await prisma.lead.findFirst({
      where: { id: leadId, ...leadVisibilityWhere(tenant), archivedAt: null },
    });
    if (!lead) {
      return NextResponse.json({ ok: false, error: "Lead not found" }, { status: 404 });
    }

    const callRecord = await prisma.leadCallRecord.findFirst({
      where: {
        id: callRecordId,
        leadId,
        organizationId: tenant.organizationId,
      },
    });
    if (!callRecord) {
      return NextResponse.json({ ok: false, error: "Call record not found" }, { status: 404 });
    }

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
        recordingPath,
        recordingFileName: file.name,
        recordingMimeType: mimeType,
        recordingSizeBytes: file.size,
      },
    });

    return NextResponse.json({ ok: true, recordingPath });
  } catch (error) {
    if (isAppError(error)) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "Upload failed";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
