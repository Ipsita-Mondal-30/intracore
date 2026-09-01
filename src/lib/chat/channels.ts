export type CommunicationChannelId =
  | "internal"
  | "whatsapp"
  | "email"
  | "instagram"
  | "facebook"
  | "linkedin";

export type ThreadSummary = {
  id: string;
  channel: CommunicationChannelId;
  title: string;
  preview: string | null;
  lastMessageAt: Date | null;
  unreadCount: number;
};

export type SendResult = {
  ok: boolean;
  messageId?: string;
  error?: string;
};

export interface CommunicationChannel {
  id: CommunicationChannelId;
  label: string;
  listThreads(ctx: { organizationId: string; userId: string }): Promise<ThreadSummary[]>;
  sendMessage(
    ctx: { organizationId: string; userId: string },
    input: { threadId: string; content: string },
  ): Promise<SendResult>;
}

/** Internal IntraCore chat — implemented in Phase 1. */
export const internalChatChannel: Pick<CommunicationChannel, "id" | "label"> = {
  id: "internal",
  label: "Chat",
};

export const COMMUNICATION_CHANNELS = [
  { id: "internal" as const, label: "Chat", enabled: true },
  { id: "whatsapp" as const, label: "WhatsApp", enabled: false },
  { id: "email" as const, label: "Email", enabled: false },
  { id: "instagram" as const, label: "Instagram", enabled: false },
  { id: "facebook" as const, label: "Facebook", enabled: false },
  { id: "linkedin" as const, label: "LinkedIn", enabled: false },
];
