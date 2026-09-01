"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { MessageList } from "@/features/chat/message-list";
import { MessageComposer } from "@/features/chat/message-composer";
import { ChatPanelHeader } from "@/features/chat/conversation-list";
import { useConversationRealtime } from "@/features/chat/hooks/use-conversation-realtime";
import { useTypingIndicator } from "@/features/chat/hooks/use-typing-indicator";
import {
  getGuestChatLinkAction,
  logConversationOpenedAction,
  markConversationReadAction,
} from "@/features/chat/actions";
import type { RealtimeMessagePayload } from "@/lib/chat/realtime";

export function ChatPanel({
  organizationId,
  conversationId,
  leadId,
  currentUserId,
  currentUserName,
  lead,
  initialMessages,
  canSend,
  compact,
}: {
  organizationId: string;
  conversationId: string;
  leadId: string;
  currentUserId: string;
  currentUserName: string;
  lead: {
    id: string;
    fullName: string;
    company: string | null;
    phone: string | null;
    email: string | null;
    whatsappNumber?: string | null;
  };
  initialMessages: RealtimeMessagePayload[];
  canSend: boolean;
  compact?: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const { messages, appendMessage } = useConversationRealtime(
    organizationId,
    conversationId,
    initialMessages,
  );
  const { typingLabel, sendTyping } = useTypingIndicator(
    organizationId,
    conversationId,
    currentUserId,
    currentUserName,
  );

  useEffect(() => {
    void markConversationReadAction(conversationId);
    void logConversationOpenedAction(conversationId, leadId);
  }, [conversationId, leadId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, typingLabel]);

  const copyGuestLink = async () => {
    const result = await getGuestChatLinkAction(conversationId);
    if (result.ok && result.url) {
      await navigator.clipboard.writeText(result.url);
      toast.success("Lead chat link copied");
    } else if (!result.ok) {
      toast.error(result.error ?? "Failed to copy link");
    }
  };

  return (
    <div className={`flex h-full min-h-0 flex-col bg-canvas ${compact ? "" : ""}`}>
      <ChatPanelHeader lead={lead} onCopyLink={copyGuestLink} />
      <MessageList
        messages={messages}
        currentUserId={currentUserId}
        leadName={lead.fullName}
      />
      {typingLabel ? (
        <p className="px-4 pb-1 text-2xs italic text-subtle">{typingLabel}</p>
      ) : null}
      <div ref={bottomRef} />
      {canSend ? (
        <MessageComposer
          conversationId={conversationId}
          onSent={appendMessage}
          onTyping={sendTyping}
        />
      ) : (
        <div className="border-t border-[var(--ic-border)] p-3 text-sm text-muted">
          You don&apos;t have permission to send messages.
        </div>
      )}
    </div>
  );
}
