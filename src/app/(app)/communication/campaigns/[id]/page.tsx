import { notFound } from "next/navigation";
import { CommunicationType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getCampaign, listCampaignRecipients } from "@/features/marketing/campaigns";
import { CampaignFields } from "../campaign-fields";
import { ScheduleForm } from "./schedule-form";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDateTime, humanize } from "@/components/erp/format";

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div>
      <dt className="text-2xs text-subtle">{label}</dt>
      <dd className="text-lg font-semibold">{value}</dd>
    </div>
  );
}

const reasons = (counts: Record<string, number>) =>
  Object.entries(counts).map(([k, n]) => `${humanize(k)} ${n}`).join(" · ") || "—";

export default async function CampaignPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "campaign.view")) notFound();
  const c = await getCampaign(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const s = c.status;
  const manage = can(ctx, "campaign.manage");
  const mayApprove = can(ctx, "campaign.approve") && c.createdById !== ctx.userId && c.submittedById !== ctx.userId;
  const m = c.metrics;
  const [recipients, editRefs] = await Promise.all([
    listCampaignRecipients(ctx, id, { pageSize: 50 }),
    manage && s === "DRAFT"
      ? Promise.all([
          prisma.messageTemplate.findMany({ where: { organizationId: ctx.organizationId, isActive: true }, select: { id: true, name: true, channel: true, category: true }, orderBy: { name: "asc" } }),
          prisma.segment.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true, name: true, entity: true }, orderBy: { name: "asc" } }),
        ])
      : null,
  ]);

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Communication", "Campaigns", c.name]}
        title={c.name}
        subtitle={`${humanize(c.channel)} · ${humanize(c.purpose)} · segment ${c.segment.name} · template ${c.template.name}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={s} />
            {manage && s === "DRAFT" ? <ActionButton path={`/campaigns/${id}/submit`} label="Submit for approval" variant="default" /> : null}
            {mayApprove && s === "PENDING_APPROVAL" ? <ActionButton path={`/campaigns/${id}/approve`} label="Approve" variant="default" confirm="Approve this campaign for sending?" /> : null}
            {mayApprove && s === "PENDING_APPROVAL" ? <ActionButton path={`/campaigns/${id}/reject`} label="Reject" prompt="Reason for rejecting" /> : null}
            {manage && s === "APPROVED" ? <ActionButton path={`/campaigns/${id}/send`} label="Send now" variant="default" confirm="Start sending to every eligible recipient now?" /> : null}
            {manage && ["DRAFT", "PENDING_APPROVAL", "APPROVED", "SENDING"].includes(s) ? <ActionButton path={`/campaigns/${id}/cancel`} label="Cancel" variant="ghost" confirm="Cancel this campaign? Recipients not yet queued will not be messaged." /> : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Delivery</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="Targeted" value={m.targeted} />
                <Stat label="Skipped" value={m.skipped} />
                <Stat label="Queued" value={m.queued} />
                <Stat label="Waiting to queue" value={m.pending} />
                <Stat label="Sent" value={m.sent} />
                <Stat label="Delivered" value={m.delivered} />
                <Stat label="Read" value={m.read} />
                <Stat label="Failed" value={m.failed} />
              </dl>
              <dl className="space-y-1 text-sm">
                <div><dt className="inline text-subtle">Delivery rate: </dt><dd className="inline">{m.deliveryRate === null ? "—" : `${(m.deliveryRate * 100).toFixed(1)}%`} (delivered ÷ sent, real deliveries only)</dd></div>
                <div><dt className="inline text-subtle">Skipped: </dt><dd className="inline">{reasons(m.skippedByReason)}</dd></div>
                <div><dt className="inline text-subtle">Failed: </dt><dd className="inline">{reasons(m.failedByReason)}</dd></div>
              </dl>
              {m.failedByReason.NOT_CONFIGURED ? (
                <p className="rounded-xl bg-amber-50 px-3 py-2 text-xs text-warning">No messaging provider is configured for {humanize(c.channel)}, so these messages were not sent.</p>
              ) : null}
              {m.simulated.total > 0 ? (
                <div className="rounded-xl border border-dashed border-[var(--ic-border)] px-3 py-2 text-sm">
                  <p className="mb-1 flex items-center gap-2 font-medium"><Badge tone="warning">Simulated — not delivered</Badge> handled by the test provider</p>
                  <p className="text-xs text-muted">
                    {m.simulated.total} messages · “sent” {m.simulated.sent} · “delivered” {m.simulated.delivered} · “read” {m.simulated.read} · failed {m.simulated.failed}. None of these reached a real recipient and they are excluded from the figures above.
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Recipients</CardTitle></CardHeader>
            <CardContent>
              <RecordsTable
                columns={[{ key: "name", label: "Name" }, { key: "address", label: "Address" }, { key: "status", label: "Status" }, { key: "delivery", label: "Delivery" }]}
                empty={s === "DRAFT" || s === "PENDING_APPROVAL" || s === "APPROVED" ? "Recipients are listed once sending starts." : "No recipients."}
              >
                {recipients.items.length
                  ? recipients.items.map((r) => (
                      <RecordsTableRow key={r.id}>
                        <RecordsTableCell>{r.name ?? "—"}</RecordsTableCell>
                        <RecordsTableCell>{r.address}</RecordsTableCell>
                        <RecordsTableCell>{humanize(r.status)}{r.skipReason ? ` · ${humanize(r.skipReason)}` : ""}</RecordsTableCell>
                        <RecordsTableCell>
                          {r.log ? <>{humanize(r.log.status)}{r.log.error ? ` · ${humanize(r.log.error)}` : ""} {r.log.simulated ? <Badge tone="warning">Simulated — not delivered</Badge> : null}</> : "—"}
                        </RecordsTableCell>
                      </RecordsTableRow>
                    ))
                  : undefined}
              </RecordsTable>
              {recipients.total > recipients.items.length ? <p className="mt-2 text-2xs text-subtle">Showing {recipients.items.length} of {recipients.total}.</p> : null}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Schedule</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              <dl className="space-y-2">
                <div><dt className="text-subtle">Scheduled for</dt><dd>{formatDateTime(c.scheduledAt)}</dd></div>
                <div><dt className="text-subtle">Approved</dt><dd>{c.approvedAt ? formatDateTime(c.approvedAt) : "—"}</dd></div>
                <div><dt className="text-subtle">Started</dt><dd>{formatDateTime(c.startedAt)}</dd></div>
                <div><dt className="text-subtle">Finished</dt><dd>{formatDateTime(c.completedAt)}</dd></div>
              </dl>
              {manage && s === "APPROVED" ? <ScheduleForm campaignId={id} current={c.scheduledAt?.toISOString() ?? null} /> : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>Message</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-sm">
              {c.template.subject ? <p className="font-medium">{c.template.subject}</p> : null}
              <p className="whitespace-pre-line text-muted">{c.template.body}</p>
            </CardContent>
          </Card>

          {editRefs ? (
            <Card>
              <CardHeader><CardTitle>Edit draft</CardTitle></CardHeader>
              <CardContent>
                <ApiForm path={`/campaigns/${id}`} method="PATCH" className="grid gap-3">
                  <CampaignFields templates={editRefs[0]} segments={editRefs[1]} channels={Object.values(CommunicationType)} defaults={{ ...c, purpose: c.purpose }} />
                </ApiForm>
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="campaign" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
