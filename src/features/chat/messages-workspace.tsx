"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import {
  ConversationList,
  type ConversationListItem,
} from "@/features/chat/conversation-list";
import { ChatPanel } from "@/features/chat/chat-panel";
import { COMMUNICATION_CHANNELS } from "@/lib/chat/channels";
import type { RealtimeMessagePayload } from "@/lib/chat/realtime";

const FILTERS = [
  { id: "all", label: "All" },
  { id: "chat", label: "Chat" },
  { id: "unread", label: "Unread" },
  ...COMMUNICATION_CHANNELS.filter((c) => !c.enabled && c.id !== "internal").map((c) => ({
    id: c.id,
    label: c.label,
    disabled: true,
  })),
];

export function MessagesWorkspace({
  organizationId,
  currentUserId,
  currentUserName,
  conversations,
  activeConversationId,
  activeDetail,
  canSend,
  initialQ,
  initialFilter,
  mobileShowConversation,
}: {
  organizationId: string;
  currentUserId: string;
  currentUserName: string;
  conversations: ConversationListItem[];
  activeConversationId: string | null;
  activeDetail: {
    conversationId: string;
    leadId: string;
    lead: {
      id: string;
      fullName: string;
      company: string | null;
      phone: string | null;
      email: string | null;
      whatsappNumber?: string | null;
    };
    messages: RealtimeMessagePayload[];
  } | null;
  canSend: boolean;
  initialQ?: string;
  initialFilter?: string;
  mobileShowConversation?: boolean;
}) {
  const router = useRouter();
  const [q, setQ] = useState(initialQ ?? "");
  const [filter, setFilter] = useState(initialFilter ?? "all");

  const filtered = useMemo(() => {
    let rows = conversations;
    if (filter === "unread") {
      rows = rows.filter((c) => c.unreadCount > 0);
    }
    if (q.trim()) {
      const needle = q.trim().toLowerCase();
      rows = rows.filter(
        (c) =>
          c.lead.fullName.toLowerCase().includes(needle) ||
          c.lead.email?.toLowerCase().includes(needle) ||
          c.lead.phone?.includes(needle) ||
          c.lastMessage?.content?.toLowerCase().includes(needle),
      );
    }
    return rows;
  }, [conversations, filter, q]);

  const selectConversation = (id: string) => {
    router.push(`/messages/${id}`);
  };

  return (
    <div className="flex h-[calc(100vh-12rem)] min-h-[560px] overflow-hidden rounded-2xl border border-[var(--ic-border)] bg-white">
      <aside
        className={cn(
          "flex w-full flex-col border-r border-[var(--ic-border)] md:w-[320px] lg:w-[360px]",
          mobileShowConversation && "hidden md:flex",
        )}
      >
        <div className="border-b border-[var(--ic-border)] p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search conversations"
              className="pl-9"
            />
          </div>
          <div className="mt-3 flex flex-wrap gap-1">
            {FILTERS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                disabled={"disabled" in tab && tab.disabled}
                onClick={() => !("disabled" in tab && tab.disabled) && setFilter(tab.id)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-2xs font-medium transition",
                  filter === tab.id
                    ? "bg-primary text-white"
                    : "bg-[var(--ic-surface-muted)] text-muted",
                  "disabled" in tab && tab.disabled && "opacity-40",
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        <ConversationList
          conversations={filtered}
          activeId={activeConversationId}
          onSelect={selectConversation}
          className="flex-1"
        />
      </aside>

      <main
        className={cn(
          "flex min-w-0 flex-1 flex-col",
          !mobileShowConversation && !activeConversationId && "hidden md:flex",
          mobileShowConversation ? "flex" : activeConversationId ? "hidden md:flex" : "",
        )}
      >
        {activeDetail ? (
          <ChatPanel
            organizationId={organizationId}
            conversationId={activeDetail.conversationId}
            leadId={activeDetail.leadId}
            currentUserId={currentUserId}
            currentUserName={currentUserName}
            lead={activeDetail.lead}
            initialMessages={activeDetail.messages}
            canSend={canSend}
          />
        ) : (
          <div className="flex flex-1 items-center justify-center p-8 text-center text-sm text-muted">
            <div>
              <p className="font-medium text-foreground">Select a conversation</p>
              <p className="mt-1">Choose a lead from the list or open Chat from a lead profile.</p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
