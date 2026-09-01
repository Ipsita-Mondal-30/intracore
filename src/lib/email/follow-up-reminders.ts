import { prisma } from "@/lib/db/prisma";
import { getSiteUrl } from "@/lib/config/env";
import { sendEmail } from "@/lib/email/send";
import { findReminderForFollowUp, logLeadEmail } from "@/lib/email/log-communication";
import {
  bucketForHoursUntilDue,
  followUpReminderHtml,
  followUpReminderSubject,
  followUpReminderText,
  type ReminderBucket,
} from "@/lib/email/templates/follow-up-reminder";
import { isResendConfigured } from "@/lib/email/config";

export type ReminderRunSummary = {
  ok: boolean;
  error?: string;
  sent: number;
  skipped: number;
  failed: number;
  details: { leadId: string; bucket: ReminderBucket; status: string }[];
};

export async function sendFollowUpReminderEmails(
  organizationId?: string,
): Promise<ReminderRunSummary> {
  if (!isResendConfigured()) {
    return {
      ok: false,
      error: "Resend not configured",
      sent: 0,
      skipped: 0,
      failed: 0,
      details: [],
    };
  }

  const now = new Date();
  const horizon = new Date(now.getTime() + 73 * 60 * 60 * 1000);

  const followUps = await prisma.leadFollowUp.findMany({
    where: {
      status: "PENDING",
      dueAt: { gte: now, lte: horizon },
      ...(organizationId ? { organizationId } : {}),
      lead: { archivedAt: null },
    },
    include: {
      lead: {
        select: {
          id: true,
          fullName: true,
          phone: true,
          assignedUserId: true,
          assignedUser: { select: { id: true, name: true, email: true } },
        },
      },
    },
    take: 500,
  });

  const summary: ReminderRunSummary = {
    ok: true,
    sent: 0,
    skipped: 0,
    failed: 0,
    details: [],
  };

  const siteUrl = getSiteUrl();

  for (const followUp of followUps) {
    const hoursUntilDue =
      (followUp.dueAt.getTime() - now.getTime()) / (1000 * 60 * 60);
    const bucket = bucketForHoursUntilDue(hoursUntilDue);

    if (!bucket) {
      summary.skipped += 1;
      continue;
    }

    const existing = await findReminderForFollowUp(
      followUp.organizationId,
      followUp.id,
      bucket,
    );
    if (existing) {
      summary.skipped += 1;
      summary.details.push({
        leadId: followUp.leadId,
        bucket,
        status: "already_sent",
      });
      continue;
    }

    const assignee = followUp.lead.assignedUser;
    if (!assignee?.email) {
      summary.skipped += 1;
      summary.details.push({
        leadId: followUp.leadId,
        bucket,
        status: "no_assignee_email",
      });
      continue;
    }

    const assigneeName = assignee.name ?? assignee.email.split("@")[0];
    const leadUrl = `${siteUrl}/leads/${followUp.leadId}`;
    const subject = followUpReminderSubject({
      bucket,
      leadName: followUp.lead.fullName,
    });
    const html = followUpReminderHtml({
      bucket,
      leadName: followUp.lead.fullName,
      leadPhone: followUp.lead.phone,
      followUpTitle: followUp.title,
      dueAt: followUp.dueAt,
      assigneeName,
      leadUrl,
    });
    const text = followUpReminderText({
      bucket,
      leadName: followUp.lead.fullName,
      followUpTitle: followUp.title,
      dueAt: followUp.dueAt,
      leadUrl,
    });

    const result = await sendEmail({
      to: assignee.email,
      subject,
      html,
      text,
    });

    if (!result.ok) {
      summary.failed += 1;
      const status =
        "skipped" in result && result.skipped ? result.reason : result.error;
      summary.details.push({
        leadId: followUp.leadId,
        bucket,
        status,
      });
      continue;
    }

    await logLeadEmail({
      organizationId: followUp.organizationId,
      leadId: followUp.leadId,
      userId: assignee.id,
      subject,
      bodyPreview: text,
      externalId: result.id,
      recipientEmail: assignee.email,
      metadata: {
        kind: "follow_up_reminder",
        bucket,
        followUpId: followUp.id,
        recipientType: "assignee",
      },
    });

    summary.sent += 1;
    summary.details.push({
      leadId: followUp.leadId,
      bucket,
      status: "sent",
    });
  }

  return summary;
}
