export function conversationChannelName(organizationId: string, conversationId: string) {
  return `org:${organizationId}:conv:${conversationId}`;
}

export function orgPresenceChannelName(organizationId: string) {
  return `org:${organizationId}:presence`;
}

export type RealtimeMessagePayload = {
  id: string;
  conversationId: string;
  senderType: string;
  senderUserId: string | null;
  content: string | null;
  messageType: string;
  status: string;
  createdAt: string;
  senderName?: string | null;
  attachments?: {
    id: string;
    fileName: string;
    fileUrl: string;
    mimeType: string;
    size: number;
  }[];
};

export type RealtimeEvent =
  | { event: "message:new"; payload: RealtimeMessagePayload }
  | { event: "message:updated"; payload: RealtimeMessagePayload }
  | { event: "conversation:updated"; payload: { conversationId: string; lastMessageAt: string } }
  | { event: "typing"; payload: { userId: string; name: string; isTyping: boolean } };
