import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { dec } from "@/lib/money";
import { GST_STATES } from "@/lib/gst";
import { can, getAccessContext } from "@/lib/access";
import { getInvoice } from "@/features/finance/receivables";
import { buildEInvoice } from "@/features/finance/einvoice";
import { listCatalogLookups, listProducts } from "@/features/catalog/service";
import { CreditNoteForm, type CreditableLine } from "@/features/finance/credit-note-form";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { LinesEditor, type ProductOption } from "@/components/erp/lines-editor";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail, DocumentLines, DocumentTotals } from "@/components/erp/document-view";
import { dateInput, formatDate, formatDateTime, formatMoney } from "@/components/erp/format";

export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const inv = await getInvoice(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const s = inv.status;
  const cur = inv.currency;
  const canCreate = can(ctx, "invoice.create");
  const editable = s === "DRAFT" && canCreate;
  const settled = dec(inv.paidAmount).gt(0) || dec(inv.creditedAmount).gt(0) || inv.creditNotes.some((n) => n.status === "POSTED");
  const due = Number(inv.outstanding);

  const [products, lookups, credited, einvoice] = await Promise.all([
    editable && !inv.salesOrderId && can(ctx, "product.view") ? listProducts(ctx, { pageSize: "100", status: "ACTIVE" }) : null,
    editable && !inv.salesOrderId && can(ctx, "product.view") ? listCatalogLookups(ctx) : null,
    s === "POSTED" && canCreate
      ? prisma.creditNoteLine.findMany({
          where: { organizationId: ctx.organizationId, invoiceLineId: { in: inv.lines.map((l) => l.id) }, creditNote: { status: "POSTED" } },
          select: { invoiceLineId: true, quantity: true },
        })
      : [],
    s === "POSTED" ? buildEInvoice(ctx, id) : null,
  ]);

  // Keep products/tax rates already on the lines selectable even if archived or inactive.
  const productOptions = new Map<string, ProductOption>(
    inv.lines.flatMap((l) => (l.product ? [[l.product.id, { id: l.product.id, sku: l.product.sku, name: l.product.name, price: l.unitPrice.toString(), taxRateId: null }] as const] : [])),
  );
  for (const p of products?.items ?? []) productOptions.set(p.id, { id: p.id, sku: p.sku, name: p.name, price: p.salesPrice.toString(), taxRateId: p.taxRateId });
  const usedTaxIds = new Set(inv.lines.map((l) => l.taxRateId));
  const taxOptions = (lookups?.taxRates ?? [])
    .filter((t) => t.isActive || usedTaxIds.has(t.id))
    .map((t) => ({ id: t.id, name: t.name, rate: t.rate.toString() }));

  const creditable: CreditableLine[] = inv.lines.map((l) => {
    const done = credited.filter((c) => c.invoiceLineId === l.id).reduce((sum, c) => sum.add(c.quantity), dec(0));
    return { id: l.id, description: l.description, unitPrice: l.unitPrice.toString(), creditable: dec(l.quantity).sub(done).toString() };
  });
  const lines = inv.lines.map((l) => ({ ...l, product: l.product ? { sku: l.product.sku, hsnCode: l.hsnCode } : l.hsnCode ? { sku: "", hsnCode: l.hsnCode } : null }));
  const pos = inv.placeOfSupplyState;
  const title = inv.number ?? "Draft invoice";
  const a = (action: string) => `/sales-invoices/${id}/${action}`;

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Finance", "Invoices", inv.number ?? "Draft"]}
        title={title}
        subtitle={`${inv.customer.name} · ${inv.company.code} · ${inv.branch.name}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={s} />
            <Link href={`/print/invoices/${id}`} target="_blank" className="text-sm text-primary hover:underline">Print</Link>
            {s === "DRAFT" && can(ctx, "invoice.post") ? (
              <ActionButton path={a("post")} label="Post" variant="default" confirm="Post this invoice? It gets its number, the journal is written and it can no longer be edited." />
            ) : null}
            {s === "POSTED" && due > 0 && can(ctx, "receipt.create") ? (
              <Link href={`/finance/receipts/new?invoiceId=${id}`} className="text-sm text-primary hover:underline">Record receipt</Link>
            ) : null}
            {(s === "DRAFT" || (s === "POSTED" && !settled)) && can(ctx, "invoice.cancel") ? (
              <ActionButton
                path={a("cancel")}
                label="Cancel"
                variant="ghost"
                prompt="Reason for cancelling"
                promptField="reason"
                confirm={s === "POSTED" ? "Cancel this posted invoice? Its journal will be reversed (dated today) and any sales-order quantities released. The number stays used." : "Cancel this draft invoice?"}
              />
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {s === "CANCELLED" ? (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-danger">
              Cancelled {formatDate(inv.cancelledAt)}{inv.cancelReason ? `: “${inv.cancelReason}”` : ""}
            </p>
          ) : null}

          <Card>
            <CardHeader><CardTitle>Lines</CardTitle></CardHeader>
            <CardContent>
              {lines.length === 0 ? <p className="text-sm text-muted">No lines yet.</p> : <DocumentLines lines={lines} currency={cur} />}
              <DocumentTotals doc={inv} currency={cur} />
              <dl className="ml-auto mt-2 w-full max-w-xs space-y-1 text-xs text-subtle">
                {dec(inv.igstTotal).gt(0) ? (
                  <div className="flex justify-between"><dt>IGST</dt><dd>{formatMoney(inv.igstTotal, cur)}</dd></div>
                ) : (
                  <>
                    <div className="flex justify-between"><dt>CGST</dt><dd>{formatMoney(inv.cgstTotal, cur)}</dd></div>
                    <div className="flex justify-between"><dt>SGST</dt><dd>{formatMoney(inv.sgstTotal, cur)}</dd></div>
                  </>
                )}
              </dl>
            </CardContent>
          </Card>

          {editable ? (
            <Card>
              <CardHeader><CardTitle>Edit draft</CardTitle></CardHeader>
              <CardContent>
                <ApiForm path={`/sales-invoices/${id}`} method="PATCH" successMessage="Invoice updated">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Field label="Invoice date"><Input type="date" name="invoiceDate" defaultValue={dateInput(inv.invoiceDate)} /></Field>
                    <Field label="Due date"><Input type="date" name="dueDate" defaultValue={dateInput(inv.dueDate)} /></Field>
                    <Field label="Place of supply" hint="GST state code. Empty = customer's state.">
                      <Input name="placeOfSupplyState" inputMode="numeric" pattern="[0-9]{2}" maxLength={2} defaultValue={pos ?? ""} data-nullable />
                    </Field>
                  </div>
                  {inv.salesOrderId ? (
                    <p className="text-xs text-muted">Lines come from the sales order; to change them, cancel this draft and invoice the order again.</p>
                  ) : (
                    <LinesEditor
                      products={[...productOptions.values()]}
                      taxRates={taxOptions}
                      initial={inv.lines.map((l) => ({
                        productId: l.productId ?? "",
                        description: l.description,
                        quantity: l.quantity.toString(),
                        unitPrice: l.unitPrice.toString(),
                        discountPercent: l.discountPercent.toString(),
                        taxRateId: l.taxRateId ?? "none",
                      }))}
                    />
                  )}
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field label="Terms"><Textarea name="terms" rows={3} defaultValue={inv.terms ?? ""} data-nullable /></Field>
                    <Field label="Notes"><Textarea name="notes" rows={3} defaultValue={inv.notes ?? ""} data-nullable /></Field>
                  </div>
                </ApiForm>
              </CardContent>
            </Card>
          ) : inv.terms || inv.notes ? (
            <Card>
              <CardHeader><CardTitle>Terms & notes</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {inv.terms ? <div><p className="text-subtle">Terms</p><p className="whitespace-pre-line">{inv.terms}</p></div> : null}
                {inv.notes ? <div><p className="text-subtle">Notes</p><p className="whitespace-pre-line">{inv.notes}</p></div> : null}
              </CardContent>
            </Card>
          ) : null}

          {s === "POSTED" && canCreate ? (
            <Card>
              <CardHeader><CardTitle>Credit note</CardTitle></CardHeader>
              <CardContent>
                {creditable.some((l) => Number(l.creditable) > 0) ? (
                  <CreditNoteForm invoiceId={id} lines={creditable} />
                ) : (
                  <p className="text-sm text-muted">Every line has already been fully credited.</p>
                )}
              </CardContent>
            </Card>
          ) : null}

          {einvoice ? (
            <Card>
              <CardHeader><CardTitle>E-invoice (IRN)</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {einvoice.irn ? (
                  <p>IRN <span className="font-mono">{einvoice.irn}</span> · {einvoice.irnStatus ?? "—"}</p>
                ) : (
                  <p className="text-muted">Not registered. Registration needs an e-invoice provider configured for this company.</p>
                )}
                {einvoice.ready ? (
                  <p className="text-success">The payload passes the local checks.</p>
                ) : (
                  <div>
                    <p className="font-medium">Fix before registering:</p>
                    <ul className="list-disc pl-5 text-muted">
                      {einvoice.errors.map((e) => <li key={e}>{e}</li>)}
                    </ul>
                  </div>
                )}
                <details>
                  <summary className="cursor-pointer text-primary">Payload preview</summary>
                  <pre className="mt-2 max-h-80 overflow-auto rounded-xl bg-slate-50 p-3 text-2xs">{JSON.stringify(einvoice.payload, null, 2)}</pre>
                </details>
                {!einvoice.irn && can(ctx, "invoice.post") ? <ActionButton path={a("einvoice")} label="Register e-invoice" /> : null}
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
                  <dd className="flex flex-wrap gap-x-2">
                    <Link href={`/crm/customers/${inv.customerId}`} className="text-primary hover:underline">{inv.customer.name}</Link>
                    {can(ctx, "finance.report") ? (
                      <Link href={`/finance/statements/customers/${inv.customerId}?companyId=${inv.companyId}`} className="text-primary hover:underline">Statement</Link>
                    ) : null}
                  </dd>
                </div>
                <div><dt className="text-subtle">Company / branch</dt><dd>{inv.company.code} · {inv.branch.name}</dd></div>
                <div><dt className="text-subtle">Seller GSTIN</dt><dd>{inv.sellerGstin ?? "—"}</dd></div>
                <div><dt className="text-subtle">Customer GSTIN</dt><dd>{inv.customerGstin ?? "Unregistered"}</dd></div>
                <div><dt className="text-subtle">Place of supply</dt><dd>{pos ? `${pos} · ${GST_STATES[pos] ?? "unknown state"}` : "—"}</dd></div>
                <div><dt className="text-subtle">Invoice / due date</dt><dd>{formatDate(inv.invoiceDate)} → {formatDate(inv.dueDate)}</dd></div>
                {inv.salesOrder ? (
                  <div><dt className="text-subtle">Sales order</dt><dd><Link href={`/sales/orders/${inv.salesOrder.id}`} className="text-primary hover:underline">{inv.salesOrder.number}</Link></dd></div>
                ) : null}
                {s === "POSTED" ? (
                  <>
                    <div><dt className="text-subtle">Paid / credited</dt><dd>{formatMoney(inv.paidAmount, cur)} / {formatMoney(inv.creditedAmount, cur)}</dd></div>
                    <div><dt className="text-subtle">Outstanding</dt><dd className="font-semibold">{formatMoney(inv.outstanding, cur)}</dd></div>
                  </>
                ) : null}
                {inv.postedAt ? <div><dt className="text-subtle">Posted</dt><dd>{formatDateTime(inv.postedAt)}</dd></div> : null}
                {inv.journalEntryId ? (
                  <div><dt className="text-subtle">Journal</dt><dd><Link href={`/finance/journals/${inv.journalEntryId}`} className="text-primary hover:underline">View journal</Link></dd></div>
                ) : s === "POSTED" ? (
                  <div><dt className="text-subtle">Journal</dt><dd className="text-muted">None (before the accounting start date or finance not set up)</dd></div>
                ) : null}
              </dl>
            </CardContent>
          </Card>

          {s !== "DRAFT" ? (
            <Card>
              <CardHeader><CardTitle>Settlement</CardTitle></CardHeader>
              <CardContent className="space-y-3 text-sm">
                {inv.allocations.length === 0 ? <p className="text-muted">No receipts or credit notes applied.</p> : (
                  <ul className="space-y-1">
                    {inv.allocations.map((al) => (
                      <li key={al.id} className="flex flex-wrap items-center justify-between gap-2">
                        {al.receipt ? (
                          <Link href={`/finance/receipts/${al.receipt.id}`} className="text-primary hover:underline">Receipt {al.receipt.number ?? ""}</Link>
                        ) : al.creditNote ? (
                          <Link href={`/finance/credit-notes/${al.creditNote.id}`} className="text-primary hover:underline">Credit note {al.creditNote.number ?? ""}</Link>
                        ) : <span>—</span>}
                        <span className="text-2xs text-subtle">{formatDate(al.receipt?.receiptDate ?? al.createdAt)}</span>
                        <span className="font-medium">{formatMoney(al.amount, cur)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {inv.creditNotes.length ? (
                  <div className="border-t border-[var(--ic-border)] pt-3">
                    <p className="mb-1 text-subtle">Credit notes</p>
                    <ul className="space-y-1">
                      {inv.creditNotes.map((n) => (
                        <li key={n.id} className="flex flex-wrap items-center gap-2">
                          <Link href={`/finance/credit-notes/${n.id}`} className="text-primary hover:underline">{n.number ?? "Draft"}</Link>
                          <StatusBadge status={n.status} />
                          <span className="text-muted">{formatMoney(n.grandTotal, cur)}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="sales_invoice" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
