import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { requirePermission, hasPermission } from "@/lib/tenant";
import { listConversations, getConversationDetail } from "@/features/chat/queries";
import { PageHeader } from "@/components/layout/page-header";
import { MessagesWorkspace } from "@/features/chat/messages-workspace";
import { Button } from "@/components/ui/button";

export default async function ConversationPage({
  params,
  searchParams,
}: {
  params: Promise<{ conversationId: string }>;
  searchParams: Promise<{ q?: string; filter?: string }>;
}) {
  const tenant = await requirePermission("chat.view");
  const { conversationId } = await params;
  const query = await searchParams;

  const [conversations, detail] = await Promise.all([
    listConversations(tenant, { q: query.q, unreadOnly: query.filter === "unread" }),
    getConversationDetail(tenant, conversationId),
  ]);

  if (!detail) notFound();

  return (
    <div>
      <PageHeader
        breadcrumbs={["Messages", detail.conversation.lead.fullName]}
        title="Messages"
        actions={
          <Link href="/messages" className="md:hidden">
            <Button variant="secondary" size="sm">
              <ChevronLeft className="h-4 w-4" />
              Back
            </Button>
          </Link>
        }
      />
      <MessagesWorkspace
        organizationId={tenant.organizationId}
        currentUserId={tenant.userId}
        currentUserName={tenant.userName ?? tenant.userEmail ?? "You"}
        conversations={conversations.map((c) => ({
          ...c,
          lastMessageAt: c.lastMessageAt,
          lastMessage: c.lastMessage
            ? { ...c.lastMessage, createdAt: c.lastMessage.createdAt }
            : null,
        }))}
        activeConversationId={conversationId}
        activeDetail={{
          conversationId,
          leadId: detail.conversation.leadId,
          lead: detail.conversation.lead,
          messages: detail.messages,
        }}
        canSend={hasPermission(tenant, "chat.send")}
        initialQ={query.q}
        initialFilter={query.filter}
        mobileShowConversation
      />
    </div>
  );
}
