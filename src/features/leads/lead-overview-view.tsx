"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import {
  Ban,
  FileText,
  Mail,
  MessageSquare,
  Phone,
  RefreshCw,
  Share2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import {
  PrivateAccessBadge,
  SectionPageHeader,
} from "@/components/layout/section-page-header";
import { ReEngagedPageMeta } from "@/components/leads/reengaged-chrome";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { Avatar } from "@/components/ui/avatar";
import {
  RecordsTable,
  RecordsTableCell,
  RecordsTableRow,
} from "@/components/ui/records-table";
import {
  DialUpdateCustomerModal,
  type DialUpdateLead,
} from "@/features/leads/dial-update-customer-modal";
import { CallRecordingPlayer } from "@/features/leads/call-recording-player";
import {
  formatShortDateTime,
  shortLeadId,
} from "@/features/leads/reengaged-format";
import { cn } from "@/lib/utils";

const PAGE_SUBTITLE = "Manage and track your student records";

const OVERVIEW_TABS = [
  { id: "notes", label: "Notes & Call Records" },
  { id: "history", label: "History" },
];

export type LeadOverviewLead = DialUpdateLead & {
  fullName: string;
  company: string | null;
  jobTitle: string | null;
  description: string | null;
  reEngagedAt: string | null;
  source: { name: string } | null;
  stage: { name: string } | null;
  assignedUser: { name: string | null; email: string } | null;
  activities: {
    id: string;
    type: string;
    message: string;
    createdAt: string;
    actor: { name: string | null; email: string } | null;
  }[];
};

export function LeadOverviewView({
  lead,
  stages,
  customFields,
  lastUpdated,
  backHref = "/leads/re-engaged",
  canEdit = true,
}: {
  lead: LeadOverviewLead;
  stages: { id: string; name: string }[];
  customFields: {
    id: string;
    key: string;
    label: string;
    type: string;
    section: string;
    options: unknown;
  }[];
  lastUpdated: string;
  backHref?: string;
  canEdit?: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState("notes");
  const [updateOpen, setUpdateOpen] = useState(false);

  const summaryLines = useMemo(() => {
    const lines: string[] = [];
    if (lead.description) lines.push(lead.description);
    if (lead.source?.name) {
      lines.push(
        `This lead received from activity: ${lead.source.name}${
          lead.reEngagedAt
            ? ` on ${format(new Date(lead.reEngagedAt), "dd-MM-yyyy")}`
            : ""
        }.`,
      );
    }
    if (lead.stage?.name) {
      lines.push(`Current stage: ${lead.stage.name}.`);
    }
    if (lead.assignedUser) {
      lines.push(
        `Assigned to ${lead.assignedUser.name ?? lead.assignedUser.email}.`,
      );
    }
    if (lines.length === 0) {
      lines.push(
        "No activity summary yet. Use Update to log preferences and notes.",
      );
    }
    return lines;
  }, [lead]);

  const subtitle = [
    lead.company || "Did not Disclose",
    lead.jobTitle || "Did not Disclose",
  ].join(" - ");

  const noteCallRows = useMemo(() => {
    const notes = lead.notes.map((note) => ({
      kind: "note" as const,
      id: note.id,
      at: note.createdAt,
      dialed: "—",
      description: note.content,
      agent: note.author.name ?? note.author.email,
      did: "—",
      recordingPath: null as string | null,
    }));
    const calls = lead.callRecords.map((call) => ({
      kind: "call" as const,
      id: call.id,
      at: call.calledAt,
      dialed: call.phoneNumber ?? "—",
      description:
        call.notes?.trim()
          ? `Reason : ${call.notes}`
          : [call.outcome, call.notes].filter(Boolean).join(" — ") ||
            "Call logged",
      agent: call.user.name ?? call.user.email,
      did: call.didNumber ?? "—",
      recordingPath: call.recordingPath ?? null,
    }));
    return [...notes, ...calls].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    );
  }, [lead.notes, lead.callRecords]);

  return (
    <div>
      <SectionPageHeader
        subtitle={PAGE_SUBTITLE}
        title="Re-engaged"
        badge={<PrivateAccessBadge />}
        actions={<ReEngagedPageMeta lastUpdated={lastUpdated} />}
      />

      <div className="ic-card p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">
            Overview{shortLeadId(lead.id)}
          </h2>
          <Link
            href={backHref}
            className="text-xs text-muted hover:text-foreground"
          >
            ← Back to list
          </Link>
        </div>

        <div className="mb-4 flex flex-wrap items-start gap-4 border-b border-[var(--ic-border)] pb-4">
          <Avatar name={lead.fullName} size="lg" />
          <div>
            <p className="text-lg font-semibold">{lead.fullName}</p>
            <p className="text-sm text-muted">{subtitle}</p>
          </div>
        </div>

        <ul className="mb-5 list-disc space-y-2 pl-5 text-sm text-foreground/90">
          {summaryLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>

        <div className="mb-5 flex flex-wrap gap-2">
          {canEdit ? (
            <ActionChip
              icon={RefreshCw}
              label="Update"
              active
              onClick={() => setUpdateOpen(true)}
            />
          ) : null}
          <ActionChip
            icon={FileText}
            label="Notes"
            onClick={() => setTab("notes")}
          />
          <ActionChip icon={Share2} label="Share" disabled />
          <ActionChip icon={Mail} label="Email" disabled />
          <ActionChip icon={MessageSquare} label="SMS" disabled />
          <ActionChip icon={UserPlus} label="EOI" disabled />
          <ActionChip icon={Users} label="Referral" disabled />
          <ActionChip icon={Users} label="Contacts" disabled />
          <ActionChip icon={Ban} label="Do not Call" disabled />
          {lead.phone ? (
            <ActionChip
              icon={Phone}
              label="Call"
              href={`tel:${lead.phone}`}
            />
          ) : null}
          <ActionChip
            icon={X}
            label="Close"
            onClick={() => router.push(backHref)}
          />
        </div>

        <UnderlineTabs
          tabs={OVERVIEW_TABS}
          value={tab}
          onChange={setTab}
          activeColor={tab === "history" ? "foreground" : "primary"}
        />

        <div className="mt-4">
          {tab === "notes" ? (
            <RecordsTable
              columns={[
                { key: "#", label: "#" },
                { key: "date", label: "Date" },
                { key: "dialed", label: "Dialed No" },
                { key: "desc", label: "Description" },
                { key: "agent", label: "Agent Name" },
                { key: "did", label: "DID" },
              ]}
              empty="No notes or call records yet."
            >
              {noteCallRows.map((row, index) => (
                <RecordsTableRow key={`${row.kind}-${row.id}`}>
                  <RecordsTableCell className="text-muted">
                    {index + 1}
                  </RecordsTableCell>
                  <RecordsTableCell>
                    {formatShortDateTime(row.at)}
                  </RecordsTableCell>
                  <RecordsTableCell>{row.dialed}</RecordsTableCell>
                  <RecordsTableCell className="max-w-md">
                    <div className="text-sm">{row.description}</div>
                    {row.kind === "call" && row.recordingPath ? (
                      <CallRecordingPlayer
                        leadId={lead.id}
                        callRecordId={row.id}
                      />
                    ) : null}
                  </RecordsTableCell>
                  <RecordsTableCell>{row.agent}</RecordsTableCell>
                  <RecordsTableCell>{row.did}</RecordsTableCell>
                </RecordsTableRow>
              ))}
            </RecordsTable>
          ) : (
            <HistoryTable activities={lead.activities} />
          )}
        </div>
      </div>

      <DialUpdateCustomerModal
        open={updateOpen}
        onOpenChange={setUpdateOpen}
        lead={lead}
        stages={stages}
        customFields={customFields}
        canEdit={canEdit}
      />
    </div>
  );
}

function ActionChip({
  icon: Icon,
  label,
  active,
  disabled,
  onClick,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  href?: string;
}) {
  const className = cn(
    "ic-action-chip",
    active && "ic-action-chip--active",
    disabled && "ic-action-chip--disabled",
  );

  if (href) {
    return (
      <a href={href} className={className}>
        <Icon className="h-3.5 w-3.5" />
        {label}
      </a>
    );
  }

  return (
    <button
      type="button"
      className={className}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function HistoryTable({
  activities,
}: {
  activities: LeadOverviewLead["activities"];
}) {
  return (
    <RecordsTable
      columns={[
        { key: "#", label: "#" },
        { key: "date", label: "Date" },
        { key: "desc", label: "Description" },
        { key: "agent", label: "Agent Name" },
      ]}
      empty="No history yet."
    >
      {activities.map((item, index) => (
        <RecordsTableRow key={item.id}>
          <RecordsTableCell className="text-muted">{index + 1}</RecordsTableCell>
          <RecordsTableCell>
            {formatShortDateTime(item.createdAt)}
          </RecordsTableCell>
          <RecordsTableCell className="max-w-xl">{item.message}</RecordsTableCell>
          <RecordsTableCell>
            {item.actor?.name ?? item.actor?.email ?? "System"}
          </RecordsTableCell>
        </RecordsTableRow>
      ))}
    </RecordsTable>
  );
}
