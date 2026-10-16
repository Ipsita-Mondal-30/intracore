"use client";

import { useRef, useState, useTransition } from "react";
import { Paperclip, Send, Smile } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { sendMessageAction } from "@/features/chat/actions";
import type { RealtimeMessagePayload } from "@/lib/chat/realtime";

export function MessageComposer({
  conversationId,
  onSent,
  onTyping,
  disabled,
}: {
  conversationId: string;
  onSent?: (message: RealtimeMessagePayload) => void;
  onTyping?: (isTyping: boolean) => void;
  disabled?: boolean;
}) {
  const [content, setContent] = useState("");
  const [pending, startTransition] = useTransition();
  const sendingRef = useRef(false);

  const send = () => {
    const trimmed = content.trim();
    if (!trimmed || sendingRef.current || disabled) return;

    sendingRef.current = true;
    onTyping?.(false);

    startTransition(async () => {
      const fd = new FormData();
      fd.set("conversationId", conversationId);
      fd.set("content", trimmed);
      const result = await sendMessageAction(fd);
      sendingRef.current = false;

      if (result.ok) {
        setContent("");
        if (result.chatMessage) {
          onSent?.(result.chatMessage as RealtimeMessagePayload);
        }
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <div className="border-t border-[var(--ic-border)] bg-surface p-3">
      <div className="flex items-end gap-2">
        <Button type="button" variant="secondary" size="icon-sm" disabled={disabled}>
          <Paperclip className="h-4 w-4" />
        </Button>
        <Button type="button" variant="secondary" size="icon-sm" disabled={disabled}>
          <Smile className="h-4 w-4" />
        </Button>
        <Textarea
          rows={1}
          value={content}
          disabled={disabled || pending}
          placeholder="Type a message…"
          className="min-h-[44px] flex-1 resize-none"
          onChange={(e) => {
            setContent(e.target.value);
            onTyping?.(e.target.value.length > 0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
        />
        <Button
          type="button"
          size="icon-sm"
          disabled={disabled || pending || !content.trim()}
          onClick={send}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
