import type { MessageSender, MessageStatus, MessageType } from "@prisma/client";

export function computeUnreadCount(
  messages: { createdAt: Date; senderType: MessageSender; senderUserId: string | null }[],
  lastReadAt: Date | null,
  currentUserId: string,
) {
  const since = lastReadAt ?? new Date(0);
  return messages.filter((m) => {
    if (m.createdAt <= since) return false;
    if (m.senderType === "USER" && m.senderUserId === currentUserId) return false;
    if (m.senderType === "SYSTEM") return false;
    return true;
  }).length;
}

export function serializeMessage(message: {
  id: string;
  conversationId: string;
  senderType: MessageSender;
  senderUserId: string | null;
  content: string | null;
  messageType: MessageType;
  status: MessageStatus;
  createdAt: Date;
  senderUser?: { name: string | null; email: string } | null;
  attachments?: {
    id: string;
    fileName: string;
    fileUrl: string;
    mimeType: string;
    size: number;
  }[];
}) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderType: message.senderType,
    senderUserId: message.senderUserId,
    content: message.content,
    messageType: message.messageType,
    status: message.status,
    createdAt: message.createdAt.toISOString(),
    senderName:
      message.senderUser?.name ??
      message.senderUser?.email ??
      (message.senderType === "LEAD" ? "Lead" : null),
    attachments: message.attachments ?? [],
  };
}
