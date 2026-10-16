import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getApplication, STAGE_TRANSITIONS } from "@/features/hr/recruitment";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDateTime, humanize } from "@/components/erp/format";
import { FeedbackForm } from "../../feedback-form";

export default async function ApplicationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "recruitment.view")) notFound();
  const app = await getApplication(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const manage = can(ctx, "recruitment.manage");
  const next = STAGE_TRANSITIONS[app.stage];
  const userIds = [...new Set(app.interviews.flatMap((i) => i.interviewerIds.split(",")))];
  const [members, people] = await Promise.all([
    manage && next.length
      ? prisma.organizationMember.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, select: { user: { select: { id: true, name: true, email: true } } }, take: 500 })
      : [],
    prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, email: true } }),
  ]);
  const who = (uid: string) => { const u = people.find((p) => p.id === uid); return u?.name ?? u?.email ?? "—"; };
  const memberOptions = members.map((m) => <option key={m.user.id} value={m.user.id}>{m.user.name ?? m.user.email}</option>);

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["HR", "Recruitment", app.jobOpening.title, app.candidate.fullName]}
        title={app.candidate.fullName}
        subtitle={[app.candidate.email, app.candidate.phone, app.candidate.source].filter(Boolean).join(" · ")}
        actions={<div className="flex items-center gap-2"><StatusBadge status={app.stage} /><Link href={`/hr/recruitment/openings/${app.jobOpening.id}`} className="text-sm text-primary hover:underline">{app.jobOpening.title}</Link></div>}
      />
      {app.rejectionReason ? <p className="text-sm text-danger">Rejected: {app.rejectionReason}</p> : null}
      {manage && next.length ? (
        <Card>
          <CardHeader><CardTitle>Move stage</CardTitle></CardHeader>
          <CardContent>
            <ApiForm path={`/applications/${id}/stage`} submitLabel="Move" successMessage="Stage updated" className="grid gap-3 sm:grid-cols-3">
              <Field label="Next stage"><Select name="stage">{next.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}</Select></Field>
              <Field label="Reason" hint="Required when rejecting"><Input name="reason" maxLength={1000} /></Field>
            </ApiForm>
          </CardContent>
        </Card>
      ) : null}
      <Card>
        <CardHeader><CardTitle>Interviews</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {app.interviews.length === 0 ? <p className="text-sm text-muted">No interviews yet.</p> : app.interviews.map((i) => {
            const mine = i.interviewerIds.split(",").includes(ctx.userId);
            return (
              <div key={i.id} className="space-y-2 border-b border-[var(--ic-border)] pb-3 last:border-0">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{formatDateTime(i.scheduledAt)}</span>
                  <span className="text-muted">{i.durationMin} min · {i.mode.toLowerCase()} · {i.interviewerIds.split(",").map(who).join(", ")}</span>
                  <StatusBadge status={i.status} />
                  {manage && i.status === "SCHEDULED" ? (
                    <>
                      <ActionButton path={`/interviews/${i.id}/complete`} label="Mark completed" />
                      <ActionButton path={`/interviews/${i.id}/cancel`} label="Cancel" variant="ghost" confirm="Cancel this interview?" />
                    </>
                  ) : null}
                </div>
                {i.feedback.map((f) => (
                  <p key={f.id} className="text-sm"><strong>{who(f.interviewerId)}</strong>: {f.rating}/5 · {humanize(f.recommendation)}{f.comments ? ` — ${f.comments}` : ""}</p>
                ))}
                {mine && i.status !== "CANCELLED" && !i.feedback.some((f) => f.interviewerId === ctx.userId) ? <FeedbackForm interviewId={i.id} /> : null}
              </div>
            );
          })}
          {manage && next.length ? (
            <ApiForm path="/interviews" extra={{ applicationId: id }} submitLabel="Schedule interview" successMessage="Interview scheduled" className="grid gap-3 sm:grid-cols-3">
              <Field label="When"><Input type="datetime-local" name="scheduledAt" required /></Field>
              <Field label="Duration (min)"><Input type="number" name="durationMin" min={15} max={480} defaultValue={60} /></Field>
              <Field label="Mode"><Select name="mode">{["VIDEO", "ONSITE", "PHONE"].map((m) => <option key={m} value={m}>{m.toLowerCase()}</option>)}</Select></Field>
              <Field label="Interviewer"><Select name="interviewerIds.0" required>{memberOptions}</Select></Field>
              <Field label="Second interviewer (optional)"><Select name="interviewerIds.1"><option value="">—</option>{memberOptions}</Select></Field>
            </ApiForm>
          ) : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>History</CardTitle></CardHeader>
        <CardContent><AuditTrail ctx={ctx} entity="application" entityId={id} /></CardContent>
      </Card>
    </div>
  );
}
