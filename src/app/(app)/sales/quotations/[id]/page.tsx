import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getQuotation } from "@/features/sales/quotations";
import { listCatalogLookups, listProducts } from "@/features/catalog/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { LinesEditor, type ProductOption } from "@/components/erp/lines-editor";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail, DocumentLines, DocumentTotals } from "@/components/erp/document-view";
import { dateInput, formatDate, formatDateTime } from "@/components/erp/format";

const OPEN = ["PENDING_APPROVAL", "APPROVED", "SENT"];

export default async function QuotationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const q = await getQuotation(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const s = q.status;
  const canUpdate = can(ctx, "quotation.update");
  const canApprove = can(ctx, "quotation.approve");
  const canCancel = can(ctx, "quotation.delete");
  const canRevise = can(ctx, "quotation.create");
  const editable = s === "DRAFT" && canUpdate;

  const [products, lookups] = editable && can(ctx, "product.view")
    ? await Promise.all([listProducts(ctx, { pageSize: "100", status: "ACTIVE" }), listCatalogLookups(ctx)])
    : [null, null];

  // Keep products/tax rates already on the lines selectable even if archived or inactive.
  const productOptions = new Map<string, ProductOption>(
    q.lines.flatMap((l) => (l.product ? [[l.product.id, { id: l.product.id, sku: l.product.sku, name: l.product.name, price: l.unitPrice.toString(), taxRateId: null }] as const] : [])),
  );
  for (const p of products?.items ?? []) productOptions.set(p.id, { id: p.id, sku: p.sku, name: p.name, price: p.salesPrice.toString(), taxRateId: p.taxRateId });
  const usedTaxIds = new Set(q.lines.map((l) => l.taxRateId));
  const taxOptions = (lookups?.taxRates ?? [])
    .filter((t) => t.isActive || usedTaxIds.has(t.id))
    .map((t) => ({ id: t.id, name: t.name, rate: t.rate.toString() }));

  const title = `${q.number}${q.revision > 1 ? ` R${q.revision}` : ""}`;
  const a = (action: string) => `/quotations/${id}/${action}`;

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Sales", "Quotations", title]}
        title={title}
        subtitle={`${q.customer.name} · ${q.company.code} · ${q.branch.name}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={s} />
            <Link href={`/print/quotations/${id}`} target="_blank" className="text-sm text-primary hover:underline">Print</Link>
            {s === "DRAFT" && canUpdate ? <ActionButton path={a("submit")} label="Submit" variant="default" /> : null}
            {s === "PENDING_APPROVAL" && canApprove ? (
              <>
                <ActionButton path={a("approve")} label="Approve" variant="default" prompt="Approval note (optional)" promptField="note" />
                <ActionButton path={a("return")} label="Return" prompt="What needs to change?" promptField="note" />
              </>
            ) : null}
            {s === "APPROVED" && canUpdate ? <ActionButton path={a("send")} label="Mark sent" variant="default" /> : null}
            {(s === "APPROVED" || s === "SENT") && canUpdate ? (
              <>
                <ActionButton path={a("accept")} label="Accept" confirm="Mark this quotation as accepted by the customer?" />
                <ActionButton path={a("reject")} label="Reject" prompt="Why did the customer reject it?" promptField="reason" />
              </>
            ) : null}
            {s === "ACCEPTED" && !q.salesOrder && can(ctx, "sales_order.create") ? (
              <ActionButton path={a("convert")} label="Convert to order" variant="default" confirm="Create a sales order from this quotation?" redirectTo="/sales/orders/:id" />
            ) : null}
            {[...OPEN, "REJECTED", "EXPIRED"].includes(s) && canRevise ? (
              <ActionButton path={a("revise")} label="Revise" confirm="Create a new draft revision? This one will be superseded." redirectTo="/sales/quotations/:id" />
            ) : null}
            {(s === "DRAFT" || OPEN.includes(s)) && canCancel ? (
              <ActionButton path={a("cancel")} label="Cancel" variant="ghost" prompt="Reason for cancelling (optional)" promptField="reason" />
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Lines</CardTitle></CardHeader>
            <CardContent>
              {q.lines.length === 0 ? <p className="text-sm text-muted">No lines yet.</p> : <DocumentLines lines={q.lines} currency={q.currency} />}
              <DocumentTotals doc={q} currency={q.currency} />
            </CardContent>
          </Card>

          {editable ? (
            <Card>
              <CardHeader><CardTitle>Edit draft</CardTitle></CardHeader>
              <CardContent>
                <ApiForm path={`/quotations/${id}`} method="PATCH" successMessage="Quotation updated">
                  <LinesEditor
                    products={[...productOptions.values()]}
                    taxRates={taxOptions}
                    initial={q.lines.map((l) => ({
                      productId: l.productId ?? "",
                      description: l.description,
                      quantity: l.quantity.toString(),
                      unitPrice: l.unitPrice.toString(),
                      discountPercent: l.discountPercent.toString(),
                      taxRateId: l.taxRateId ?? "none",
                    }))}
                  />
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Valid until"><Input type="date" name="validUntil" defaultValue={dateInput(q.validUntil)} /></Field>
                    <Field label="Terms"><Textarea name="terms" rows={3} defaultValue={q.terms ?? ""} data-nullable /></Field>
                    <Field label="Notes"><Textarea name="notes" rows={3} defaultValue={q.notes ?? ""} data-nullable /></Field>
                  </div>
                </ApiForm>
              </CardContent>
            </Card>
          ) : q.terms || q.notes ? (
            <Card>
              <CardHeader><CardTitle>Terms & notes</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {q.terms ? <div><p className="text-subtle">Terms</p><p className="whitespace-pre-line">{q.terms}</p></div> : null}
                {q.notes ? <div><p className="text-subtle">Notes</p><p className="whitespace-pre-line">{q.notes}</p></div> : null}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="text-subtle">Customer</dt>
                  <dd>
                    <Link href={`/crm/customers/${q.customerId}`} className="text-primary hover:underline">{q.customer.name}</Link>
                    {q.contact ? <span className="text-muted"> · {q.contact.fullName}</span> : null}
                  </dd>
                </div>
                <div><dt className="text-subtle">Company / branch</dt><dd>{q.company.code} · {q.branch.name}</dd></div>
                {q.opportunity ? (
                  <div>
                    <dt className="text-subtle">Opportunity</dt>
                    <dd><Link href={`/crm/opportunities/${q.opportunity.id}`} className="text-primary hover:underline">{q.opportunity.name}</Link></dd>
                  </div>
                ) : null}
                <div><dt className="text-subtle">Issued / valid until</dt><dd>{formatDate(q.issueDate)} → {formatDate(q.validUntil)}</dd></div>
                <div><dt className="text-subtle">Place of supply</dt><dd>{q.placeOfSupplyState ?? "—"}</dd></div>
                <div><dt className="text-subtle">Created by</dt><dd>{q.createdBy.name ?? q.createdBy.email} · {formatDateTime(q.createdAt)}</dd></div>
                {q.approvalReason ? <div><dt className="text-subtle">Needs approval because</dt><dd>{q.approvalReason}</dd></div> : null}
                {q.approvalNote ? <div><dt className="text-subtle">Approver note</dt><dd className="whitespace-pre-line">{q.approvalNote}</dd></div> : null}
                {q.approvedBy || q.approvedAt ? (
                  <div><dt className="text-subtle">Approved</dt><dd>{q.approvedBy ? (q.approvedBy.name ?? q.approvedBy.email) : "Auto-approved"} · {formatDateTime(q.approvedAt)}</dd></div>
                ) : null}
                {q.rejectionReason ? <div><dt className="text-subtle">Rejection reason</dt><dd className="whitespace-pre-line">{q.rejectionReason}</dd></div> : null}
                {q.previousRevision ? (
                  <div>
                    <dt className="text-subtle">Previous revision</dt>
                    <dd><Link href={`/sales/quotations/${q.previousRevision.id}`} className="text-primary hover:underline">R{q.previousRevision.revision}</Link> <StatusBadge status={q.previousRevision.status} /></dd>
                  </div>
                ) : null}
                {q.nextRevision ? (
                  <div>
                    <dt className="text-subtle">Next revision</dt>
                    <dd><Link href={`/sales/quotations/${q.nextRevision.id}`} className="text-primary hover:underline">R{q.nextRevision.revision}</Link> <StatusBadge status={q.nextRevision.status} /></dd>
                  </div>
                ) : null}
                {q.salesOrder ? (
                  <div>
                    <dt className="text-subtle">Sales order</dt>
                    <dd><Link href={`/sales/orders/${q.salesOrder.id}`} className="text-primary hover:underline">{q.salesOrder.number}</Link> <StatusBadge status={q.salesOrder.status} /></dd>
                  </div>
                ) : null}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="quotation" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
