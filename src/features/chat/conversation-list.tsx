"use client";

import Link from "next/link";
import { format } from "date-fns";
import { Phone, Mail } from "lucide-react";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export type ConversationListItem = {
  id: string;
  leadId: string;
  lastMessageAt: Date | null;
  unreadCount: number;
  lead: {
    id: string;
    fullName: string;
    email: string | null;
    phone: string | null;
    company: string | null;
    priority: string;
  };
  lastMessage: {
    content: string | null;
    senderType: string;
    createdAt: Date;
    messageType: string;
  } | null;
};

export function ConversationList({
  conversations,
  activeId,
  onSelect,
  className,
}: {
  conversations: ConversationListItem[];
  activeId?: string | null;
  onSelect: (id: string) => void;
  className?: string;
}) {
  if (conversations.length === 0) {
    return (
      <div className={cn("p-6 text-sm text-muted", className)}>
        No conversations yet. Open a lead and start chatting.
      </div>
    );
  }

  return (
    <div className={cn("overflow-y-auto", className)}>
      {conversations.map((conv) => {
        const preview =
          conv.lastMessage?.content ??
          (conv.lastMessage?.messageType !== "TEXT" ? "Attachment" : "No messages yet");
        const time = conv.lastMessageAt ?? conv.lastMessage?.createdAt;

        return (
          <button
            key={conv.id}
            type="button"
            onClick={() => onSelect(conv.id)}
            className={cn(
              "flex w-full items-start gap-3 border-b border-[var(--ic-border)] px-4 py-3 text-left transition hover:bg-[var(--ic-surface-muted)]",
              activeId === conv.id && "bg-[var(--ic-surface-muted)]",
            )}
          >
            <Avatar name={conv.lead.fullName} size="md" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate font-medium">{conv.lead.fullName}</p>
                {time ? (
                  <span className="shrink-0 text-2xs text-subtle">
                    {format(new Date(time), "HH:mm")}
                  </span>
                ) : null}
              </div>
              <p className="truncate text-sm text-muted">{preview}</p>
              <div className="mt-1 flex items-center gap-2">
                {conv.lead.priority === "HIGH" ? (
                  <Badge tone="danger" className="text-2xs">
                    High
                  </Badge>
                ) : null}
                {conv.unreadCount > 0 ? (
                  <Badge tone="primary" className="text-2xs">
                    {conv.unreadCount}
                  </Badge>
                ) : null}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function ChatPanelHeader({
  lead,
  isOnline,
  guestChatUrl,
  onCopyLink,
}: {
  lead: {
    id: string;
    fullName: string;
    company: string | null;
    phone: string | null;
    email: string | null;
    whatsappNumber?: string | null;
  };
  isOnline?: boolean;
  guestChatUrl?: string | null;
  onCopyLink?: () => void;
}) {
  const tel = lead.phone ? `tel:${lead.phone}` : null;
  const mail = lead.email ? `mailto:${lead.email}` : null;
  const wa = lead.whatsappNumber
    ? `https://wa.me/${lead.whatsappNumber.replace(/\D/g, "")}`
    : null;

  return (
    <div className="border-b border-[var(--ic-border)] px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <Avatar name={lead.fullName} size="md" />
          <div>
            <Link href={`/leads/${lead.id}`} className="font-semibold hover:text-primary">
              {lead.fullName}
            </Link>
            {lead.company ? (
              <p className="text-sm text-muted">{lead.company}</p>
            ) : null}
            <p className="text-2xs text-subtle">
              {isOnline ? (
                <span className="text-success">Online</span>
              ) : (
                <span>Offline</span>
              )}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          {tel ? (
            <a href={tel}>
              <Button size="icon-sm" variant="secondary">
                <Phone className="h-3.5 w-3.5" />
              </Button>
            </a>
          ) : null}
          {wa ? (
            <a href={wa} target="_blank" rel="noreferrer">
              <Button size="sm" variant="secondary">
                WhatsApp
              </Button>
            </a>
          ) : null}
          {mail ? (
            <a href={mail}>
              <Button size="icon-sm" variant="secondary">
                <Mail className="h-3.5 w-3.5" />
              </Button>
            </a>
          ) : null}
          {guestChatUrl || onCopyLink ? (
            <Button size="sm" variant="secondary" onClick={onCopyLink}>
              Copy lead link
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
