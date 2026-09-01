import { NextResponse } from "next/server";
import { getConversationByGuestToken } from "@/lib/chat/conversations";
import { prisma } from "@/lib/db/prisma";
import { serializeMessage } from "@/lib/chat/unread";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token")?.trim();
  if (!token) {
    return NextResponse.json({ ok: false, error: "Token required" }, { status: 400 });
  }

  const conversation = await getConversationByGuestToken(token);
  if (!conversation) {
    return NextResponse.json({ ok: false, error: "Invalid chat link" }, { status: 404 });
  }

  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id },
    include: { attachments: true },
    orderBy: { createdAt: "asc" },
    take: 200,
  });

  return NextResponse.json({
    ok: true,
    conversationId: conversation.id,
    organizationId: conversation.organizationId,
    leadName: conversation.lead.firstName ?? conversation.lead.fullName,
    organizationName: conversation.organization.name,
    messages: messages.map(serializeMessage),
  });
}
