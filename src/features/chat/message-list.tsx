"use client";

import { format, isToday, isYesterday } from "date-fns";
import { cn } from "@/lib/utils";
import { Avatar } from "@/components/ui/avatar";
import type { RealtimeMessagePayload } from "@/lib/chat/realtime";

function dateLabel(date: Date) {
  if (isToday(date)) return "Today";
  if (isYesterday(date)) return "Yesterday";
  return format(date, "d MMMM yyyy");
}

function statusIcon(status: string) {
  if (status === "READ") return "✓✓";
  if (status === "DELIVERED" || status === "SENT") return "✓";
  if (status === "FAILED") return "!";
  return "…";
}

export function MessageList({
  messages,
  currentUserId,
  leadName,
}: {
  messages: RealtimeMessagePayload[];
  currentUserId: string;
  leadName: string;
}) {
  let lastDate = "";

  return (
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-4 py-4">
      {messages.map((message) => {
        const created = new Date(message.createdAt);
        const label = dateLabel(created);
        const showDate = label !== lastDate;
        lastDate = label;

        const isOwn =
          message.senderType === "USER" && message.senderUserId === currentUserId;
        const isLead = message.senderType === "LEAD";
        const isSystem = message.senderType === "SYSTEM";
        const senderLabel = isLead
          ? leadName
          : isSystem
            ? "System"
            : (message.senderName ?? "Team");

        return (
          <div key={message.id}>
            {showDate ? (
              <p className="my-3 text-center text-2xs uppercase tracking-wide text-subtle">
                {label}
              </p>
            ) : null}
            <div
              className={cn(
                "flex gap-2",
                isOwn ? "flex-row-reverse" : "flex-row",
                isSystem && "justify-center",
              )}
            >
              {!isSystem ? (
                <Avatar name={senderLabel} size="sm" className="mt-1 shrink-0" />
              ) : null}
              <div className={cn("max-w-[75%]", isSystem && "max-w-full text-center")}>
                {!isSystem ? (
                  <p className="mb-1 text-2xs text-subtle">{senderLabel}</p>
                ) : null}
                <div
                  className={cn(
                    "rounded-2xl px-3 py-2 text-sm",
                    isOwn
                      ? "rounded-br-md bg-primary text-white"
                      : isSystem
                        ? "bg-[var(--ic-surface-muted)] text-muted"
                        : "rounded-bl-md border border-[var(--ic-border)] bg-surface",
                  )}
                >
                  {message.content ? (
                    <p className="whitespace-pre-wrap break-words">{message.content}</p>
                  ) : null}
                  {message.attachments?.map((a) => (
                    <a
                      key={a.id}
                      href={a.fileUrl}
                      target="_blank"
                      rel="noreferrer"
                      className={cn(
                        "mt-1 block text-xs underline",
                        isOwn ? "text-white/90" : "text-primary",
                      )}
                    >
                      {a.fileName}
                    </a>
                  ))}
                </div>
                <div
                  className={cn(
                    "mt-1 flex items-center gap-1 text-2xs text-subtle",
                    isOwn && "justify-end",
                  )}
                >
                  <span>{format(created, "HH:mm")}</span>
                  {isOwn ? <span>{statusIcon(message.status)}</span> : null}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
