import { createAdminClient } from "@/lib/supabase/admin";
import {
  conversationChannelName,
  type RealtimeEvent,
} from "@/lib/chat/realtime";

export async function broadcastChatEvent(
  organizationId: string,
  conversationId: string,
  event: RealtimeEvent,
) {
  try {
    const supabase = createAdminClient();
    const channel = supabase.channel(conversationChannelName(organizationId, conversationId));
    await channel.subscribe();
    await channel.send({
      type: "broadcast",
      event: event.event,
      payload: event.payload,
    });
    await supabase.removeChannel(channel);
  } catch (error) {
    console.error("[chat] broadcast failed", error);
  }
}
