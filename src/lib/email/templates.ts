import { getSiteUrl } from "@/lib/config/env";

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function layout(title: string, bodyHtml: string) {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="font-family:system-ui,-apple-system,sans-serif;line-height:1.5;color:#111;background:#f6f7f9;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:28px;border:1px solid #e5e7eb;">
    <p style="margin:0 0 8px;font-size:12px;letter-spacing:0.04em;text-transform:uppercase;color:#6b7280;">IntraCore</p>
    <h1 style="margin:0 0 16px;font-size:20px;">${escapeHtml(title)}</h1>
    ${bodyHtml}
  </div>
</body>
</html>`;
}

function cta(href: string, label: string) {
  return `<p style="margin:24px 0 0;"><a href="${escapeHtml(href)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-size:14px;">${escapeHtml(label)}</a></p>`;
}

export function memberInvitationEmail(input: {
  organizationName: string;
  roleName: string;
  inviteUrl: string;
  invitedByName?: string | null;
}) {
  const subject = `You're invited to join ${input.organizationName} on IntraCore`;
  const inviter = input.invitedByName
    ? escapeHtml(input.invitedByName)
    : "A teammate";
  const html = layout(
    "Organization invitation",
    `<p>${inviter} invited you to join <strong>${escapeHtml(input.organizationName)}</strong> as <strong>${escapeHtml(input.roleName)}</strong>.</p>
     ${cta(input.inviteUrl, "Accept invitation")}
     <p style="margin-top:16px;font-size:13px;color:#6b7280;">Or open this link:<br>${escapeHtml(input.inviteUrl)}</p>`,
  );
  const text = `${inviter} invited you to join ${input.organizationName} as ${input.roleName}.\n\nAccept: ${input.inviteUrl}`;
  return { subject, html, text };
}

export function leadAssignedEmail(input: {
  leadName: string;
  leadId: string;
  organizationName: string;
  assignedByName?: string | null;
}) {
  const subject = `Lead assigned: ${input.leadName}`;
  const leadUrl = `${getSiteUrl()}/leads/${input.leadId}`;
  const by = input.assignedByName
    ? ` by ${escapeHtml(input.assignedByName)}`
    : "";
  const html = layout(
    "Lead assigned to you",
    `<p><strong>${escapeHtml(input.leadName)}</strong> was assigned to you${by} in <strong>${escapeHtml(input.organizationName)}</strong>.</p>
     ${cta(leadUrl, "View lead")}`,
  );
  const text = `${input.leadName} was assigned to you in ${input.organizationName}.\n\nOpen: ${leadUrl}`;
  return { subject, html, text };
}

export function followUpCreatedEmail(input: {
  title: string;
  leadName: string;
  leadId: string;
  dueAt: Date;
  organizationName: string;
}) {
  const subject = `Follow-up scheduled: ${input.title}`;
  const leadUrl = `${getSiteUrl()}/leads/${input.leadId}`;
  const due = input.dueAt.toLocaleString();
  const html = layout(
    "Follow-up scheduled",
    `<p><strong>${escapeHtml(input.title)}</strong> for <strong>${escapeHtml(input.leadName)}</strong> is due <strong>${escapeHtml(due)}</strong> (${escapeHtml(input.organizationName)}).</p>
     ${cta(leadUrl, "Open lead")}`,
  );
  const text = `Follow-up "${input.title}" for ${input.leadName} is due ${due}.\n\nOpen: ${leadUrl}`;
  return { subject, html, text };
}

export function meetingLoggedEmail(input: {
  meetingTitle?: string | null;
  leadName: string;
  leadId: string;
  organizationName: string;
  notes?: string | null;
}) {
  const label = input.meetingTitle?.trim() || "Meeting";
  const subject = `Meeting logged: ${label} — ${input.leadName}`;
  const leadUrl = `${getSiteUrl()}/leads/${input.leadId}`;
  const notes = input.notes
    ? `<p style="margin-top:12px;color:#374151;">${escapeHtml(input.notes)}</p>`
    : "";
  const html = layout(
    "Meeting logged",
    `<p>A meeting was logged for <strong>${escapeHtml(input.leadName)}</strong> in <strong>${escapeHtml(input.organizationName)}</strong>: <strong>${escapeHtml(label)}</strong>.</p>
     ${notes}
     ${cta(leadUrl, "View lead")}`,
  );
  const text = `Meeting "${label}" logged for ${input.leadName}.\n\nOpen: ${leadUrl}`;
  return { subject, html, text };
}
