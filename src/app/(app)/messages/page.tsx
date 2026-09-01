import { requirePermission, hasPermission } from "@/lib/tenant";
import { listConversations } from "@/features/chat/queries";
import { PageHeader } from "@/components/layout/page-header";
import { MessagesWorkspace } from "@/features/chat/messages-workspace";

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; filter?: string }>;
}) {
  const tenant = await requirePermission("chat.view");
  const params = await searchParams;
  const conversations = await listConversations(tenant, {
    q: params.q,
    unreadOnly: params.filter === "unread",
  });

  return (
    <div>
      <PageHeader
        breadcrumbs={["Messages"]}
        title="Messages"
        subtitle="Communication center"
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
        activeConversationId={null}
        activeDetail={null}
        canSend={hasPermission(tenant, "chat.send")}
        initialQ={params.q}
        initialFilter={params.filter}
      />
    </div>
  );
}
