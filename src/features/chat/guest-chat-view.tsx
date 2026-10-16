"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { MessageList } from "@/features/chat/message-list";
import { useConversationRealtime } from "@/features/chat/hooks/use-conversation-realtime";
import type { RealtimeMessagePayload } from "@/lib/chat/realtime";

export function GuestChatView({
  token,
  organizationId,
  conversationId,
  leadName,
  organizationName,
  initialMessages,
}: {
  token: string;
  organizationId: string;
  conversationId: string;
  leadName: string;
  organizationName: string;
  initialMessages: RealtimeMessagePayload[];
}) {
  const [content, setContent] = useState("");
  const [pending, startTransition] = useTransition();
  const sendingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const { messages, appendMessage } = useConversationRealtime(
    organizationId,
    conversationId,
    initialMessages,
  );

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length]);

  const send = () => {
    const trimmed = content.trim();
    if (!trimmed || sendingRef.current) return;
    sendingRef.current = true;

    startTransition(async () => {
      const res = await fetch("/api/chat/guest/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, content: trimmed }),
      });
      const data = await res.json();
      sendingRef.current = false;

      if (data.ok) {
        setContent("");
        appendMessage(data.message as RealtimeMessagePayload);
      } else {
        toast.error(data.error ?? "Failed to send");
      }
    });
  };

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <header className="border-b border-[var(--ic-border)] bg-surface px-4 py-4">
        <p className="text-2xs uppercase tracking-wide text-subtle">{organizationName}</p>
        <h1 className="text-lg font-semibold">Chat with {organizationName}</h1>
        <p className="text-sm text-muted">You are chatting as {leadName}</p>
      </header>

      <MessageList
        messages={messages}
        currentUserId="__guest__"
        leadName={leadName}
      />
      <div ref={bottomRef} />

      <div className="border-t border-[var(--ic-border)] bg-surface p-3">
        <div className="mx-auto flex max-w-2xl items-end gap-2">
          <textarea
            rows={1}
            value={content}
            disabled={pending}
            placeholder="Type a message…"
            className="min-h-[44px] flex-1 resize-none rounded-xl border border-[var(--ic-border)] px-3 py-2 text-sm outline-none focus:border-primary"
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            type="button"
            disabled={pending || !content.trim()}
            onClick={send}
            className="rounded-xl bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
