import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getJobOpening } from "@/features/hr/recruitment";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDate, humanize } from "@/components/erp/format";

export default async function JobOpeningPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "recruitment.view")) notFound();
  const opening = await getJobOpening(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const manage = can(ctx, "recruitment.manage");
  const s = opening.status;
  const applied = new Set(opening.applications.map((a) => a.candidateId));
  const candidates = manage && s === "OPEN"
    ? (await prisma.candidate.findMany({ where: { organizationId: ctx.organizationId }, select: { id: true, fullName: true, email: true }, orderBy: { createdAt: "desc" }, take: 300 })).filter((c) => !applied.has(c.id))
    : [];

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["HR", "Recruitment", opening.title]}
        title={opening.title}
        subtitle={[opening.department?.name, opening.designation?.name, opening.location, humanize(opening.employmentType), `${opening.openings} position(s)`].filter(Boolean).join(" · ")}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={s} />
            {manage && (s === "DRAFT" || s === "ON_HOLD") ? <ActionButton path={`/job-openings/${id}/open`} label="Open" variant="default" /> : null}
            {manage && s === "OPEN" ? <ActionButton path={`/job-openings/${id}/hold`} label="Put on hold" /> : null}
            {manage && s !== "CLOSED" ? <ActionButton path={`/job-openings/${id}/close`} label="Close" variant="ghost" confirm="Close this opening?" /> : null}
          </div>
        }
      />
      {opening.description ? <Card><CardContent className="whitespace-pre-line pt-5 text-sm">{opening.description}</CardContent></Card> : null}
      <Card>
        <CardHeader><CardTitle>Applications</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <RecordsTable columns={[{ key: "c", label: "Candidate" }, { key: "e", label: "Email" }, { key: "s", label: "Stage" }, { key: "i", label: "Interviews" }, { key: "d", label: "Applied" }]} empty="No applications yet.">
            {opening.applications.length ? opening.applications.map((a) => (
              <RecordsTableRow key={a.id}>
                <RecordsTableCell><Link href={`/hr/recruitment/applications/${a.id}`} className="font-medium text-primary hover:underline">{a.candidate.fullName}</Link></RecordsTableCell>
                <RecordsTableCell>{a.candidate.email ?? "—"}</RecordsTableCell>
                <RecordsTableCell><StatusBadge status={a.stage} /></RecordsTableCell>
                <RecordsTableCell>{a._count.interviews}</RecordsTableCell>
                <RecordsTableCell>{formatDate(a.createdAt)}</RecordsTableCell>
              </RecordsTableRow>
            )) : undefined}
          </RecordsTable>
          {candidates.length ? (
            <ApiForm path="/applications" extra={{ jobOpeningId: id }} submitLabel="Add application" successMessage="Application added" className="flex flex-wrap items-end gap-3">
              <Field label="Candidate">
                <Select name="candidateId" required>{candidates.map((c) => <option key={c.id} value={c.id}>{c.fullName}{c.email ? ` · ${c.email}` : ""}</option>)}</Select>
              </Field>
            </ApiForm>
          ) : manage && s === "OPEN" ? <p className="text-xs text-muted">Add candidates under Recruitment › Candidates to apply them here.</p> : null}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>History</CardTitle></CardHeader>
        <CardContent><AuditTrail ctx={ctx} entity="job_opening" entityId={id} /></CardContent>
      </Card>
    </div>
  );
}
