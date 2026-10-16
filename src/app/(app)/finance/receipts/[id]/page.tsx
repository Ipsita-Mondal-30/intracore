import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getReceipt, outstanding } from "@/features/finance/receivables";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDate, formatDateTime, formatMoney, humanize } from "@/components/erp/format";

export default async function ReceiptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const r = await getReceipt(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const s = r.status;
  const cur = r.bankAccount.currency;
  const unallocated = Number(r.unallocated);
  const canAllocate = s === "POSTED" && unallocated > 0 && can(ctx, "receipt.create") && can(ctx, "invoice.view");
  const active = r.allocations.filter((a) => !a.reversedAt);
  const reversed = r.allocations.filter((a) => a.reversedAt);

  const openInvoices = canAllocate
    ? (
        await prisma.salesInvoice.findMany({
          where: { organizationId: ctx.organizationId, companyId: r.companyId, customerId: r.customerId, status: "POSTED" },
          orderBy: { dueDate: "asc" },
          take: 200,
        })
      )
        .map((i) => ({ id: i.id, number: i.number, dueDate: i.dueDate, outstanding: outstanding(i) }))
        .filter((i) => i.outstanding.gt(0))
    : [];

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Finance", "Receipts", r.number ?? "Receipt"]}
        title={r.number ?? "Receipt"}
        subtitle={`${r.customer.name} · ${formatMoney(r.amount, cur)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={s} />
            {s === "POSTED" && can(ctx, "receipt.cancel") ? (
              <ActionButton
                path={`/receipts/${id}/cancel`}
                label="Cancel"
                variant="ghost"
                prompt="Reason for cancelling"
                promptField="reason"
                confirm={`Cancel this receipt? Its allocations are reversed (the invoices become due again) and its journal reversed (dated today).${r.reconciled ? " It is matched to a bank statement line." : ""}`}
              />
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {s === "CANCELLED" ? (
            <p className="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger">
              Cancelled {formatDate(r.cancelledAt)}{r.cancelReason ? `: “${r.cancelReason}”` : ""}
            </p>
          ) : null}

          <Card>
            <CardHeader><CardTitle>Allocations</CardTitle></CardHeader>
            <CardContent className="space-y-3 text-sm">
              {active.length === 0 ? <p className="text-muted">Not allocated to any invoice.</p> : (
                <ul className="space-y-1">
                  {active.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-2">
                      <Link href={`/finance/invoices/${a.invoice.id}`} className="text-primary hover:underline">{a.invoice.number ?? "Invoice"}</Link>
                      <span className="text-2xs text-subtle">{formatDate(a.createdAt)}</span>
                      <span className="font-medium">{formatMoney(a.amount, cur)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {reversed.length ? (
                <p className="text-2xs text-subtle">{reversed.length} reversed allocation{reversed.length > 1 ? "s" : ""} not shown.</p>
              ) : null}
              <dl className="ml-auto w-full max-w-xs space-y-1 border-t border-[var(--ic-border)] pt-2">
                <div className="flex justify-between text-muted"><dt>Amount</dt><dd>{formatMoney(r.amount, cur)}</dd></div>
                <div className="flex justify-between text-muted"><dt>Allocated</dt><dd>{formatMoney(r.allocatedAmount, cur)}</dd></div>
                <div className="flex justify-between font-semibold"><dt>Unallocated</dt><dd>{formatMoney(r.unallocated, cur)}</dd></div>
              </dl>
            </CardContent>
          </Card>

          {canAllocate ? (
            <Card>
              <CardHeader><CardTitle>Allocate remaining</CardTitle></CardHeader>
              <CardContent>
                {openInvoices.length === 0 ? (
                  <p className="text-sm text-muted">This customer has no posted invoices with a balance in this company. The unallocated amount stays as on-account credit.</p>
                ) : (
                  <ApiForm path="/receivable-allocations" extra={{ receiptId: id }} submitLabel="Allocate" successMessage="Allocated" className="grid gap-3 sm:grid-cols-3">
                    <Field label="Invoice" className="sm:col-span-2">
                      <Select name="allocations.0.invoiceId" required>
                        {openInvoices.map((i) => (
                          <option key={i.id} value={i.id}>{i.number} · due {formatDate(i.dueDate)} · outstanding {formatMoney(i.outstanding.toString(), cur)}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Amount" hint={`Up to ${formatMoney(r.unallocated, cur)}`}>
                      <Input type="number" name="allocations.0.amount" min="0.01" step="0.01" max={r.unallocated} defaultValue={r.unallocated} required />
                    </Field>
                  </ApiForm>
                )}
              </CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div><dt className="text-subtle">Customer</dt><dd><Link href={`/crm/customers/${r.customerId}`} className="text-primary hover:underline">{r.customer.name}</Link></dd></div>
                <div><dt className="text-subtle">Receipt date</dt><dd>{formatDate(r.receiptDate)}</dd></div>
                <div><dt className="text-subtle">Received into</dt><dd>{r.bankAccount.name}</dd></div>
                <div><dt className="text-subtle">Method</dt><dd>{humanize(r.method)}</dd></div>
                <div><dt className="text-subtle">Reference</dt><dd>{r.reference ?? "—"}</dd></div>
                {r.notes ? <div><dt className="text-subtle">Notes</dt><dd className="whitespace-pre-line">{r.notes}</dd></div> : null}
                <div><dt className="text-subtle">Bank reconciliation</dt><dd>{r.reconciled ? "Matched to a statement line" : "Not reconciled"}</dd></div>
                {r.postedAt ? <div><dt className="text-subtle">Posted</dt><dd>{formatDateTime(r.postedAt)}</dd></div> : null}
                {r.journalEntryId ? (
                  <div><dt className="text-subtle">Journal</dt><dd><Link href={`/finance/journals/${r.journalEntryId}`} className="text-primary hover:underline">View journal</Link></dd></div>
                ) : null}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="payment_receipt" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
