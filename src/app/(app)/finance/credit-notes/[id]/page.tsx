import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { dec } from "@/lib/money";
import { can, getAccessContext } from "@/lib/access";
import { getCreditNote, outstanding } from "@/features/finance/receivables";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail, DocumentLines, DocumentTotals } from "@/components/erp/document-view";
import { formatDate, formatDateTime, formatMoney } from "@/components/erp/format";

export default async function CreditNotePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  const note = await getCreditNote(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const s = note.status;
  const cur = note.company.baseCurrency;
  const unapplied = dec(note.grandTotal).sub(note.appliedAmount);
  const canApply = s === "POSTED" && unapplied.gt(0) && can(ctx, "invoice.post");

  const [allocations, openInvoices] = await Promise.all([
    prisma.receivableAllocation.findMany({
      where: { organizationId: ctx.organizationId, creditNoteId: id, reversedAt: null },
      include: { invoice: { select: { id: true, number: true } } },
      orderBy: { createdAt: "asc" },
    }),
    canApply
      ? prisma.salesInvoice
          .findMany({
            where: { organizationId: ctx.organizationId, companyId: note.companyId, customerId: note.customerId, status: "POSTED" },
            orderBy: { dueDate: "asc" },
            take: 200,
          })
          .then((rows) => rows.map((i) => ({ id: i.id, number: i.number, dueDate: i.dueDate, outstanding: outstanding(i) })).filter((i) => i.outstanding.gt(0)))
      : [],
  ]);
  const lines = note.lines.map((l) => ({ ...l, product: l.hsnCode ? { sku: "", hsnCode: l.hsnCode } : null }));
  const a = (action: string) => `/credit-notes/${id}/${action}`;

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Finance", "Credit notes", note.number ?? "Draft"]}
        title={note.number ?? "Draft credit note"}
        subtitle={`${note.customer.name} · ${note.company.code} · ${note.branch.name}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={s} />
            {s === "DRAFT" && can(ctx, "invoice.post") ? (
              <ActionButton path={a("post")} label="Post" variant="default" confirm="Post this credit note? It gets its number, the journal is written and it is applied to the invoice's balance." />
            ) : null}
            {s !== "CANCELLED" && can(ctx, "invoice.cancel") ? (
              <ActionButton
                path={a("cancel")}
                label="Cancel"
                variant="ghost"
                prompt="Reason for cancelling"
                promptField="reason"
                confirm={s === "POSTED" ? "Cancel this credit note? Its applications are reversed and its journal reversed (dated today)." : "Cancel this draft credit note?"}
              />
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {s === "CANCELLED" ? (
            <p className="rounded-xl bg-danger-soft px-3 py-2 text-sm text-danger">
              Cancelled {formatDate(note.cancelledAt)}{note.cancelReason ? `: “${note.cancelReason}”` : ""}
            </p>
          ) : null}
          <Card>
            <CardHeader><CardTitle>Lines</CardTitle></CardHeader>
            <CardContent>
              {lines.length === 0 ? <p className="text-sm text-muted">No lines.</p> : <DocumentLines lines={lines} currency={cur} />}
              <DocumentTotals doc={note} currency={cur} />
            </CardContent>
          </Card>

          {canApply ? (
            <Card>
              <CardHeader><CardTitle>Apply remaining credit</CardTitle></CardHeader>
              <CardContent>
                {openInvoices.length === 0 ? (
                  <p className="text-sm text-muted">This customer has no other posted invoices with a balance in {note.company.code}. The remaining {formatMoney(unapplied.toString(), cur)} stays as customer credit.</p>
                ) : (
                  <ApiForm path="/receivable-allocations" extra={{ creditNoteId: id }} submitLabel="Apply credit" successMessage="Credit applied" className="grid gap-3 sm:grid-cols-3">
                    <Field label="Invoice" className="sm:col-span-2">
                      <Select name="allocations.0.invoiceId" required>
                        {openInvoices.map((i) => (
                          <option key={i.id} value={i.id}>{i.number} · due {formatDate(i.dueDate)} · outstanding {formatMoney(i.outstanding.toString(), cur)}</option>
                        ))}
                      </Select>
                    </Field>
                    <Field label="Amount" hint={`Up to ${formatMoney(unapplied.toString(), cur)}`}>
                      <Input type="number" name="allocations.0.amount" min="0.01" step="0.01" max={unapplied.toFixed(2)} defaultValue={unapplied.toFixed(2)} required />
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
                <div><dt className="text-subtle">Customer</dt><dd><Link href={`/crm/customers/${note.customerId}`} className="text-primary hover:underline">{note.customer.name}</Link></dd></div>
                <div><dt className="text-subtle">Invoice</dt><dd><Link href={`/finance/invoices/${note.invoice.id}`} className="text-primary hover:underline">{note.invoice.number ?? "Draft"}</Link></dd></div>
                <div><dt className="text-subtle">Note date</dt><dd>{formatDate(note.noteDate)}</dd></div>
                <div><dt className="text-subtle">Reason</dt><dd className="whitespace-pre-line">{note.reason}</dd></div>
                {s === "POSTED" ? (
                  <>
                    <div><dt className="text-subtle">Applied</dt><dd>{formatMoney(note.appliedAmount, cur)}</dd></div>
                    <div><dt className="text-subtle">Unapplied (customer credit)</dt><dd className="font-semibold">{formatMoney(unapplied.toString(), cur)}</dd></div>
                  </>
                ) : null}
                {note.postedAt ? <div><dt className="text-subtle">Posted</dt><dd>{formatDateTime(note.postedAt)}</dd></div> : null}
                {note.journalEntryId ? (
                  <div><dt className="text-subtle">Journal</dt><dd><Link href={`/finance/journals/${note.journalEntryId}`} className="text-primary hover:underline">View journal</Link></dd></div>
                ) : null}
              </dl>
            </CardContent>
          </Card>

          {s === "POSTED" ? (
            <Card>
              <CardHeader><CardTitle>Applied to</CardTitle></CardHeader>
              <CardContent>
                {allocations.length === 0 ? <p className="text-sm text-muted">Not applied to any invoice.</p> : (
                  <ul className="space-y-1 text-sm">
                    {allocations.map((al) => (
                      <li key={al.id} className="flex items-center justify-between gap-2">
                        <Link href={`/finance/invoices/${al.invoice.id}`} className="text-primary hover:underline">{al.invoice.number ?? "Invoice"}</Link>
                        <span className="text-2xs text-subtle">{formatDate(al.createdAt)}</span>
                        <span className="font-medium">{formatMoney(al.amount, cur)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="credit_note" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
