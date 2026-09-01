"use server";

import { revalidatePath } from "next/cache";
import { requirePermission } from "@/lib/tenant";
import { isAppError } from "@/lib/errors";
import type { ActionResult } from "@/features/auth/types";
import {
  getOrCreateConversation,
  getConversationForTenant,
  rotateGuestToken,
} from "@/lib/chat/conversations";
import { sendUserMessage, markConversationRead } from "@/lib/chat/messages";
import { guestChatUrl } from "@/lib/chat/tokens";
import { recordActivity } from "@/lib/leads/activity";
import { LEAD_ACTIVITY_TYPES } from "@/lib/leads/activity-types";

export async function openLeadConversationAction(
  leadId: string,
): Promise<
  ActionResult & {
    conversationId?: string;
    guestChatUrl?: string;
  }
> {
  try {
    const tenant = await requirePermission("chat.view");
    const result = await getOrCreateConversation(tenant, leadId);
    if (!result) return { ok: false, error: "Lead not found" };

    revalidatePath("/messages");
    revalidatePath(`/leads/${leadId}`);

    return {
      ok: true,
      conversationId: result.conversation.id,
      guestChatUrl: result.guestToken ? guestChatUrl(result.guestToken) : undefined,
    };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: "Failed to open conversation" };
  }
}

export async function sendMessageAction(
  formData: FormData,
): Promise<ActionResult & { chatMessage?: unknown }> {
  try {
    const tenant = await requirePermission("chat.send");
    const conversationId = String(formData.get("conversationId") ?? "");
    const content = String(formData.get("content") ?? "");

    const message = await sendUserMessage(tenant, { conversationId, content });

    revalidatePath("/messages");
    revalidatePath(`/messages/${conversationId}`);
    return { ok: true, message: "Sent", chatMessage: message };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to send message",
    };
  }
}

export async function markConversationReadAction(
  conversationId: string,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("chat.view");
    await markConversationRead(tenant, conversationId);
    revalidatePath("/messages");
    revalidatePath(`/messages/${conversationId}`);
    return { ok: true };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: "Failed to mark as read" };
  }
}

export async function getGuestChatLinkAction(
  conversationId: string,
): Promise<ActionResult & { url?: string }> {
  try {
    const tenant = await requirePermission("chat.view");
    const conversation = await getConversationForTenant(tenant, conversationId);
    if (!conversation) return { ok: false, error: "Conversation not found" };

    const token = await rotateGuestToken(tenant, conversationId);
    if (!token) return { ok: false, error: "Could not generate link" };

    return { ok: true, url: guestChatUrl(token) };
  } catch (error) {
    if (isAppError(error)) {
      return { ok: false, error: error.message, code: error.code };
    }
    return { ok: false, error: "Failed to get chat link" };
  }
}

export async function logConversationOpenedAction(
  conversationId: string,
  leadId: string,
): Promise<ActionResult> {
  try {
    const tenant = await requirePermission("chat.view");
    await recordActivity({
      organizationId: tenant.organizationId,
      leadId,
      actorId: tenant.userId,
      type: LEAD_ACTIVITY_TYPES.CHAT_CONVERSATION_OPENED,
      message: "Conversation opened",
      next: { conversationId },
    });
    return { ok: true };
  } catch {
    return { ok: false, error: "Failed to log activity" };
  }
}
