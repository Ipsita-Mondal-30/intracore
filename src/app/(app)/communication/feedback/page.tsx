import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { FEEDBACK_SOURCES, feedbackSummary, listFeedback } from "@/features/marketing/feedback";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ListToolbar, Pagination, listParams } from "@/components/erp/list-controls";
import { ApiForm, Field } from "@/components/erp/api-form";
import { formatDateTime, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function FeedbackPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Communication", "Feedback"]} title="Customer feedback" subtitle="Ratings and reviews. Only feedback the customer agreed to publish is marked public." />;
  if (!can(ctx, "feedback.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view feedback.</p></div>;
  }
  const p = listParams(params, ["source", "rating", "isPublic"]);
  const filters = {
    ...p,
    source: FEEDBACK_SOURCES.includes(p.source as never) ? p.source : undefined,
    rating: ["1", "2", "3", "4", "5"].includes(p.rating) ? p.rating : undefined,
    isPublic: p.isPublic === "true" || p.isPublic === "false" ? p.isPublic : undefined,
  };
  const [page, summary, customers, campaigns] = await Promise.all([
    listFeedback(ctx, filters),
    feedbackSummary(ctx, { ...filters, page: undefined, pageSize: undefined }),
    can(ctx, "feedback.create") ? prisma.customer.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 500 }) : [],
    can(ctx, "feedback.create") ? prisma.campaign.findMany({ where: { organizationId: ctx.organizationId, status: { in: ["SENDING", "COMPLETED"] } }, select: { id: true, name: true }, orderBy: { createdAt: "desc" }, take: 100 }) : [],
  ]);

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="flex flex-wrap gap-6 pt-5 text-sm">
          <div><p className="text-2xs text-subtle">Average rating</p><p className="text-2xl font-semibold">{summary.averageRating ?? "—"}<span className="text-sm text-muted"> / 5</span></p></div>
          <div><p className="text-2xs text-subtle">Responses</p><p className="text-2xl font-semibold">{summary.count}</p></div>
          <div className="flex items-end gap-3">
            {[5, 4, 3, 2, 1].map((r) => <span key={r} className="text-xs text-muted">{r}★ {summary.distribution[r]}</span>)}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="pt-5">
          <ListToolbar
            params={params}
            placeholder="Search comments…"
            filters={[
              { name: "rating", label: "Rating", options: [5, 4, 3, 2, 1].map((r) => ({ value: String(r), label: `${r} stars` })) },
              { name: "source", label: "Source", options: FEEDBACK_SOURCES.map((s) => ({ value: s, label: humanize(s) })) },
              { name: "isPublic", label: "Public", options: [{ value: "true", label: "Public reviews" }, { value: "false", label: "Private" }] },
            ]}
          />
          <RecordsTable
            columns={[{ key: "date", label: "Date" }, { key: "customer", label: "Customer" }, { key: "rating", label: "Rating" }, { key: "comment", label: "Comment" }, { key: "source", label: "Source" }]}
            empty="No feedback recorded."
          >
            {page.items.length
              ? page.items.map((f) => (
                  <RecordsTableRow key={f.id}>
                    <RecordsTableCell>{formatDateTime(f.createdAt)}</RecordsTableCell>
                    <RecordsTableCell>{f.customer?.name ?? "—"}</RecordsTableCell>
                    <RecordsTableCell>{f.rating}/5</RecordsTableCell>
                    <RecordsTableCell>{f.comment ?? "—"} {f.isPublic ? <Badge tone="success">Public review</Badge> : null}</RecordsTableCell>
                    <RecordsTableCell>{humanize(f.source)}{f.campaign ? ` · ${f.campaign.name}` : ""}</RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
          <Pagination {...page} params={params} basePath="/communication/feedback" />
        </CardContent>
      </Card>

      {can(ctx, "feedback.create") ? (
        <Card>
          <CardHeader><CardTitle>Record feedback</CardTitle></CardHeader>
          <CardContent>
            <ApiForm path="/customer-feedback" submitLabel="Save feedback" className="grid gap-3 sm:grid-cols-3">
              <Field label="Rating">
                <Select name="rating" defaultValue="5">{[5, 4, 3, 2, 1].map((n) => <option key={n} value={n}>{n}</option>)}</Select>
              </Field>
              <Field label="Customer">
                <Select name="customerId"><option value="">None</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
              </Field>
              <Field label="Campaign">
                <Select name="campaignId"><option value="">None</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
              </Field>
              <Field label="Comment" className="sm:col-span-3"><Textarea name="comment" rows={3} maxLength={5000} /></Field>
              <Field label="Ticket id (optional)"><Input name="ticketId" /></Field>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" name="isPublic" /> Publish as a review
              </label>
              <label className="flex items-center gap-2 text-sm sm:col-span-3">
                <input type="checkbox" name="publicConsent" /> The customer explicitly agreed to publish this feedback
              </label>
            </ApiForm>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
