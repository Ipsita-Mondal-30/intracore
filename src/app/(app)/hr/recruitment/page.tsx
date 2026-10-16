import Link from "next/link";
import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { listCandidates, listInterviews, listJobOpenings } from "@/features/hr/recruitment";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ListToolbar, Pagination, listParams, param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { formatDate, formatDateTime } from "@/components/erp/format";
import { cn } from "@/lib/utils";
import { FeedbackForm } from "./feedback-form";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function RecruitmentPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const tab = param(params, "tab") === "candidates" ? "candidates" : "openings";
  const header = <PageHeader breadcrumbs={["HR", "Recruitment"]} title="Recruitment" subtitle="Openings, candidates, applications and interviews." />;

  const myInterviews = (await listInterviews(ctx, { mine: "true", pageSize: 50, dir: "asc" })).items.filter(
    (i) => i.status !== "CANCELLED" && !i.feedback.some((f) => f.interviewerId === ctx.userId),
  );
  const pending = myInterviews.length ? (
    <Card>
      <CardHeader><CardTitle>My interviews awaiting feedback</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        {myInterviews.map((i) => (
          <div key={i.id} className="space-y-2 border-b border-[var(--ic-border)] pb-3 last:border-0">
            <p className="text-sm font-medium">{i.application.candidate.fullName} · {i.application.jobOpening.title} · {formatDateTime(i.scheduledAt)} ({i.mode.toLowerCase()})</p>
            <FeedbackForm interviewId={i.id} />
          </div>
        ))}
      </CardContent>
    </Card>
  ) : null;

  if (!can(ctx, "recruitment.view")) {
    return <div className="space-y-4">{header}{pending ?? <p className="text-sm text-muted">You don&apos;t have permission to view recruitment.</p>}</div>;
  }
  const manage = can(ctx, "recruitment.manage");
  const [openings, candidates, companies] = await Promise.all([
    tab === "openings" ? listJobOpenings(ctx, listParams(params, ["status"])) : null,
    tab === "candidates" ? listCandidates(ctx, listParams(params)) : null,
    prisma.company.findMany({ where: { organizationId: ctx.organizationId, id: { in: [...ctx.companies.keys()] } }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } }),
  ]);

  return (
    <div className="space-y-4">
      {header}
      {pending}
      <nav className="flex gap-4 border-b border-[var(--ic-border)] text-sm">
        {(["openings", "candidates"] as const).map((t) => (
          <Link key={t} href={`/hr/recruitment?tab=${t}`} className={cn("-mb-px border-b-2 pb-2 capitalize", tab === t ? "border-primary font-medium" : "border-transparent text-muted")}>{t}</Link>
        ))}
      </nav>
      {openings ? (
      <>
        <Card>
          <CardContent className="pt-5">
            <ListToolbar params={{ ...params, tab: "openings" }} filters={[{ name: "status", label: "Status", options: ["DRAFT", "OPEN", "ON_HOLD", "CLOSED"].map((s) => ({ value: s, label: s })) }]}>
              <input type="hidden" name="tab" value="openings" />
            </ListToolbar>
            <RecordsTable columns={[{ key: "title", label: "Title" }, { key: "dept", label: "Department" }, { key: "loc", label: "Location" }, { key: "apps", label: "Applications" }, { key: "status", label: "Status" }]} empty="No job openings yet.">
              {openings.items.length ? openings.items.map((o) => (
                <RecordsTableRow key={o.id}>
                  <RecordsTableCell><Link href={`/hr/recruitment/openings/${o.id}`} className="font-medium text-primary hover:underline">{o.title}</Link></RecordsTableCell>
                  <RecordsTableCell>{o.department?.name ?? "—"}</RecordsTableCell>
                  <RecordsTableCell>{o.location ?? "—"}</RecordsTableCell>
                  <RecordsTableCell>{o._count.applications}</RecordsTableCell>
                  <RecordsTableCell><StatusBadge status={o.status} /></RecordsTableCell>
                </RecordsTableRow>
              )) : undefined}
            </RecordsTable>
            <Pagination {...openings} params={params} basePath="/hr/recruitment" />
          </CardContent>
        </Card>
        {manage && companies.length ? (
          <Card>
            <CardHeader><CardTitle>New opening</CardTitle></CardHeader>
            <CardContent>
              <ApiForm path="/job-openings" submitLabel="Create opening" redirect="/hr/recruitment/openings/:id" className="grid gap-3 sm:grid-cols-3">
                <Field label="Company">
                  <Select name="companyId" required>{companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}</Select>
                </Field>
                <Field label="Title"><Input name="title" required maxLength={200} /></Field>
                <Field label="Location"><Input name="location" maxLength={120} /></Field>
                <Field label="Employment type">
                  <Select name="employmentType">{["FULL_TIME", "PART_TIME", "CONTRACT", "INTERN"].map((t) => <option key={t} value={t}>{t.replace("_", " ").toLowerCase()}</option>)}</Select>
                </Field>
                <Field label="Positions"><Input type="number" name="openings" min={1} defaultValue={1} /></Field>
              </ApiForm>
            </CardContent>
          </Card>
        ) : null}
      </>
      ) : null}
      {candidates ? (
      <>
        <Card>
          <CardContent className="pt-5">
            <ListToolbar params={params} placeholder="Search name, email, phone…">
              <input type="hidden" name="tab" value="candidates" />
            </ListToolbar>
            <RecordsTable columns={[{ key: "name", label: "Name" }, { key: "email", label: "Email" }, { key: "phone", label: "Phone" }, { key: "source", label: "Source" }, { key: "apps", label: "Applications" }, { key: "added", label: "Added" }]} empty="No candidates yet.">
              {candidates.items.length ? candidates.items.map((c) => (
                <RecordsTableRow key={c.id}>
                  <RecordsTableCell className="font-medium">{c.fullName}</RecordsTableCell>
                  <RecordsTableCell>{c.email ?? "—"}</RecordsTableCell>
                  <RecordsTableCell>{c.phone ?? "—"}</RecordsTableCell>
                  <RecordsTableCell>{c.source ?? "—"}</RecordsTableCell>
                  <RecordsTableCell>{c._count.applications}</RecordsTableCell>
                  <RecordsTableCell>{formatDate(c.createdAt)}</RecordsTableCell>
                </RecordsTableRow>
              )) : undefined}
            </RecordsTable>
            <Pagination {...candidates} params={params} basePath="/hr/recruitment" />
          </CardContent>
        </Card>
        {manage ? (
          <Card>
            <CardHeader><CardTitle>Add candidate</CardTitle></CardHeader>
            <CardContent>
              <ApiForm path="/candidates" submitLabel="Add candidate" successMessage="Candidate added" className="grid gap-3 sm:grid-cols-4">
                <Field label="Full name"><Input name="fullName" required maxLength={200} /></Field>
                <Field label="Email" hint="Candidates are unique by email"><Input type="email" name="email" maxLength={200} /></Field>
                <Field label="Phone"><Input name="phone" maxLength={40} /></Field>
                <Field label="Source"><Input name="source" maxLength={80} placeholder="Referral, job board…" /></Field>
              </ApiForm>
            </CardContent>
          </Card>
        ) : null}
      </>
      ) : null}
    </div>
  );
}
