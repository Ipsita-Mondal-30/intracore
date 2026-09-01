"use client";

import { Avatar } from "@/components/ui/avatar";
import { formatLeadDisplayId, formatLeadListDate } from "@/lib/leads/display-formatters";

export function LeadOverviewPanel({
  leadId,
  fullName,
  stageName,
  status,
  sourceName,
  reengagedAt,
  activities,
}: {
  leadId: string;
  fullName: string;
  stageName?: string | null;
  status: string;
  sourceName?: string | null;
  reengagedAt?: string | null;
  activities: { message: string; createdAt: string }[];
}) {
  const subtitle = [stageName, status.replace(/_/g, " ")].filter(Boolean).join(" - ");

  const bullets: string[] = [];
  if (reengagedAt) {
    bullets.push(`Re-engaged on ${formatLeadListDate(reengagedAt)}.`);
  }
  if (sourceName) {
    bullets.push(`This lead received from source: ${sourceName}.`);
  }
  for (const item of activities.slice(0, 2)) {
    bullets.push(item.message);
  }
  if (bullets.length === 0) {
    bullets.push("No recent activity recorded for this lead.");
  }

  return (
    <section className="rounded-2xl border border-[var(--ic-border)] bg-white p-5 shadow-sm">
      <div className="flex items-start gap-4">
        <Avatar name={fullName} size="lg" />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold">{fullName}</h2>
          <p className="text-sm text-muted">{subtitle || "—"}</p>
          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-muted">
            {bullets.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
        <p className="text-xs font-medium text-subtle">{formatLeadDisplayId(leadId)}</p>
      </div>
    </section>
  );
}
