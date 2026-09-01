"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db/prisma";
import { requirePermission } from "@/lib/tenant";
import { isAppError } from "@/lib/errors";
import type { ActionResult } from "@/features/auth/types";
import { sendEmail } from "@/lib/email/send";
import { logLeadEmail } from "@/lib/email/log-communication";
import { sendFollowUpReminderEmails } from "@/lib/email/follow-up-reminders";
import { isResendConfigured } from "@/lib/email/config";
import { leadVisibilityWhere } from "@/features/leads/scope";
import { LEAD_ACTIVITY_TYPES } from "@/lib/leads/activity-types";
import { recordActivity } from "@/lib/leads/activity";

export async function sendLeadEmailAction(
  formData: FormData,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("lead.edit");
    if (!isResendConfigured()) {
      return { ok: false, error: "Email is not configured. Set RESEND_API_KEY and RESEND_FROM_EMAIL." };
    }

    const leadId = String(formData.get("leadId") ?? "");
    const subject = String(formData.get("subject") ?? "").trim();
    const body = String(formData.get("body") ?? "").trim();

    if (!subject || !body) {
      return { ok: false, error: "Subject and message are required" };
    }

    const lead = await prisma.lead.findFirst({
      where: { id: leadId, ...leadVisibilityWhere(tenant), archivedAt: null },
    });
    if (!lead) return { ok: false, error: "Lead not found" };
    if (!lead.email) {
      return { ok: false, error: "Lead has no email address" };
    }

    const html = `
      <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px">
        <p style="white-space:pre-wrap">${body.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</p>
        <p style="color:#999;font-size:12px;margin-top:24px">Sent via IntraCore</p>
      </div>
    `;

    const result = await sendEmail({
      to: lead.email,
      subject,
      html,
      text: body,
    });

    if (!result.ok) {
      const message =
        "skipped" in result && result.skipped ? result.reason : result.error;
      return { ok: false, error: message };
    }

    await logLeadEmail({
      organizationId: tenant.organizationId,
      leadId,
      userId: tenant.userId,
      subject,
      bodyPreview: body,
      externalId: result.id,
      recipientEmail: lead.email,
      metadata: { kind: "manual", recipientType: "lead" },
    });

    await recordActivity({
      organizationId: tenant.organizationId,
      leadId,
      actorId: tenant.userId,
      type: LEAD_ACTIVITY_TYPES.EMAIL,
      message: `Email sent: ${subject}`,
      next: { subject, to: lead.email, resendId: result.id },
    });

    revalidatePath(`/leads/${leadId}`);
    revalidatePath("/leads/email");
    return { ok: true, message: "Email sent" };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: "Failed to send email" };
  }
}

export async function runFollowUpReminderEmailsAction(): Promise<ActionResult & {
  summary?: Awaited<ReturnType<typeof sendFollowUpReminderEmails>>;
}> {
  try {
    const tenant = await requirePermission("lead.edit");
    if (!isResendConfigured()) {
      return { ok: false, error: "Resend is not configured" };
    }

    const summary = await sendFollowUpReminderEmails(tenant.organizationId);
    revalidatePath("/leads/email");

    if (!summary.ok) {
      return {
        ok: false,
        error: summary.error ?? "Reminder job failed",
        summary,
      };
    }

    return {
      ok: true,
      message: `Sent ${summary.sent}, skipped ${summary.skipped}, failed ${summary.failed}`,
      summary,
    };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: "Reminder job failed" };
  }
}
