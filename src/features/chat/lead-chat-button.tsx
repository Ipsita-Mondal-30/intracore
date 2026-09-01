"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openLeadConversationAction } from "@/features/chat/actions";
import { toast } from "sonner";

export function LeadChatButton({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="secondary"
      size="icon-sm"
      disabled={pending}
      aria-label="Chat"
      onClick={() => {
        startTransition(async () => {
          const result = await openLeadConversationAction(leadId);
          if (result.ok && result.conversationId) {
            router.push(`/messages/${result.conversationId}`);
          } else if (!result.ok) {
            toast.error(result.error ?? "Failed to open chat");
          }
        });
      }}
    >
      <MessageSquare className="h-3.5 w-3.5" />
    </Button>
  );
}
