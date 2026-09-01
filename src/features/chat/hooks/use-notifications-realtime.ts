"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string | null;
  data: unknown;
  readAt: string | null;
  createdAt: string;
};

export function useNotificationsRealtime(
  organizationId: string | null,
  userId: string | null,
  initialCount: number,
  onNewNotification?: (notification: NotificationRow) => void,
) {
  const [unreadCount, setUnreadCount] = useState(initialCount);

  useEffect(() => {
    setUnreadCount(initialCount);
  }, [initialCount]);

  useEffect(() => {
    if (!organizationId || !userId) return;

    const supabase = createClient();
    const channel = supabase
      .channel(`notifications:${organizationId}:${userId}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "notifications",
          filter: `userId=eq.${userId}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>;
          if (row.organizationId !== organizationId) return;
          setUnreadCount((c) => c + 1);
          onNewNotification?.({
            id: String(row.id),
            type: String(row.type),
            title: String(row.title),
            body: row.body ? String(row.body) : null,
            data: row.data,
            readAt: row.readAt ? String(row.readAt) : null,
            createdAt: String(row.createdAt),
          });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [organizationId, userId, onNewNotification]);

  return { unreadCount, setUnreadCount };
}
