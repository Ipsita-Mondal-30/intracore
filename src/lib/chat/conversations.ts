import { prisma } from "@/lib/db/prisma";
import type { TenantContext } from "@/lib/tenant";
import { assertSameOrganization } from "@/lib/tenant/assert";
import { leadVisibilityWhere } from "@/features/leads/scope";
import { generateGuestToken, hashGuestToken } from "@/lib/chat/tokens";
import { recordActivity } from "@/lib/leads/activity";
import { LEAD_ACTIVITY_TYPES } from "@/lib/leads/activity-types";

export async function getOrCreateConversation(
  tenant: TenantContext,
  leadId: string,
) {
  const lead = await prisma.lead.findFirst({
    where: { id: leadId, ...leadVisibilityWhere(tenant), archivedAt: null },
  });
  if (!lead) return null;

  let conversation = await prisma.conversation.findUnique({
    where: {
      organizationId_leadId: {
        organizationId: tenant.organizationId,
        leadId,
      },
    },
    include: {
      lead: {
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          company: true,
          priority: true,
          assignedUserId: true,
        },
      },
      participants: {
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
      },
    },
  });

  if (!conversation) {
    const guestToken = generateGuestToken();
    conversation = await prisma.conversation.create({
      data: {
        organizationId: tenant.organizationId,
        leadId,
        guestTokenHash: hashGuestToken(guestToken),
        participants: {
          create: { userId: tenant.userId },
        },
      },
      include: {
        lead: {
          select: {
            id: true,
            fullName: true,
            email: true,
            phone: true,
            company: true,
            priority: true,
            assignedUserId: true,
          },
        },
        participants: {
          include: {
            user: { select: { id: true, name: true, email: true, image: true } },
          },
        },
      },
    });

    await recordActivity({
      organizationId: tenant.organizationId,
      leadId,
      actorId: tenant.userId,
      type: LEAD_ACTIVITY_TYPES.CHAT_CONVERSATION_OPENED,
      message: "Conversation started",
    });

    return { conversation, guestToken };
  }

  await ensureParticipant(conversation.id, tenant.userId);
  return { conversation, guestToken: null as string | null };
}

export async function ensureParticipant(conversationId: string, userId: string) {
  await prisma.conversationParticipant.upsert({
    where: {
      conversationId_userId: { conversationId, userId },
    },
    create: { conversationId, userId },
    update: {},
  });
}

export async function getConversationForTenant(
  tenant: TenantContext,
  conversationId: string,
) {
  const conversation = await prisma.conversation.findFirst({
    where: {
      id: conversationId,
      organizationId: tenant.organizationId,
      lead: leadVisibilityWhere(tenant),
    },
    include: {
      lead: {
        select: {
          id: true,
          fullName: true,
          email: true,
          phone: true,
          whatsappNumber: true,
          company: true,
          priority: true,
          assignedUserId: true,
        },
      },
      participants: {
        include: {
          user: { select: { id: true, name: true, email: true, image: true } },
        },
      },
    },
  });
  if (!conversation) return null;
  assertSameOrganization(conversation.organizationId, tenant.organizationId);
  await ensureParticipant(conversation.id, tenant.userId);
  return conversation;
}

export async function getConversationByGuestToken(token: string) {
  const hash = hashGuestToken(token);
  return prisma.conversation.findFirst({
    where: { guestTokenHash: hash },
    include: {
      lead: {
        select: {
          id: true,
          fullName: true,
          firstName: true,
        },
      },
      organization: {
        select: { id: true, name: true },
      },
    },
  });
}

export async function rotateGuestToken(
  tenant: TenantContext,
  conversationId: string,
) {
  const conversation = await getConversationForTenant(tenant, conversationId);
  if (!conversation) return null;

  const guestToken = generateGuestToken();
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { guestTokenHash: hashGuestToken(guestToken) },
  });
  return guestToken;
}
