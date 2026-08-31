"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Filter, Phone, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  PrivateAccessBadge,
  SectionPageHeader,
} from "@/components/layout/section-page-header";
import {
  LeadTransferToolbar,
  ReEngagedPageMeta,
} from "@/components/leads/reengaged-chrome";
import {
  RecordsTable,
  RecordsTableCell,
  RecordsTableRow,
} from "@/components/ui/records-table";
import { leadStatusLabel } from "@/components/ui/status-chip";
import {
  dueCallLabel,
  formatLeadDate,
  formatLeadDateTime,
  shortLeadId,
} from "@/features/leads/reengaged-format";
import { cn } from "@/lib/utils";

export type ReEngagedListRow = {
  id: string;
  fullName: string;
  status: string;
  createdAt: string;
  reEngagedAt: string | null;
  nextFollowUpAt: string | null;
  phone: string | null;
  source: { name: string } | null;
  followUps: { dueAt: string }[];
};

const PAGE_SUBTITLE = "Manage and track your student records";

export function ReEngagedListView({
  rows,
  total,
  q,
  lastUpdated,
}: {
  rows: ReEngagedListRow[];
  total: number;
  q?: string;
  lastUpdated: string;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pending, startTransition] = useTransition();
  const allSelected = rows.length > 0 && selected.size === rows.length;

  const columns = useMemo(
    () => [
      { key: "#", label: "#" },
      { key: "check", label: "" },
      { key: "call", label: "" },
      { key: "id", label: "Lead ID" },
      { key: "name", label: "Student Name" },
      { key: "source", label: "Source Name" },
      { key: "leadDate", label: "Lead Date" },
      { key: "reengaged", label: "Re-engaged Date" },
      { key: "due", label: "Due Call" },
      { key: "status", label: "Status" },
    ],
    [],
  );

  function toggleAll(checked: boolean) {
    setSelected(checked ? new Set(rows.map((r) => r.id)) : new Set());
  }

  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  function handleTransfer() {
    if (selected.size === 0) {
      toast.message("Select at least one lead to transfer");
      return;
    }
    toast.message("Bulk transfer is not configured yet");
  }

  return (
    <div>
      <SectionPageHeader
        subtitle={PAGE_SUBTITLE}
        title="Re-engaged"
        badge={<PrivateAccessBadge />}
        actions={<ReEngagedPageMeta lastUpdated={lastUpdated} />}
      />

      <div className="ic-card p-4 sm:p-5">
        <div className="mb-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <form
            className="flex flex-wrap items-center gap-2"
            action="/leads/re-engaged"
          >
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" />
              <Input
                name="q"
                defaultValue={q}
                placeholder="Search"
                className="h-9 w-44 rounded-lg border-[var(--ic-border)] bg-[var(--ic-surface-muted)] pl-9"
              />
            </div>
            <button type="submit" className="ic-toolbar-btn ic-toolbar-btn--filter">
              <Filter className="h-3.5 w-3.5" />
              Filter
            </button>
            <button type="submit" className="ic-toolbar-btn">
              Find
            </button>
            <button
              type="button"
              className="ic-toolbar-btn"
              disabled={pending}
              onClick={() => startTransition(() => router.refresh())}
            >
              <RefreshCw
                className={cn("h-3.5 w-3.5", pending && "animate-spin")}
              />
              Refresh
            </button>
          </form>

          <LeadTransferToolbar
            disabled={selected.size === 0}
            onTransfer={handleTransfer}
          />
        </div>

        <RecordsTable
          columns={columns}
          empty={
            total === 0
              ? "No re-engaged leads yet. Update a lead from Dial & Update to mark it re-engaged."
              : "No matching leads."
          }
        >
          {rows.map((row, index) => {
            const due =
              row.followUps[0]?.dueAt ?? row.nextFollowUpAt ?? null;
            return (
              <RecordsTableRow
                key={row.id}
                onClick={() => router.push(`/leads/${row.id}`)}
              >
                <RecordsTableCell className="w-10 text-muted">
                  {index + 1}
                </RecordsTableCell>
                <RecordsTableCell className="w-10">
                  <span
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => e.stopPropagation()}
                  >
                    <Checkbox
                      checked={selected.has(row.id)}
                      onCheckedChange={(v) => toggleOne(row.id, v === true)}
                      aria-label={`Select ${row.fullName}`}
                    />
                  </span>
                </RecordsTableCell>
                <RecordsTableCell className="w-10">
                  <a
                    href={row.phone ? `tel:${row.phone}` : undefined}
                    onClick={(e) => e.stopPropagation()}
                    className="ic-phone-call-btn"
                    aria-label="Call"
                  >
                    <Phone className="h-4 w-4" />
                  </a>
                </RecordsTableCell>
                <RecordsTableCell className="font-medium text-muted">
                  {shortLeadId(row.id)}
                </RecordsTableCell>
                <RecordsTableCell className="font-medium">
                  {row.fullName}
                </RecordsTableCell>
                <RecordsTableCell>{row.source?.name ?? "—"}</RecordsTableCell>
                <RecordsTableCell>
                  {formatLeadDate(row.createdAt)}
                </RecordsTableCell>
                <RecordsTableCell className="ic-reengaged-date">
                  {formatLeadDateTime(row.reEngagedAt)}
                </RecordsTableCell>
                <RecordsTableCell className="text-muted">
                  {dueCallLabel(due)}
                </RecordsTableCell>
                <RecordsTableCell>
                  {leadStatusLabel(row.status)}
                </RecordsTableCell>
              </RecordsTableRow>
            );
          })}
        </RecordsTable>

        {rows.length > 0 ? (
          <div className="mt-3 flex items-center justify-between text-xs text-muted">
            <label className="inline-flex items-center gap-2">
              <Checkbox
                checked={allSelected}
                onCheckedChange={(v) => toggleAll(v === true)}
              />
              Select all on page ({selected.size}/{rows.length})
            </label>
            <span>{total} total re-engaged leads</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
