import { prisma } from "@/lib/db/prisma";
import { notifyUser } from "@/lib/email/notify";
import {
  followUpCreatedEmail,
  leadAssignedEmail,
  meetingLoggedEmail,
} from "@/lib/email/templates";

async function safeNotify(
  label: string,
  run: () => Promise<unknown>,
) {
  try {
    await run();
  } catch (error) {
    console.error(`[notify] ${label} failed:`, error);
  }
}

export async function notifyLeadAssigned(input: {
  organizationId: string;
  organizationName: string;
  leadId: string;
  leadName: string;
  assignedUserId: string;
  actorUserId: string;
  actorName?: string | null;
}) {
  if (input.assignedUserId === input.actorUserId) return;

  const email = leadAssignedEmail({
    leadName: input.leadName,
    leadId: input.leadId,
    organizationName: input.organizationName,
    assignedByName: input.actorName,
  });

  await safeNotify("lead.assigned", () =>
    notifyUser({
      organizationId: input.organizationId,
      userId: input.assignedUserId,
      type: "lead.assigned",
      title: `Lead assigned: ${input.leadName}`,
      body: `You were assigned ${input.leadName}`,
      data: { leadId: input.leadId },
      email,
    }),
  );
}

export async function notifyFollowUpCreated(input: {
  organizationId: string;
  organizationName: string;
  leadId: string;
  leadName: string;
  followUpId: string;
  title: string;
  dueAt: Date;
  assignedUserId: string;
}) {
  const email = followUpCreatedEmail({
    title: input.title,
    leadName: input.leadName,
    leadId: input.leadId,
    dueAt: input.dueAt,
    organizationName: input.organizationName,
  });

  await safeNotify("follow_up.created", () =>
    notifyUser({
      organizationId: input.organizationId,
      userId: input.assignedUserId,
      type: "follow_up.created",
      title: `Follow-up: ${input.title}`,
      body: `Due ${input.dueAt.toLocaleString()} for ${input.leadName}`,
      data: { leadId: input.leadId, followUpId: input.followUpId },
      email,
    }),
  );
}

export async function notifyMeetingLogged(input: {
  organizationId: string;
  organizationName: string;
  leadId: string;
  leadName: string;
  assignedUserId: string;
  actorUserId: string;
  meetingTitle?: string | null;
  notes?: string | null;
}) {
  if (input.assignedUserId === input.actorUserId) return;

  const email = meetingLoggedEmail({
    meetingTitle: input.meetingTitle,
    leadName: input.leadName,
    leadId: input.leadId,
    organizationName: input.organizationName,
    notes: input.notes,
  });

  await safeNotify("meeting.logged", () =>
    notifyUser({
      organizationId: input.organizationId,
      userId: input.assignedUserId,
      type: "meeting.logged",
      title: `Meeting: ${input.meetingTitle?.trim() || "Logged"} — ${input.leadName}`,
      body: input.notes ?? undefined,
      data: { leadId: input.leadId },
      email,
    }),
  );
}

export async function getUnreadNotificationCount(
  organizationId: string,
  userId: string,
) {
  return prisma.notification.count({
    where: {
      organizationId,
      userId,
      readAt: null,
    },
  });
}
