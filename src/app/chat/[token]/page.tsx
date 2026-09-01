import { notFound } from "next/navigation";
import { getConversationByGuestToken } from "@/lib/chat/conversations";
import { prisma } from "@/lib/db/prisma";
import { serializeMessage } from "@/lib/chat/unread";
import { GuestChatView } from "@/features/chat/guest-chat-view";

export default async function GuestChatPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const conversation = await getConversationByGuestToken(token);
  if (!conversation) notFound();

  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    include: { attachments: true },
    orderBy: { createdAt: "asc" },
    take: 200,
  });

  return (
    <GuestChatView
      token={token}
      organizationId={conversation.organizationId}
      conversationId={conversation.id}
      leadName={conversation.lead.firstName ?? conversation.lead.fullName}
      organizationName={conversation.organization.name}
      initialMessages={messages.map(serializeMessage)}
    />
  );
}
