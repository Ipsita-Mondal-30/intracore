"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { changeLeadStatusAction } from "@/features/leads/actions";
import { reengageLeadAction } from "@/features/leads/call-actions";
import { sendLeadEmailAction } from "@/features/leads/email-actions";
import { transferLeadAction } from "@/features/leads/transfer-actions";
import { LeadStatus } from "@prisma/client";
import { LOST_REASONS } from "@/lib/leads/lost-reasons";
import { ModulePlaceholder } from "@/components/leads/module-placeholder";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Tabs } from "@/components/ui/tabs";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { LeadDialUpdateDialog } from "@/features/leads/lead-dial-update-dialog";
import { LeadChatDrawer } from "@/features/chat/lead-chat-drawer";
import { LeadOverviewPanel } from "@/features/leads/lead-overview-panel";
import { LeadActionToolbar } from "@/features/leads/lead-action-toolbar";
import { LeadNotesCallTable, type NotesCallRow } from "@/features/leads/lead-notes-call-table";
import { formatLeadDisplayId, formatLeadListDateTime } from "@/lib/leads/display-formatters";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type LeadDetail = {
  id: string;
  fullName: string;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
  alternatePhone: string | null;
  whatsappNumber: string | null;
  website: string | null;
  gstNo: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  postalCode: string | null;
  industry: string | null;
  status: string;
  priority: string;
  leadScore: number;
  expectedValue: string | number | null;
  description: string | null;
  stageId: string | null;
  pipelineId: string | null;
  sourceId: string | null;
  assignedUserId: string | null;
  lostReason: string | null;
  lostComment: string | null;
  convertedAt: string | null;
  reEngagedAt: string | null;
  callbackAt: string | null;
  nextFollowUpAt: string | null;
  source: { name: string } | null;
  product: { name: string } | null;
  stage: { name: string } | null;
  assignedUser: { name: string | null; email: string } | null;
  assignedTeam: { name: string } | null;
  tags: { tag: { name: string } }[];
  flags: { flag: { key: string; label: string; color: string | null } }[];
  customFieldValues: {
    fieldId: string;
    value: string | null;
    field: {
      id: string;
      key: string;
      label: string;
      type: string;
      section: string;
      options: unknown;
    };
  }[];
  notes: {
    id: string;
    content: string;
    createdAt: string;
    author: { name: string | null; email: string };
  }[];
  callRecords: {
    id: string;
    calledAt: string;
    durationSec: number | null;
    phoneNumber: string | null;
    outcome: string | null;
    notes: string | null;
    recordingPath: string | null;
    didNumber: string | null;
    callbackAt: string | null;
    user: { name: string | null; email: string };
  }[];
  communications: {
    id: string;
    subject: string | null;
    bodyPreview: string | null;
    occurredAt: string;
    metadata: unknown;
    user: { name: string | null; email: string } | null;
  }[];
  tasks: {
    id: string;
    title: string;
    status: string;
    dueDate: string | null;
  }[];
  followUps: {
    id: string;
    title: string;
    type: string;
    status: string;
    dueAt: string;
  }[];
  activities: {
    id: string;
    type: string;
    message: string;
    createdAt: string;
    previous: unknown;
    next: unknown;
    actor: { name: string | null; email: string } | null;
  }[];
  transfers: {
    id: string;
    reason: string | null;
    createdAt: string;
    fromUser: { name: string | null; email: string } | null;
    toUser: { name: string | null; email: string } | null;
  }[];
  reengagements: {
    id: string;
    reEngagedAt: string;
    reason: string | null;
    notes: string | null;
    createdBy: { name: string | null; email: string };
  }[];
};

export function LeadDetailView({
  lead,
  lookups,
  canEdit,
  canChat,
  organizationId,
  currentUserId,
  currentUserName,
  canSendChat,
  openDialOnMount,
}: {
  lead: LeadDetail;
  lookups: {
    stages: { id: string; name: string }[];
    members: { user: { id: string; name: string | null; email: string } }[];
    customFields?: {
      id: string;
      key: string;
      label: string;
      type: string;
      section: string;
      options: unknown;
    }[];
  };
  canEdit: boolean;
  canAssign: boolean;
  canStage: boolean;
  canConvert: boolean;
  canDelete: boolean;
  canChat?: boolean;
  organizationId?: string;
  currentUserId?: string;
  currentUserName?: string;
  canSendChat?: boolean;
  openDialOnMount?: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState("notes-calls");
  const [lostOpen, setLostOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [reengageOpen, setReengageOpen] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [dialOpen, setDialOpen] = useState(openDialOnMount ?? false);
  const [sendEmailOpen, setSendEmailOpen] = useState(false);
  const [emailSubject, setEmailSubject] = useState("");
  const [emailBody, setEmailBody] = useState("");
  const [emailPending, setEmailPending] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [lostReason, setLostReason] = useState(LOST_REASONS[0]);
  const [lostComment, setLostComment] = useState("");
  const [transferTo, setTransferTo] = useState(lookups.members[0]?.user.id ?? "");
  const [transferReason, setTransferReason] = useState("");

  const noteCallRows = useMemo<NotesCallRow[]>(() => {
    const notes: NotesCallRow[] = lead.notes.map((note) => ({
      id: note.id,
      kind: "note",
      at: note.createdAt,
      dialedNo: null,
      description: note.content,
      agentName: note.author.name ?? note.author.email,
      did: null,
    }));
    const calls: NotesCallRow[] = lead.callRecords.map((call) => ({
      id: call.id,
      kind: "call",
      at: call.calledAt,
      dialedNo: call.phoneNumber,
      description: call.notes
        ? `Reason : ${call.notes}`
        : call.outcome
          ? `Reason : ${call.outcome}`
          : "Call logged",
      agentName: call.user.name ?? call.user.email,
      did: call.didNumber,
      recordingPath: call.recordingPath,
      leadId: lead.id,
    }));
    return [...notes, ...calls].sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    );
  }, [lead.id, lead.notes, lead.callRecords]);

  const customFields = lookups.customFields ?? [];

  function handleToolbarAction(action: string) {
    if (action === "update") setDialOpen(true);
    else if (action === "notes") setTab("notes-calls");
    else if (action === "email") setSendEmailOpen(true);
    else if (action === "close") router.push("/leads");
  }

  return (
    <div>
      <h1 className="mb-4 text-xl font-semibold">
        Overview{formatLeadDisplayId(lead.id)}
      </h1>

      <div className="mb-4 space-y-4">
        <LeadOverviewPanel
          leadId={lead.id}
          fullName={lead.fullName}
          stageName={lead.stage?.name}
          status={lead.status}
          sourceName={lead.source?.name}
          reengagedAt={lead.reEngagedAt}
          activities={lead.activities.map((a) => ({
            message: a.message,
            createdAt: a.createdAt,
          }))}
        />

        <LeadActionToolbar active="update" onAction={handleToolbarAction} />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "notes-calls", label: "Notes&Call Records" },
          { id: "history", label: "History" },
          { id: "site-visits", label: "Site Visits" },
          { id: "quotations", label: "Quotations" },
          { id: "admission", label: "Admission History" },
          { id: "applicants", label: "Applicants" },
          { id: "transactions", label: "Transactions" },
          { id: "referrals", label: "Referrals" },
          { id: "contacts", label: "Contacts" },
          { id: "eoi", label: "EOI" },
          { id: "documents", label: "Documents" },
        ]}
      />

      <div className="mt-4 space-y-4">
        {tab === "notes-calls" ? (
          <Card>
            <CardContent className="space-y-4 pt-5">
              {canEdit ? (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => setDialOpen(true)}>
                    Update / Log Call
                  </Button>
                </div>
              ) : null}
              <LeadNotesCallTable rows={noteCallRows} />
            </CardContent>
          </Card>
        ) : null}

        {tab === "history" ? (
          <Card>
            <CardContent className="pt-5">
              {lead.activities.length === 0 ? (
                <p className="text-sm text-muted">No history yet.</p>
              ) : (
                <div className="overflow-x-auto rounded-xl border border-[var(--ic-border)]">
                  <table className="w-full min-w-[560px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-[var(--ic-border)] bg-[var(--ic-surface-muted)] text-xs font-semibold text-muted">
                        <th className="w-10 px-3 py-2.5">#</th>
                        <th className="px-3 py-2.5">Date</th>
                        <th className="px-3 py-2.5">Description</th>
                        <th className="px-3 py-2.5">Agent Name</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lead.activities.map((item, index) => (
                        <tr
                          key={item.id}
                          className="border-b border-[var(--ic-border)]/70 last:border-0 odd:bg-surface even:bg-[var(--ic-surface-muted)]/40"
                        >
                          <td className="px-3 py-2.5 text-muted">{index + 1}</td>
                          <td className="whitespace-nowrap px-3 py-2.5">
                            {formatLeadListDateTime(item.createdAt)}
                          </td>
                          <td className="px-3 py-2.5">{item.message}</td>
                          <td className="px-3 py-2.5">
                            {item.actor?.name ?? item.actor?.email ?? "System"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        ) : null}

        {tab === "site-visits" ? <ModulePlaceholder title="Site Visits" /> : null}
        {tab === "quotations" ? <ModulePlaceholder title="Quotations" /> : null}
        {tab === "admission" ? <ModulePlaceholder title="Admission History" /> : null}
        {tab === "applicants" ? <ModulePlaceholder title="Applicants" /> : null}
        {tab === "transactions" ? <ModulePlaceholder title="Transactions" /> : null}
        {tab === "referrals" ? <ModulePlaceholder title="Referrals" /> : null}
        {tab === "contacts" ? <ModulePlaceholder title="Contacts" /> : null}
        {tab === "eoi" ? <ModulePlaceholder title="EOI" /> : null}
        {tab === "documents" ? <ModulePlaceholder title="Documents" /> : null}
      </div>

      <LeadDialUpdateDialog
        lead={lead}
        stages={lookups.stages}
        customFields={customFields}
        open={dialOpen}
        onOpenChange={setDialOpen}
      />

      <Dialog open={reengageOpen} onOpenChange={setReengageOpen}>
        <DialogContent>
          <DialogTitle>Re-engage lead</DialogTitle>
          <DialogDescription>
            Reopen or restart outreach for this lead.
          </DialogDescription>
          <form
            className="mt-4 space-y-3"
            action={async (fd) => {
              fd.set("leadId", lead.id);
              const result = await reengageLeadAction(fd);
              if (!result.ok) toast.error(result.error);
              else {
                toast.success("Lead re-engaged");
                setReengageOpen(false);
                router.refresh();
              }
            }}
          >
            <input type="hidden" name="leadId" value={lead.id} />
            <div>
              <Label htmlFor="reengage-reason">Reason</Label>
              <Input id="reengage-reason" name="reason" />
            </div>
            <div>
              <Label htmlFor="reengage-notes">Notes</Label>
              <Textarea id="reengage-notes" name="notes" rows={2} />
            </div>
            <div>
              <Label htmlFor="reengage-stage">Stage</Label>
              <Select id="reengage-stage" name="stageId" defaultValue={lead.stageId ?? ""}>
                <option value="">Keep current</option>
                {lookups.stages.map((stage) => (
                  <option key={stage.id} value={stage.id}>
                    {stage.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="reengage-assignee">Assignee</Label>
              <Select
                id="reengage-assignee"
                name="assignedUserId"
                defaultValue={lead.assignedUserId ?? ""}
              >
                <option value="">Keep current</option>
                {lookups.members.map((member) => (
                  <option key={member.user.id} value={member.user.id}>
                    {member.user.name ?? member.user.email}
                  </option>
                ))}
              </Select>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="reengage-next-call">Next call due</Label>
                <Input id="reengage-next-call" name="nextCallDueAt" type="datetime-local" />
              </div>
              <div>
                <Label htmlFor="reengage-follow-up">Follow-up</Label>
                <Input id="reengage-follow-up" name="followUpAt" type="datetime-local" />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setReengageOpen(false)}>
                Cancel
              </Button>
              <Button type="submit">Re-engage</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={transferOpen} onOpenChange={setTransferOpen}>
        <DialogContent>
          <DialogTitle>Transfer lead</DialogTitle>
          <DialogDescription>Assign this lead to another team member.</DialogDescription>
          <div className="mt-4 space-y-3">
            <div>
              <Label htmlFor="transfer-to">Transfer to</Label>
              <Select
                id="transfer-to"
                value={transferTo}
                onChange={(e) => setTransferTo(e.target.value)}
              >
                {lookups.members.map((member) => (
                  <option key={member.user.id} value={member.user.id}>
                    {member.user.name ?? member.user.email}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="transfer-reason">Reason</Label>
              <Textarea
                id="transfer-reason"
                rows={2}
                value={transferReason}
                onChange={(e) => setTransferReason(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setTransferOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={async () => {
                  if (!transferTo) {
                    toast.error("Select an assignee");
                    return;
                  }
                  const result = await transferLeadAction(
                    lead.id,
                    transferTo,
                    transferReason,
                  );
                  if (result.ok) {
                    toast.success("Lead transferred");
                    setTransferOpen(false);
                    router.refresh();
                  } else toast.error(result.error);
                }}
              >
                Transfer
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={lostOpen} onOpenChange={setLostOpen}>
        <DialogContent>
          <DialogTitle>Mark lead lost</DialogTitle>
          <DialogDescription>A lost reason is required.</DialogDescription>
          <Select value={lostReason} onChange={(e) => setLostReason(e.target.value as typeof lostReason)}>
            {LOST_REASONS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </Select>
          <div className="mt-3">
            <Label htmlFor="lost-comment">Comment</Label>
            <Textarea
              id="lost-comment"
              rows={2}
              value={lostComment}
              onChange={(e) => setLostComment(e.target.value)}
            />
          </div>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setLostOpen(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                const result = await changeLeadStatusAction(
                  lead.id,
                  LeadStatus.LOST,
                  lostReason,
                  lostComment,
                );
                if (result.ok) {
                  toast.success("Lead marked lost");
                  setLostOpen(false);
                  router.refresh();
                } else toast.error(result.error);
              }}
            >
              Confirm
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={sendEmailOpen} onOpenChange={setSendEmailOpen}>
        <DialogContent>
          <DialogTitle>Send email</DialogTitle>
          <DialogDescription>
            Sends via Resend to {lead.email}. Logged in email history.
          </DialogDescription>
          <div className="grid gap-3">
            <div>
              <Label htmlFor="email-subject">Subject</Label>
              <Input
                id="email-subject"
                value={emailSubject}
                onChange={(e) => setEmailSubject(e.target.value)}
                placeholder="Follow-up regarding your inquiry"
              />
            </div>
            <div>
              <Label htmlFor="email-body">Message</Label>
              <Textarea
                id="email-body"
                rows={5}
                value={emailBody}
                onChange={(e) => setEmailBody(e.target.value)}
                placeholder="Write your message…"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setSendEmailOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={emailPending}
                onClick={async () => {
                  setEmailPending(true);
                  const fd = new FormData();
                  fd.set("leadId", lead.id);
                  fd.set("subject", emailSubject);
                  fd.set("body", emailBody);
                  const result = await sendLeadEmailAction(fd);
                  setEmailPending(false);
                  if (result.ok) {
                    toast.success("Email sent");
                    setSendEmailOpen(false);
                    setEmailSubject("");
                    setEmailBody("");
                    router.refresh();
                  } else {
                    toast.error(result.error);
                  }
                }}
              >
                {emailPending ? "Sending…" : "Send"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={convertOpen} onOpenChange={setConvertOpen}>
        <DialogContent>
          <DialogTitle>Convert this lead?</DialogTitle>
          <DialogDescription>
            This marks the lead converted and keeps the history. Customer records are not created in this phase.
          </DialogDescription>
          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setConvertOpen(false)}>Cancel</Button>
            <Button
              onClick={async () => {
                const result = await changeLeadStatusAction(lead.id, LeadStatus.CONVERTED);
                if (result.ok) {
                  toast.success("Lead converted");
                  setConvertOpen(false);
                  router.refresh();
                } else toast.error(result.error);
              }}
            >
              Convert
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {canChat && organizationId && currentUserId && currentUserName ? (
        <LeadChatDrawer
          open={chatOpen}
          onOpenChange={setChatOpen}
          leadId={lead.id}
          leadName={lead.fullName}
          organizationId={organizationId}
          currentUserId={currentUserId}
          currentUserName={currentUserName}
          canSend={canSendChat ?? false}
        />
      ) : null}
    </div>
  );
}
