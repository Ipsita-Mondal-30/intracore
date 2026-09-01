export type ReminderBucket = "2h" | "24h" | "48h" | "72h";

const BUCKET_LABELS: Record<ReminderBucket, string> = {
  "2h": "2 hours",
  "24h": "24 hours",
  "48h": "48 hours",
  "72h": "72 hours",
};

export function followUpReminderSubject(input: {
  bucket: ReminderBucket;
  leadName: string;
}) {
  return `Follow-up due in ${BUCKET_LABELS[input.bucket]} — ${input.leadName}`;
}

export function followUpReminderHtml(input: {
  bucket: ReminderBucket;
  leadName: string;
  leadPhone?: string | null;
  followUpTitle: string;
  dueAt: Date;
  assigneeName: string;
  leadUrl: string;
}) {
  const dueLabel = input.dueAt.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
  });

  return `
    <div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:24px">
      <h2 style="margin:0 0 12px">Follow-up due in ${BUCKET_LABELS[input.bucket]}</h2>
      <p style="color:#555;margin:0 0 16px">Hi ${input.assigneeName},</p>
      <p style="margin:0 0 16px">
        A follow-up for <strong>${input.leadName}</strong> is due on <strong>${dueLabel}</strong>.
      </p>
      <table style="width:100%;border-collapse:collapse;margin:0 0 20px">
        <tr><td style="padding:6px 0;color:#666">Lead</td><td><strong>${input.leadName}</strong></td></tr>
        <tr><td style="padding:6px 0;color:#666">Phone</td><td>${input.leadPhone ?? "—"}</td></tr>
        <tr><td style="padding:6px 0;color:#666">Follow-up</td><td>${input.followUpTitle}</td></tr>
        <tr><td style="padding:6px 0;color:#666">Due</td><td>${dueLabel}</td></tr>
      </table>
      <a href="${input.leadUrl}" style="display:inline-block;background:#2F6BFF;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">
        Open lead in IntraCore
      </a>
      <p style="color:#999;font-size:12px;margin:24px 0 0">Sent by IntraCore Lead Management</p>
    </div>
  `.trim();
}

export function followUpReminderText(input: {
  bucket: ReminderBucket;
  leadName: string;
  followUpTitle: string;
  dueAt: Date;
  leadUrl: string;
}) {
  return [
    `Follow-up due in ${BUCKET_LABELS[input.bucket]} — ${input.leadName}`,
    "",
    `Follow-up: ${input.followUpTitle}`,
    `Due: ${input.dueAt.toLocaleString()}`,
    `Open lead: ${input.leadUrl}`,
  ].join("\n");
}

/** Pick the tightest due bucket for advance reminders (one email per bucket per follow-up). */
export function bucketForHoursUntilDue(hoursUntilDue: number): ReminderBucket | null {
  if (hoursUntilDue <= 0) return null;
  if (hoursUntilDue <= 2) return "2h";
  if (hoursUntilDue <= 24) return "24h";
  if (hoursUntilDue <= 48) return "48h";
  if (hoursUntilDue <= 72) return "72h";
  return null;
}
