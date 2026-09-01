"use client";

import { useTransition } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { toast } from "sonner";
import { runFollowUpReminderEmailsAction } from "@/features/leads/email-actions";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function RunRemindersButton() {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          const result = await runFollowUpReminderEmailsAction();
          if (result.ok) {
            toast.success(result.message ?? "Reminders processed");
          } else {
            toast.error(result.error);
          }
        });
      }}
    >
      {pending ? "Sending…" : "Send due reminders now"}
    </Button>
  );
}

export function EmailLogTable({
  rows,
}: {
  rows: {
    id: string;
    subject: string | null;
    bodyPreview: string | null;
    occurredAt: Date;
    externalId: string | null;
    metadata: unknown;
    lead: { id: string; fullName: string; email: string | null };
    user: { name: string | null; email: string } | null;
  }[];
}) {
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted">
        No emails logged yet. Send a message from a lead profile or run due reminders.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-[var(--ic-border)] text-left text-2xs uppercase tracking-wide text-subtle">
            <th className="px-2 py-2">Date</th>
            <th className="px-2 py-2">Lead</th>
            <th className="px-2 py-2">Subject</th>
            <th className="px-2 py-2">Type</th>
            <th className="px-2 py-2">To</th>
            <th className="px-2 py-2">By</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const meta =
              row.metadata && typeof row.metadata === "object"
                ? (row.metadata as Record<string, string>)
                : {};
            const kind =
              meta.kind === "follow_up_reminder"
                ? `${meta.bucket ?? ""} due reminder`.trim()
                : "Manual";
            const recipient = meta.recipientEmail ?? row.lead.email ?? "—";

            return (
              <tr key={row.id} className="border-b border-[var(--ic-border)] last:border-0">
                <td className="px-2 py-2 text-muted whitespace-nowrap">
                  {format(new Date(row.occurredAt), "dd MMM yyyy HH:mm")}
                </td>
                <td className="px-2 py-2">
                  <Link href={`/leads/${row.lead.id}`} className="font-medium text-primary">
                    {row.lead.fullName}
                  </Link>
                </td>
                <td className="px-2 py-2 max-w-xs">
                  <p className="truncate font-medium">{row.subject ?? "—"}</p>
                  {row.bodyPreview ? (
                    <p className="truncate text-2xs text-subtle">{row.bodyPreview}</p>
                  ) : null}
                </td>
                <td className="px-2 py-2">
                  <Badge tone={meta.kind === "follow_up_reminder" ? "primary" : "neutral"}>
                    {kind}
                  </Badge>
                </td>
                <td className="px-2 py-2 text-muted">{recipient}</td>
                <td className="px-2 py-2 text-muted">
                  {row.user?.name ?? row.user?.email ?? "System"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
