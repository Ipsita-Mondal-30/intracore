"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { Filter, LayoutGrid, Phone, Plus, RefreshCw, Search, Table2, Upload } from "lucide-react";
import { LeadChatButton } from "@/features/chat/lead-chat-button";
import { toast } from "sonner";
import { bulkLeadAction, changeLeadStageAction } from "@/features/leads/actions";
import { bulkTransferAction } from "@/features/leads/transfer-actions";
import { ExportLeadsButton } from "@/features/leads/export-button";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/layout/data-table";
import { KpiCard } from "@/components/layout/kpi-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Avatar } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { LOST_REASONS } from "@/lib/leads/lost-reasons";
import {
  DEFAULT_LIST_COLUMNS,
  CRM_LIST_COLUMNS,
  formatDueCallLabel,
  type ListColumnKey,
} from "@/lib/leads/view-filters";
import {
  formatLeadDisplayId,
  formatLeadListDate,
  formatLeadListDateTime,
  formatLeadStatusLabel,
} from "@/lib/leads/display-formatters";

export type LeadListRow = {
  id: string;
  fullName: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  status: string;
  priority: string;
  leadScore: number;
  nextFollowUpAt: Date | null;
  callbackAt: Date | null;
  reEngagedAt: Date | null;
  createdAt: Date;
  source: { name: string } | null;
  stage: { id: string; name: string } | null;
  assignedUser: { id: string; name: string | null; email: string } | null;
  flags: { key: string; label: string; color?: string | null }[];
};

const COLUMN_LABELS: Record<string, string> = {
  leadId: "Lead ID",
  name: "Student Name",
  company: "Company",
  contact: "Contact",
  source: "Source Name",
  leadDate: "Lead Date",
  reengagedDate: "Re-engaged Date",
  dueCall: "Due Call",
  stage: "Stage",
  status: "Status",
  priority: "Priority",
  assigned: "Assigned",
  score: "Score",
  nextFollowUp: "Next follow-up",
  flags: "Flags",
};

const CELL_CLASS = "px-2 py-1.5 text-sm";

function toneForStatus(status: string) {
  if (status === "CONVERTED" || status === "QUALIFIED") return "success" as const;
  if (status === "LOST" || status === "UNQUALIFIED") return "danger" as const;
  if (status === "NEW") return "primary" as const;
  return "neutral" as const;
}


function renderLeadColumn(
  key: ListColumnKey,
  lead: LeadListRow,
  timezone: string,
  canChat?: boolean,
  showReengagedHighlight?: boolean,
) {
  switch (key) {
    case "leadId":
      return (
        <Link href={`/leads/${lead.id}`} className="font-medium text-primary hover:underline">
          {formatLeadDisplayId(lead.id)}
        </Link>
      );
    case "name":
      return (
        <div className="flex items-center gap-2">
          <span>{lead.fullName}</span>
          {canChat ? <LeadChatButton leadId={lead.id} /> : null}
        </div>
      );
    case "company":
      return <span className="text-muted">{lead.company ?? "—"}</span>;
    case "contact":
      return (
        <>
          {lead.email ? <div>{lead.email}</div> : null}
          {lead.phone ? <div className="text-2xs text-subtle">{lead.phone}</div> : null}
          {!lead.email && !lead.phone ? "—" : null}
        </>
      );
    case "source":
      return lead.source?.name ?? "—";
    case "leadDate":
      return (
        <span className="text-muted">
          {lead.createdAt ? formatLeadListDate(lead.createdAt) : "—"}
        </span>
      );
    case "reengagedDate":
      return (
        <span className={showReengagedHighlight ? "font-medium text-danger" : "text-muted"}>
          {lead.reEngagedAt ? formatLeadListDateTime(lead.reEngagedAt) : "—"}
        </span>
      );
    case "dueCall": {
      const label = formatDueCallLabel(lead.nextFollowUpAt, lead.callbackAt, timezone);
      return label ? <span>{label}</span> : "—";
    }
    case "stage":
      return lead.stage?.name ?? "—";
    case "status":
      return formatLeadStatusLabel(lead.status, lead.stage?.name);
    case "priority":
      return <Badge tone="neutral">{lead.priority}</Badge>;
    case "assigned":
      return lead.assignedUser ? (
        <span className="inline-flex items-center gap-1.5">
          <Avatar name={lead.assignedUser.name} size="sm" />
          <span>{lead.assignedUser.name ?? lead.assignedUser.email}</span>
        </span>
      ) : (
        "—"
      );
    case "score":
      return lead.leadScore;
    case "nextFollowUp":
      return (
        <span className="text-muted">
          {lead.nextFollowUpAt
            ? format(new Date(lead.nextFollowUpAt), "dd MMM yyyy")
            : "—"}
        </span>
      );
    case "flags":
      return lead.flags.length ? (
        <span className="flex flex-wrap gap-1">
          {lead.flags.map((flag) => (
            <Badge key={flag.key} tone="neutral">
              {flag.label}
            </Badge>
          ))}
        </span>
      ) : (
        "—"
      );
    default:
      return "—";
  }
}

export function LeadsWorkspace({
  rows,
  total,
  page,
  pageSize,
  params,
  lookups,
  stats,
  canCreate,
  canExport,
  canImport,
  canEdit,
  canAssign,
  canTransfer,
  canStage,
  canDelete,
  canChat,
  title = "Leads",
  breadcrumbs = ["Overview", "Leads"],
  listTitle = "All leads",
  basePath = "/leads",
  lockedStatus,
  lockedInterested,
  columns,
  timezone = "UTC",
  crmLayout = false,
}: {
  rows: LeadListRow[];
  total: number;
  page: number;
  pageSize: number;
  params: Record<string, string>;
  lookups: {
    sources: { id: string; name: string }[];
    stages: { id: string; name: string }[];
    members: { user: { id: string; name: string | null; email: string } }[];
  };
  stats: { total: number; newLeads: number; converted: number; followUpsDue: number };
  canCreate: boolean;
  canExport: boolean;
  canImport: boolean;
  canEdit: boolean;
  canAssign: boolean;
  canTransfer: boolean;
  canStage: boolean;
  canDelete: boolean;
  canChat?: boolean;
  title?: string;
  breadcrumbs?: string[];
  listTitle?: string;
  basePath?: string;
  lockedStatus?: string;
  lockedInterested?: boolean;
  columns?: string[];
  timezone?: string;
  crmLayout?: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string[]>([]);
  const [transferToUserId, setTransferToUserId] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const view = params.view === "kanban" ? "kanban" : "table";
  const q = params.q ?? "";
  const activeColumns = columns ?? (crmLayout ? [...CRM_LIST_COLUMNS] : [...DEFAULT_LIST_COLUMNS]);
  const showReengagedHighlight = activeColumns.includes("reengagedDate");

  const queryString = useMemo(() => {
    const sp = new URLSearchParams(params);
    return sp.toString();
  }, [params]);

  function toggleAll(checked: boolean) {
    setSelected(checked ? rows.map((r) => r.id) : []);
  }

  function toggleOne(id: string, checked: boolean) {
    setSelected((prev) =>
      checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id),
    );
  }

  async function runBulk(op: string, extra: Record<string, string> = {}) {
    const fd = new FormData();
    fd.set("op", op);
    fd.set("leadIds", selected.join(","));
    for (const [k, v] of Object.entries(extra)) fd.set(k, v);
    const result = await bulkLeadAction(fd);
    if (result.ok) {
      toast.success(result.message ?? "Updated");
      setSelected([]);
      router.refresh();
    } else {
      toast.error(result.error);
    }
  }

  async function runTransfer() {
    if (!transferToUserId) return;
    const fd = new FormData();
    fd.set("toUserId", transferToUserId);
    fd.set("leadIds", selected.join(","));
    const result = await bulkTransferAction(fd);
    if (result.ok) {
      toast.success(result.message ?? "Leads transferred");
      setSelected([]);
      setTransferToUserId("");
      router.refresh();
    } else {
      toast.error(result.error);
    }
  }

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const hrefFor = (next: Record<string, string>) => {
    const sp = new URLSearchParams({ ...params, ...next });
    if (lockedStatus) sp.set("status", lockedStatus);
    if (lockedInterested) sp.set("interested", "true");
    return `${basePath}?${sp.toString()}`;
  };

  return (
    <div>
      <PageHeader
        breadcrumbs={breadcrumbs}
        title={title}
        subtitle={format(new Date(), "dd MMM yyyy")}
        actions={
          <>
            {canImport ? (
              <Link href="/leads/import">
                <Button type="button" variant="secondary" size="sm">
                  <Upload className="h-3.5 w-3.5" />
                  Import
                </Button>
              </Link>
            ) : null}
            {canExport ? <ExportLeadsButton filters={params} /> : null}
            {canCreate ? (
              <Link href="/leads/new">
                <Button type="button" size="sm">
                  <Plus className="h-3.5 w-3.5" />
                  Add Lead
                </Button>
              </Link>
            ) : null}
          </>
        }
      />

      {!crmLayout ? (
        <section className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <KpiCard label="Total leads" value={stats.total} />
          <KpiCard label="New" value={stats.newLeads} highlighted />
          <KpiCard label="Converted" value={stats.converted} />
          <KpiCard label="Follow-ups due" value={stats.followUpsDue} />
        </section>
      ) : null}

      <Card>
        <CardHeader className="flex-col items-stretch gap-3">
          {crmLayout ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              <form className="flex flex-1 flex-wrap items-center gap-2" method="get" action={basePath}>
                <input type="hidden" name="view" value={view} />
                {lockedStatus ? <input type="hidden" name="status" value={lockedStatus} /> : null}
                {lockedInterested ? <input type="hidden" name="interested" value="true" /> : null}
                <div className="relative min-w-[180px] flex-1 max-w-xs">
                  <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-subtle" />
                  <Input
                    name="q"
                    defaultValue={q}
                    placeholder="Search"
                    className="h-10 pl-9"
                  />
                </div>
                <Button type="submit" variant="secondary" size="sm">
                  <Filter className="h-3.5 w-3.5" />
                  Filter
                </Button>
                <Button type="submit" variant="secondary" size="sm">
                  <Search className="h-3.5 w-3.5" />
                  Find
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => router.refresh()}
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Refresh
                </Button>
              </form>
              {canTransfer ? (
                <div className="flex items-center gap-2">
                  <Select
                    className="h-10 w-48"
                    value={transferToUserId}
                    onChange={(e) => setTransferToUserId(e.target.value)}
                  >
                    <option value="">Lead Transfer To…</option>
                    {lookups.members.map((m) => (
                      <option key={m.user.id} value={m.user.id}>
                        {m.user.name ?? m.user.email}
                      </option>
                    ))}
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!transferToUserId || selected.length === 0}
                    onClick={() => void runTransfer()}
                  >
                    Transfer
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>
              {view === "kanban" ? "Pipeline" : listTitle} ({total})
            </CardTitle>
            <div className="flex gap-1 rounded-pill bg-[var(--ic-surface-muted)] p-1">
              <Link href={hrefFor({ view: "table" })}>
                <Button type="button" size="sm" variant={view === "table" ? "dark" : "ghost"}>
                  <Table2 className="h-3.5 w-3.5" />
                  Table
                </Button>
              </Link>
              <Link href={hrefFor({ view: "kanban" })}>
                <Button type="button" size="sm" variant={view === "kanban" ? "dark" : "ghost"}>
                  <LayoutGrid className="h-3.5 w-3.5" />
                  Kanban
                </Button>
              </Link>
            </div>
          </div>
          <form className="grid gap-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-12" method="get" action={basePath}>
            <input type="hidden" name="view" value={view} />
            {lockedStatus ? <input type="hidden" name="status" value={lockedStatus} /> : null}
            {lockedInterested ? <input type="hidden" name="interested" value="true" /> : null}
            <Input name="q" defaultValue={q} placeholder="Search leads…" className="xl:col-span-2" />
            {lockedStatus ? (
              <Select name="status" defaultValue={lockedStatus} disabled className="opacity-70">
                <option value={lockedStatus}>{lockedStatus}</option>
              </Select>
            ) : (
              <Select name="status" defaultValue={params.status ?? ""}>
                <option value="">All statuses</option>
                {["NEW", "OPEN", "IN_PROGRESS", "QUALIFIED", "CONVERTED", "LOST"].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </Select>
            )}
            <Select name="sourceId" defaultValue={params.sourceId ?? ""}>
              <option value="">All sources</option>
              {lookups.sources.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Select name="stageId" defaultValue={params.stageId ?? ""}>
              <option value="">All stages</option>
              {lookups.stages.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Select name="priority" defaultValue={params.priority ?? ""}>
              <option value="">All priorities</option>
              {["LOW", "MEDIUM", "HIGH", "URGENT"].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
            <Select name="assignedUserId" defaultValue={params.assignedUserId ?? ""}>
              <option value="">All assignees</option>
              {lookups.members.map((m) => (
                <option key={m.user.id} value={m.user.id}>
                  {m.user.name ?? m.user.email}
                </option>
              ))}
            </Select>
            <Input
              type="date"
              name="from"
              defaultValue={params.from ?? ""}
              aria-label="From date"
              className="h-10"
            />
            <Input
              type="date"
              name="to"
              defaultValue={params.to ?? ""}
              aria-label="To date"
              className="h-10"
            />
            <Select name="sort" defaultValue={params.sort ?? "createdAt"}>
              <option value="createdAt">Newest / oldest</option>
              <option value="fullName">Name</option>
              <option value="leadScore">Score</option>
              <option value="nextFollowUpAt">Follow-up</option>
            </Select>
            <Select name="dir" defaultValue={params.dir ?? "desc"}>
              <option value="desc">Desc</option>
              <option value="asc">Asc</option>
            </Select>
            <Button type="submit" variant="secondary" size="sm">
              <Filter className="h-3.5 w-3.5" />
              Filter
            </Button>
          </form>
            </>
          )}
        </CardHeader>
        <CardContent>
          {selected.length > 0 ? (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-xl bg-[var(--ic-surface-muted)] p-3">
              <span className="text-sm font-medium">{selected.length} selected</span>
              {canAssign ? (
                <Select
                  className="h-8 w-40"
                  defaultValue=""
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value) void runBulk("assign", { assignedUserId: value });
                  }}
                >
                  <option value="">Assign…</option>
                  {lookups.members.map((m) => (
                    <option key={m.user.id} value={m.user.id}>
                      {m.user.name ?? m.user.email}
                    </option>
                  ))}
                </Select>
              ) : null}
              {canTransfer ? (
                <>
                  <Select
                    className="h-8 w-44"
                    value={transferToUserId}
                    onChange={(e) => setTransferToUserId(e.target.value)}
                  >
                    <option value="">Lead Transfer To…</option>
                    {lookups.members.map((m) => (
                      <option key={m.user.id} value={m.user.id}>
                        {m.user.name ?? m.user.email}
                      </option>
                    ))}
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={!transferToUserId}
                    onClick={() => void runTransfer()}
                  >
                    Transfer
                  </Button>
                </>
              ) : null}
              {canStage ? (
                <Select
                  className="h-8 w-40"
                  defaultValue=""
                  onChange={(e) => {
                    const value = e.target.value;
                    if (value) void runBulk("stage", { stageId: value });
                  }}
                >
                  <option value="">Stage…</option>
                  {lookups.stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              ) : null}
              {canEdit ? (
                <>
                  <Select
                    className="h-8 w-36"
                    defaultValue=""
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value) void runBulk("priority", { priority: value });
                    }}
                  >
                    <option value="">Priority…</option>
                    {["LOW", "MEDIUM", "HIGH", "URGENT"].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                  <Select
                    className="h-8 w-40"
                    defaultValue=""
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value === "LOST") return;
                      if (value) void runBulk("status", { status: value });
                    }}
                  >
                    <option value="">Status…</option>
                    {["NEW", "OPEN", "IN_PROGRESS", "QUALIFIED"].map((s) => (
                      <option key={s} value={s}>
                        {s}
                      </option>
                    ))}
                  </Select>
                  <Select
                    className="h-8 w-44"
                    defaultValue=""
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value) void runBulk("status", { status: "LOST", lostReason: value });
                    }}
                  >
                    <option value="">Mark lost…</option>
                    {LOST_REASONS.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </Select>
                  <Input
                    className="h-8 w-40"
                    placeholder="Add tag"
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        const value = e.currentTarget.value.trim();
                        if (value) void runBulk("tag", { tags: value });
                      }
                    }}
                  />
                </>
              ) : null}
              {canDelete ? (
                <Button type="button" size="sm" variant="danger" onClick={() => setArchiveOpen(true)}>
                  Archive
                </Button>
              ) : null}
            </div>
          ) : null}

          {view === "kanban" ? (
            <KanbanBoard
              rows={rows}
              stages={lookups.stages}
              canStage={canStage}
              onMove={(leadId, stageId) => {
                startTransition(async () => {
                  const result = await changeLeadStageAction(leadId, stageId);
                  if (!result.ok) toast.error(result.error);
                  else router.refresh();
                });
              }}
            />
          ) : (
            <DataTable
              columns={[
                "#",
                "",
                "",
                ...activeColumns.map((key) => COLUMN_LABELS[key] ?? key),
              ]}
              empty="No leads match these filters. Create one or import a CSV."
              className="[&_th]:px-2 [&_th]:py-2 [&_th]:text-sm [&_td]:text-sm"
            >
              {rows.length
                ? rows.map((lead, index) => (
                    <tr key={lead.id} className="border-b border-[var(--ic-border)] last:border-0 odd:bg-surface even:bg-[var(--ic-surface-muted)]/30">
                      <td className={CELL_CLASS}>{(page - 1) * pageSize + index + 1}</td>
                      <td className={CELL_CLASS}>
                        <Checkbox
                          checked={selected.includes(lead.id)}
                          onCheckedChange={(v) => toggleOne(lead.id, v === true)}
                          aria-label={`Select ${lead.fullName}`}
                        />
                      </td>
                      <td className={CELL_CLASS}>
                        {lead.phone ? (
                          <Link
                            href={`/leads/${lead.id}?dial=1`}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-primary/30 bg-primary/5 text-primary hover:bg-primary/10"
                            aria-label={`Call ${lead.fullName}`}
                          >
                            <Phone className="h-3.5 w-3.5" />
                          </Link>
                        ) : (
                          <span className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-[var(--ic-border)] text-subtle">
                            <Phone className="h-3.5 w-3.5 opacity-40" />
                          </span>
                        )}
                      </td>
                      {activeColumns.map((key) => (
                        <td key={key} className={CELL_CLASS}>
                          {renderLeadColumn(key, lead, timezone, canChat, showReengagedHighlight)}
                        </td>
                      ))}
                    </tr>
                  ))
                : null}
            </DataTable>
          )}

          {view === "table" && rows.length > 0 ? (
            <div className="mt-3 flex items-center justify-between text-2xs text-subtle">
              <label className="inline-flex items-center gap-2">
                <Checkbox
                  checked={selected.length === rows.length}
                  onCheckedChange={(v) => toggleAll(v === true)}
                />
                Select page
              </label>
              <div className="flex items-center gap-2">
                <span>
                  Page {page} of {pages}
                </span>
                {page > 1 ? (
                  <Link className="text-primary" href={hrefFor({ page: String(page - 1) })}>
                    Previous
                  </Link>
                ) : null}
                {page < pages ? (
                  <Link className="text-primary" href={hrefFor({ page: String(page + 1) })}>
                    Next
                  </Link>
                ) : null}
              </div>
            </div>
          ) : null}
          {pending ? <p className="mt-2 text-2xs text-subtle">Saving…</p> : null}
        </CardContent>
      </Card>

      <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <DialogContent>
          <DialogTitle>Archive selected leads?</DialogTitle>
          <DialogDescription>
            {selected.length} lead(s) will be archived and hidden from the list.
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setArchiveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setArchiveOpen(false);
                void runBulk("archive");
              }}
            >
              Archive
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <span className="sr-only">{queryString}</span>
    </div>
  );
}

function KanbanBoard({
  rows,
  stages,
  canStage,
  onMove,
}: {
  rows: LeadListRow[];
  stages: { id: string; name: string }[];
  canStage: boolean;
  onMove: (leadId: string, stageId: string) => void;
}) {
  const columns = [{ id: "", name: "Unstaged" }, ...stages];
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {columns.map((stage) => {
        const items = rows.filter((r) => (r.stage?.id ?? "") === stage.id);
        return (
          <div
            key={stage.id || "none"}
            className="min-w-[240px] flex-1 rounded-xl bg-[var(--ic-surface-muted)] p-2"
            onDragOver={(e) => {
              if (canStage) e.preventDefault();
            }}
            onDrop={(e) => {
              const leadId = e.dataTransfer.getData("text/lead-id");
              if (leadId && stage.id && canStage) onMove(leadId, stage.id);
            }}
          >
            <p className="mb-2 px-1 text-xs font-semibold text-muted">
              {stage.name} ({items.length})
            </p>
            <div className="space-y-2">
              {items.map((lead) => (
                <Link
                  key={lead.id}
                  href={`/leads/${lead.id}`}
                  draggable={canStage}
                  onDragStart={(e) => e.dataTransfer.setData("text/lead-id", lead.id)}
                  className="block rounded-xl bg-surface p-3 text-sm shadow-sm"
                >
                  <p className="font-medium">{lead.fullName}</p>
                  <p className="text-2xs text-subtle">{lead.company ?? lead.email ?? "—"}</p>
                  <Badge tone={toneForStatus(lead.status)} className="mt-2">
                    {lead.status}
                  </Badge>
                </Link>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
