"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ChatPanel } from "@/features/chat/chat-panel";
import { openLeadConversationAction } from "@/features/chat/actions";
import type { RealtimeMessagePayload } from "@/lib/chat/realtime";

export function LeadChatDrawer({
  open,
  onOpenChange,
  leadId,
  leadName,
  organizationId,
  currentUserId,
  currentUserName,
  canSend,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  leadName: string;
  organizationId: string;
  currentUserId: string;
  currentUserName: string;
  canSend: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [lead, setLead] = useState<{
    id: string;
    fullName: string;
    company: string | null;
    phone: string | null;
    email: string | null;
    whatsappNumber?: string | null;
  } | null>(null);
  const [messages, setMessages] = useState<RealtimeMessagePayload[]>([]);

  useEffect(() => {
    if (!open) return;

    void (async () => {
      setLoading(true);
      const result = await openLeadConversationAction(leadId);
      if (!result.ok || !result.conversationId) {
        setLoading(false);
        if (!result.ok) toast.error(result.error ?? "Failed to open chat");
        return;
      }

      setConversationId(result.conversationId);
      const res = await fetch(`/api/chat/agent/conversation?id=${result.conversationId}`);
      const data = await res.json();
      setLoading(false);
      if (data.ok) {
        setLead(data.lead);
        setMessages(data.messages);
      }
    })();
  }, [open, leadId]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="p-0">
        <SheetHeader>
          <SheetTitle>Chat with {leadName}</SheetTitle>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          {loading || !conversationId || !lead ? (
            <div className="flex flex-1 items-center justify-center p-8 text-sm text-muted">
              Loading conversation…
            </div>
          ) : (
            <ChatPanel
              organizationId={organizationId}
              conversationId={conversationId}
              leadId={leadId}
              currentUserId={currentUserId}
              currentUserName={currentUserName}
              lead={lead}
              initialMessages={messages}
              canSend={canSend}
              compact
            />
          )}
          {conversationId ? (
            <div className="border-t border-[var(--ic-border)] p-3">
              <Button
                variant="secondary"
                size="sm"
                className="w-full"
                onClick={() => router.push(`/messages/${conversationId}`)}
              >
                Open in Messages
              </Button>
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}

export async function openLeadChat(leadId: string, router: { push: (path: string) => void }) {
  const result = await openLeadConversationAction(leadId);
  if (result.ok && result.conversationId) {
    router.push(`/messages/${result.conversationId}`);
    return true;
  }
  if (!result.ok) toast.error(result.error ?? "Failed to open chat");
  return false;
}
