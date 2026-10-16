"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  ChevronDown,
  FileText,
  History,
  Mail,
  MessageSquare,
  PhoneOff,
  RefreshCw,
  Share2,
  Smartphone,
  UserRound,
  Users,
  X,
} from "lucide-react";
import { format } from "date-fns";
import {
  PrivateAccessBadge,
  SectionPageHeader,
} from "@/components/layout/section-page-header";
import { UnderlineTabs } from "@/components/ui/underline-tabs";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/avatar";
import {
  RecordsTable,
  RecordsTableCell,
  RecordsTableRow,
} from "@/components/ui/records-table";
import { DialUpdateModal } from "@/features/leads/dial-update-modal";
import {
  formatShortDateTime,
  shortLeadId,
} from "@/features/leads/reengaged-format";

type DetailLead = {
  id: string;
  firstName: string | null;
  lastName: string | null;
  fullName: string;
  email: string | null;
  phone: string | null;
  alternatePhone: string | null;
  address: string | null;
  company: string | null;
  jobTitle: string | null;
  city: string | null;
  state: string | null;
  status: string;
  priority: string;
  stageId: string | null;
  nextFollowUpAt: string | null;
  description: string | null;
  reEngagedAt: string | null;
  source: { name: string } | null;
  stage: { name: string } | null;
  assignedUser: { name: string | null; email: string } | null;
  notes: {
    id: string;
    content: string;
    createdAt: string;
    author: { name: string | null; email: string };
  }[];
  activities: {
    id: string;
    type: string;
    message: string;
    createdAt: string;
    actor: { name: string | null; email: string } | null;
  }[];
};

const DETAIL_TABS = [
  { id: "notes", label: "Notes&Call Records" },
  { id: "history", label: "History" },
  { id: "visits", label: "Site Visits" },
  { id: "quotations", label: "Quotations" },
  { id: "booking", label: "Booking History" },
  { id: "applicants", label: "Applicants" },
  { id: "transactions", label: "Transactions" },
  { id: "referrals", label: "Referrals" },
  { id: "contacts", label: "Contacts" },
  { id: "eoi", label: "EOI" },
  { id: "documents", label: "Documents" },
];

export function ReEngagedDetailView({
  lead,
  stages,
  lastUpdated,
}: {
  lead: DetailLead;
  stages: { id: string; name: string }[];
  lastUpdated: string;
}) {
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
    if (lines.length === 0) {
      lines.push("No activity summary yet. Use Update to log preferences and notes.");
    }
    return lines;
  }, [lead]);

  const subtitle =
    [lead.company || "Did not Disclose", lead.jobTitle || "Did not Disclose"].join(
      " - ",
    );

  return (
    <div>
      <SectionPageHeader
        subtitle="Manage and track your student records."
        title="Re-engaged"
        badge={<PrivateAccessBadge />}
        actions={
          <Button variant="default" size="sm" className="rounded-lg px-4">
            ACADEMIC
            <ChevronDown className="h-3.5 w-3.5" />
          </Button>
        }
        meta={`Last Update ${lastUpdated}`}
      />

      <div className="ic-card p-5 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">
            Overview{shortLeadId(lead.id)}
          </h2>
          <Link
            href="/leads/re-engaged"
            className="text-xs text-muted hover:text-foreground"
          >
            ← Back to list
          </Link>
        </div>

        <div className="mb-4 flex flex-wrap items-start gap-4">
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
          <ActionChip
            icon={RefreshCw}
            label="Update"
            active
            onClick={() => setUpdateOpen(true)}
          />
          <ActionChip icon={FileText} label="Notes" onClick={() => setTab("notes")} />
          <ActionChip icon={Share2} label="Share" />
          <ActionChip icon={Mail} label="Email" />
          <ActionChip icon={Smartphone} label="SMS" />
          <ActionChip icon={MessageSquare} label="EOI" />
          <ActionChip icon={Users} label="Referral" />
          <ActionChip icon={UserRound} label="Contacts" onClick={() => setTab("contacts")} />
          <ActionChip icon={PhoneOff} label="Do not Call" />
          <ActionChip icon={X} label="Close" href="/leads/re-engaged" />
        </div>

        <UnderlineTabs tabs={DETAIL_TABS} value={tab} onChange={setTab} />

        <div className="mt-4">
          {tab === "notes" ? (
            <NotesTable notes={lead.notes} />
          ) : tab === "history" ? (
            <HistoryTable activities={lead.activities} />
          ) : (
            <div className="rounded-xl border border-dashed border-[var(--ic-border)] px-4 py-12 text-center text-sm text-muted">
              <History className="mx-auto mb-2 h-5 w-5" />
              {DETAIL_TABS.find((t) => t.id === tab)?.label} is not configured for
              this organization yet.
            </div>
          )}
        </div>
      </div>

      <DialUpdateModal
        open={updateOpen}
        onOpenChange={setUpdateOpen}
        lead={lead}
        stages={stages}
      />
    </div>
  );
}

function ActionChip({
  icon: Icon,
  label,
  active,
  onClick,
  href,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active?: boolean;
  onClick?: () => void;
  href?: string;
}) {
  const className = `inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition ${
    active
      ? "border-primary text-primary"
      : "border-[var(--ic-border)] text-muted hover:text-foreground"
  }`;

  if (href) {
    return (
      <Link href={href} className={className}>
        <Icon className="h-3.5 w-3.5" />
        {label}
      </Link>
    );
  }

  return (
    <button type="button" className={className} onClick={onClick}>
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

function NotesTable({
  notes,
}: {
  notes: DetailLead["notes"];
}) {
  return (
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
      {notes.map((note, index) => (
        <RecordsTableRow key={note.id}>
          <RecordsTableCell className="text-muted">{index + 1}</RecordsTableCell>
          <RecordsTableCell>
            {formatShortDateTime(note.createdAt)}
          </RecordsTableCell>
          <RecordsTableCell>—</RecordsTableCell>
          <RecordsTableCell className="max-w-md">
            {note.content}
          </RecordsTableCell>
          <RecordsTableCell>
            {note.author.name ?? note.author.email}
          </RecordsTableCell>
          <RecordsTableCell>—</RecordsTableCell>
        </RecordsTableRow>
      ))}
    </RecordsTable>
  );
}

function HistoryTable({
  activities,
}: {
  activities: DetailLead["activities"];
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
