"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { conversationChannelName } from "@/lib/chat/realtime";

export function useTypingIndicator(
  organizationId: string | null,
  conversationId: string | null,
  currentUserId: string,
  currentUserName: string,
) {
  const [typingUsers, setTypingUsers] = useState<{ userId: string; name: string }[]>([]);
  const timeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    if (!organizationId || !conversationId) return;

    const supabase = createClient();
    const timeouts = timeoutRef.current;
    const channel = supabase
      .channel(conversationChannelName(organizationId, conversationId))
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        const data = payload as { userId: string; name: string; isTyping: boolean };
        if (data.userId === currentUserId) return;

        const existing = timeouts.get(data.userId);
        if (existing) clearTimeout(existing);

        if (data.isTyping) {
          setTypingUsers((prev) => {
            if (prev.some((u) => u.userId === data.userId)) return prev;
            return [...prev, { userId: data.userId, name: data.name }];
          });
          const t = setTimeout(() => {
            setTypingUsers((prev) => prev.filter((u) => u.userId !== data.userId));
            timeouts.delete(data.userId);
          }, 3000);
          timeouts.set(data.userId, t);
        } else {
          setTypingUsers((prev) => prev.filter((u) => u.userId !== data.userId));
        }
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
      timeouts.forEach(clearTimeout);
      timeouts.clear();
    };
  }, [organizationId, conversationId, currentUserId]);

  const sendTyping = useCallback(
    (isTyping: boolean) => {
      if (!organizationId || !conversationId) return;
      const supabase = createClient();
      const channel = supabase.channel(
        conversationChannelName(organizationId, conversationId),
      );
      channel.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void channel.send({
            type: "broadcast",
            event: "typing",
            payload: { userId: currentUserId, name: currentUserName, isTyping },
          });
          void supabase.removeChannel(channel);
        }
      });
    },
    [organizationId, conversationId, currentUserId, currentUserName],
  );

  const typingLabel =
    typingUsers.length === 0
      ? null
      : typingUsers.length === 1
        ? `${typingUsers[0].name} is typing…`
        : `${typingUsers.map((u) => u.name).join(", ")} are typing…`;

  return { typingLabel, sendTyping };
}
