import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import type { TenantContext } from "@/lib/tenant";
import { leadVisibilityWhere } from "@/features/leads/scope";
import { computeUnreadCount, serializeMessage } from "@/lib/chat/unread";

async function batchUnreadCounts(
  tenant: TenantContext,
  conversationIds: string[],
) {
  const counts = new Map<string, number>();
  if (conversationIds.length === 0) return counts;

  const rows = await prisma.$queryRaw<Array<{ conversationId: string; count: bigint }>>`
    SELECT m."conversationId", COUNT(*)::bigint AS count
    FROM messages m
    INNER JOIN conversation_participants cp
      ON cp."conversationId" = m."conversationId"
      AND cp."userId" = ${tenant.userId}::uuid
    WHERE m."conversationId" IN (${Prisma.join(conversationIds)})
      AND (
        m."senderType" = 'LEAD'::"MessageSender"
        OR (
          m."senderType" = 'USER'::"MessageSender"
          AND m."senderUserId" IS NOT NULL
          AND m."senderUserId" != ${tenant.userId}::uuid
        )
      )
      AND (cp."lastReadAt" IS NULL OR m."createdAt" > cp."lastReadAt")
    GROUP BY m."conversationId"
  `;

  for (const row of rows) {
    counts.set(row.conversationId, Number(row.count));
  }

  return counts;
}

export async function listConversations(
  tenant: TenantContext,
  options?: { q?: string; unreadOnly?: boolean },
) {
  const leadWhere: Prisma.LeadWhereInput = {
    ...leadVisibilityWhere(tenant),
    archivedAt: null,
  };

  if (options?.q?.trim()) {
    const q = options.q.trim();
    leadWhere.OR = [
      { fullName: { contains: q, mode: "insensitive" } },
      { email: { contains: q, mode: "insensitive" } },
      { phone: { contains: q, mode: "insensitive" } },
      { company: { contains: q, mode: "insensitive" } },
    ];
  }

  const conversations = await prisma.conversation.findMany({
    where: {
      organizationId: tenant.organizationId,
      lead: leadWhere,
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
        },
      },
      participants: {
        where: { userId: tenant.userId },
        select: { lastReadAt: true },
      },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          content: true,
          senderType: true,
          senderUserId: true,
          createdAt: true,
          messageType: true,
        },
      },
    },
    orderBy: [{ lastMessageAt: "desc" }, { updatedAt: "desc" }],
    take: 100,
  });

  const unreadCounts = await batchUnreadCounts(
    tenant,
    conversations.map((conv) => conv.id),
  );

  const withUnread = conversations.map((conv) => {
    const lastMessage = conv.messages[0] ?? null;
    return {
      id: conv.id,
      leadId: conv.leadId,
      lastMessageAt: conv.lastMessageAt,
      unreadCount: unreadCounts.get(conv.id) ?? 0,
      lead: conv.lead,
      lastMessage: lastMessage
        ? {
            content: lastMessage.content,
            senderType: lastMessage.senderType,
            createdAt: lastMessage.createdAt,
            messageType: lastMessage.messageType,
          }
        : null,
    };
  });

  if (options?.unreadOnly) {
    return withUnread.filter((c) => c.unreadCount > 0);
  }

  return withUnread;
}

export async function getConversationDetail(
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

  const messages = await prisma.message.findMany({
    where: { conversationId },
    include: {
      senderUser: { select: { id: true, name: true, email: true } },
      attachments: true,
    },
    orderBy: { createdAt: "asc" },
    take: 200,
  });

  const participant = conversation.participants.find((p) => p.userId === tenant.userId);
  const unreadCount = computeUnreadCount(
    messages,
    participant?.lastReadAt ?? null,
    tenant.userId,
  );

  return {
    conversation,
    messages: messages.map(serializeMessage),
    unreadCount,
  };
}

export async function searchMessages(tenant: TenantContext, q: string, limit = 50) {
  const trimmed = q.trim();
  if (!trimmed) return [];

  return prisma.message.findMany({
    where: {
      content: { contains: trimmed, mode: "insensitive" },
      conversation: {
        organizationId: tenant.organizationId,
        lead: leadVisibilityWhere(tenant),
      },
    },
    include: {
      conversation: {
        include: {
          lead: { select: { id: true, fullName: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

export async function getConversationByLeadId(tenant: TenantContext, leadId: string) {
  return prisma.conversation.findFirst({
    where: {
      organizationId: tenant.organizationId,
      leadId,
      lead: leadVisibilityWhere(tenant),
    },
    select: { id: true },
  });
}
