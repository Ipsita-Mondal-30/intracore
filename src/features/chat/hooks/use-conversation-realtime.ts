"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  conversationChannelName,
  type RealtimeMessagePayload,
} from "@/lib/chat/realtime";

export function useConversationRealtime(
  organizationId: string | null,
  conversationId: string | null,
  initialMessages: RealtimeMessagePayload[] = [],
) {
  const [messages, setMessages] = useState<RealtimeMessagePayload[]>(initialMessages);
  const seenIds = useRef(new Set(initialMessages.map((m) => m.id)));

  useEffect(() => {
    setMessages(initialMessages);
    seenIds.current = new Set(initialMessages.map((m) => m.id));
  }, [conversationId, initialMessages]);

  useEffect(() => {
    if (!organizationId || !conversationId) return;

    const supabase = createClient();
    const channelName = conversationChannelName(organizationId, conversationId);

    const channel = supabase
      .channel(channelName)
      .on("broadcast", { event: "message:new" }, ({ payload }) => {
        const msg = payload as RealtimeMessagePayload;
        if (seenIds.current.has(msg.id)) return;
        seenIds.current.add(msg.id);
        setMessages((prev) => [...prev, msg]);
      })
      .on("broadcast", { event: "message:updated" }, ({ payload }) => {
        const msg = payload as RealtimeMessagePayload;
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
      })
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "messages",
          filter: `conversationId=eq.${conversationId}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          const msg: RealtimeMessagePayload = {
            id: String(row.id),
            conversationId: String(row.conversationId),
            senderType: String(row.senderType),
            senderUserId: row.senderUserId ? String(row.senderUserId) : null,
            content: row.content ? String(row.content) : null,
            messageType: String(row.messageType),
            status: String(row.status),
            createdAt: String(row.createdAt),
          };
          if (seenIds.current.has(msg.id)) return;
          seenIds.current.add(msg.id);
          setMessages((prev) => [...prev, msg]);
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [organizationId, conversationId]);

  const appendMessage = useCallback((msg: RealtimeMessagePayload) => {
    if (seenIds.current.has(msg.id)) return;
    seenIds.current.add(msg.id);
    setMessages((prev) => [...prev, msg]);
  }, []);

  return { messages, setMessages, appendMessage };
}
