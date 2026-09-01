"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { orgPresenceChannelName } from "@/lib/chat/realtime";

export function useOrgPresence(organizationId: string | null, userId: string, userName: string) {
  const [onlineUserIds, setOnlineUserIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!organizationId) return;

    const supabase = createClient();
    const channel = supabase.channel(orgPresenceChannelName(organizationId), {
      config: { presence: { key: userId } },
    });

    channel
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState();
        const ids = new Set<string>();
        for (const key of Object.keys(state)) {
          ids.add(key);
        }
        setOnlineUserIds(ids);
      })
      .subscribe(async (status) => {
        if (status === "SUBSCRIBED") {
          await channel.track({ userId, name: userName, online_at: new Date().toISOString() });
        }
      });

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [organizationId, userId, userName]);

  return { onlineUserIds, isOnline: (id: string) => onlineUserIds.has(id) };
}
