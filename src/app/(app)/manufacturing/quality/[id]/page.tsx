import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getNonConformance } from "@/features/quality/ncr";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDate, formatDateTime, formatQty, humanize } from "@/components/erp/format";

export default async function NonConformancePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const ncr = await getNonConformance(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const canManage = can(ctx, "quality.manage");
  const closed = ncr.status === "CLOSED";
  const a = (action: string) => `/nonconformances/${id}/${action}`;
  const source = ncr.inspection
    ? ncr.inspection.sourceType === "WORK_ORDER"
      ? <Link href={`/manufacturing/work-orders/${ncr.inspection.sourceId}`} className="text-primary hover:underline">Work order</Link>
      : <Link href={`/inventory/entries/${ncr.inspection.sourceId}`} className="text-primary hover:underline">Goods receipt</Link>
    : "Raised manually";

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Manufacturing", "Quality", ncr.number]}
        title={ncr.number}
        subtitle={`${humanize(ncr.severity)} non-conformance · raised ${formatDate(ncr.createdAt)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={ncr.status} />
            {canManage && ncr.status === "OPEN" ? <ActionButton path={a("start")} label="Start" /> : null}
            {canManage && !closed ? (
              <ActionButton path={a("close")} label="Close" variant="default" prompt={ncr.rootCause ? "Root cause (leave as is to keep)" : "Root cause"} promptField="rootCause" />
            ) : null}
            {canManage && closed ? <ActionButton path={a("reopen")} label="Reopen" prompt="Why reopen?" promptField="reason" /> : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Corrective actions</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {ncr.correctiveActions.length === 0 ? <p className="text-sm text-muted">No corrective actions yet.</p> : null}
              <ul className="space-y-2 text-sm">
                {ncr.correctiveActions.map((t) => (
                  <li key={t.id} className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={t.status} />
                    <span className="font-medium">{t.title}</span>
                    <span className="text-muted">{t.assignedUser ? (t.assignedUser.name ?? t.assignedUser.email) : "Unassigned"}{t.dueAt ? ` · due ${formatDate(t.dueAt)}` : ""}</span>
                    {t.status === "PENDING" || t.status === "RESCHEDULED" ? (
                      <ActionButton path={`/tasks/${t.id}`} method="PATCH" body={{ status: "COMPLETED" }} label="Mark done" variant="ghost" />
                    ) : null}
                  </li>
                ))}
              </ul>
              {canManage && !closed ? (
                <ApiForm path={a("actions")} submitLabel="Add corrective action" successMessage="Corrective action added" className="grid gap-3 border-t border-[var(--ic-border)] pt-3 sm:grid-cols-3">
                  <Field label="Action"><Input name="title" required /></Field>
                  <Field label="Due"><Input name="dueAt" type="date" /></Field>
                  <Field label="Details"><Input name="description" /></Field>
                </ApiForm>
              ) : null}
            </CardContent>
          </Card>

          {canManage && !closed ? (
            <Card>
              <CardHeader><CardTitle>Investigation</CardTitle></CardHeader>
              <CardContent>
                <ApiForm path={`/nonconformances/${id}`} method="PATCH" successMessage="NCR updated">
                  <Field label="Description"><Textarea name="description" rows={3} defaultValue={ncr.description} required /></Field>
                  <Field label="Root cause"><Textarea name="rootCause" rows={3} defaultValue={ncr.rootCause ?? ""} data-nullable /></Field>
                  <Field label="Severity">
                    <Select name="severity" defaultValue={ncr.severity}>
                      <option value="MINOR">Minor</option>
                      <option value="MAJOR">Major</option>
                      <option value="CRITICAL">Critical</option>
                    </Select>
                  </Field>
                </ApiForm>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader><CardTitle>Details</CardTitle></CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="whitespace-pre-line">{ncr.description}</p>
                <p><span className="text-subtle">Root cause:</span> {ncr.rootCause ?? "—"}</p>
              </CardContent>
            </Card>
          )}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Source</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div><dt className="text-subtle">From</dt><dd>{source}</dd></div>
                {ncr.inspection ? <div><dt className="text-subtle">Inspection</dt><dd>{humanize(ncr.inspection.result)} · {formatQty(ncr.inspection.rejectedQty)} of {formatQty(ncr.inspection.inspectedQty)} rejected</dd></div> : null}
                <div><dt className="text-subtle">Product</dt><dd>{ncr.product ? `${ncr.product.sku} · ${ncr.product.name}` : "—"}</dd></div>
                <div><dt className="text-subtle">Vendor</dt><dd>{ncr.vendor ? <Link href={`/purchasing/vendors/${ncr.vendor.id}`} className="text-primary hover:underline">{ncr.vendor.name}</Link> : "—"}</dd></div>
                <div><dt className="text-subtle">Quantity</dt><dd>{formatQty(ncr.quantity)}</dd></div>
                {ncr.closedAt ? <div><dt className="text-subtle">Closed</dt><dd>{formatDateTime(ncr.closedAt)}</dd></div> : null}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="nonconformance" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
