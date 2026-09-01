import { prisma } from "@/lib/db/prisma";
import type { MessageType } from "@prisma/client";
import type { TenantContext } from "@/lib/tenant";
import { broadcastChatEvent } from "@/lib/chat/broadcast";
import { getConversationForTenant, ensureParticipant } from "@/lib/chat/conversations";
import { serializeMessage } from "@/lib/chat/unread";
import { recordActivity } from "@/lib/leads/activity";
import { LEAD_ACTIVITY_TYPES } from "@/lib/leads/activity-types";
import { createChatNotification } from "@/lib/notifications/create";

export type SendMessageInput = {
  conversationId: string;
  content?: string;
  messageType?: MessageType;
  attachments?: {
    fileName: string;
    fileUrl: string;
    mimeType: string;
    size: number;
  }[];
};

export async function sendUserMessage(
  tenant: TenantContext,
  input: SendMessageInput,
) {
  const content = input.content?.trim() ?? "";
  const hasAttachments = (input.attachments?.length ?? 0) > 0;
  if (!content && !hasAttachments) {
    throw new Error("Message cannot be empty");
  }

  const conversation = await getConversationForTenant(tenant, input.conversationId);
  if (!conversation) throw new Error("Conversation not found");

  await ensureParticipant(conversation.id, tenant.userId);

  const messageType =
    input.messageType ??
    (hasAttachments
      ? input.attachments!.some((a) => a.mimeType.startsWith("image/"))
        ? "IMAGE"
        : "FILE"
      : "TEXT");

  const message = await prisma.message.create({
    data: {
      conversationId: conversation.id,
      senderType: "USER",
      senderUserId: tenant.userId,
      content: content || null,
      messageType,
      status: "SENT",
      attachments: hasAttachments
        ? {
            create: input.attachments!.map((a) => ({
              fileName: a.fileName,
              fileUrl: a.fileUrl,
              mimeType: a.mimeType,
              size: a.size,
            })),
          }
        : undefined,
    },
    include: {
      senderUser: { select: { id: true, name: true, email: true } },
      attachments: true,
    },
  });

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: message.createdAt },
  });

  const serialized = serializeMessage(message);

  await broadcastChatEvent(conversation.organizationId, conversation.id, {
    event: "message:new",
    payload: serialized,
  });

  await recordActivity({
    organizationId: tenant.organizationId,
    leadId: conversation.leadId,
    actorId: tenant.userId,
    type: LEAD_ACTIVITY_TYPES.CHAT_MESSAGE_SENT,
    message: "Message sent",
    next: { content: content.slice(0, 200), messageId: message.id },
  });

  const participantUserIds = conversation.participants
    .map((p) => p.userId)
    .filter((id) => id !== tenant.userId);

  for (const userId of participantUserIds) {
    await createChatNotification({
      organizationId: tenant.organizationId,
      userId,
      leadId: conversation.leadId,
      leadName: conversation.lead.fullName,
      conversationId: conversation.id,
      messageId: message.id,
      preview: content.slice(0, 120) || "Sent an attachment",
    });
  }

  if (
    conversation.lead.assignedUserId &&
    conversation.lead.assignedUserId !== tenant.userId &&
    !participantUserIds.includes(conversation.lead.assignedUserId)
  ) {
    await ensureParticipant(conversation.id, conversation.lead.assignedUserId);
    await createChatNotification({
      organizationId: tenant.organizationId,
      userId: conversation.lead.assignedUserId,
      leadId: conversation.leadId,
      leadName: conversation.lead.fullName,
      conversationId: conversation.id,
      messageId: message.id,
      preview: content.slice(0, 120) || "Sent an attachment",
    });
  }

  return serialized;
}

export async function sendLeadMessage(
  conversationId: string,
  content: string,
  attachments?: SendMessageInput["attachments"],
) {
  const trimmed = content.trim();
  const hasAttachments = (attachments?.length ?? 0) > 0;
  if (!trimmed && !hasAttachments) throw new Error("Message cannot be empty");

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      lead: { select: { id: true, fullName: true, assignedUserId: true } },
      participants: true,
    },
  });
  if (!conversation) throw new Error("Conversation not found");

  const messageType = hasAttachments
    ? attachments!.some((a) => a.mimeType.startsWith("image/"))
      ? "IMAGE"
      : "FILE"
    : "TEXT";

  const message = await prisma.message.create({
    data: {
      conversationId,
      senderType: "LEAD",
      content: trimmed || null,
      messageType,
      status: "SENT",
      attachments: hasAttachments
        ? { create: attachments!.map((a) => ({ ...a })) }
        : undefined,
    },
    include: { attachments: true },
  });

  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastMessageAt: message.createdAt },
  });

  const serialized = serializeMessage(message);

  await broadcastChatEvent(conversation.organizationId, conversation.id, {
    event: "message:new",
    payload: serialized,
  });

  await recordActivity({
    organizationId: conversation.organizationId,
    leadId: conversation.leadId,
    type: LEAD_ACTIVITY_TYPES.CHAT_MESSAGE_RECEIVED,
    message: "Message received",
    next: { content: trimmed.slice(0, 200), messageId: message.id },
  });

  const notifyIds = new Set<string>();
  if (conversation.lead.assignedUserId) {
    notifyIds.add(conversation.lead.assignedUserId);
  }
  for (const p of conversation.participants) {
    notifyIds.add(p.userId);
  }

  for (const userId of notifyIds) {
    await createChatNotification({
      organizationId: conversation.organizationId,
      userId,
      leadId: conversation.leadId,
      leadName: conversation.lead.fullName,
      conversationId: conversation.id,
      messageId: message.id,
      preview: trimmed.slice(0, 120) || "Sent an attachment",
    });
  }

  return serialized;
}

export async function markConversationRead(
  tenant: TenantContext,
  conversationId: string,
) {
  const conversation = await getConversationForTenant(tenant, conversationId);
  if (!conversation) return;

  const now = new Date();
  await prisma.conversationParticipant.update({
    where: {
      conversationId_userId: {
        conversationId,
        userId: tenant.userId,
      },
    },
    data: { lastReadAt: now },
  });

  await prisma.message.updateMany({
    where: {
      conversationId,
      OR: [
        { senderType: "LEAD" },
        {
          senderType: "USER",
          senderUserId: { not: tenant.userId },
        },
      ],
      status: { in: ["SENT", "DELIVERED"] },
    },
    data: { status: "READ" },
  });
}

export async function listMessages(conversationId: string, cursor?: string, limit = 50) {
  return prisma.message.findMany({
    where: { conversationId },
    include: {
      senderUser: { select: { id: true, name: true, email: true } },
      attachments: true,
    },
    orderBy: { createdAt: "asc" },
    take: limit,
    ...(cursor
      ? { skip: 1, cursor: { id: cursor } }
      : {}),
  });
}
