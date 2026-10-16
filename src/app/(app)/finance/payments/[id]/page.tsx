import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { dec } from "@/lib/money";
import { can, companyScopeWhere, getAccessContext } from "@/lib/access";
import { billOutstanding, getVendorPayment } from "@/features/finance/payables";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ApiForm } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDate, formatDateTime, formatMoney, humanize } from "@/components/erp/format";

export default async function VendorPaymentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "payment.view")) {
    return (
      <div className="space-y-4">
        <PageHeader breadcrumbs={["Finance", "Vendor payments"]} title="Vendor payment" />
        <p className="text-sm text-muted">You don&apos;t have permission to view vendor payments.</p>
      </div>
    );
  }
  const p = await getVendorPayment(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const unallocated = dec(p.unallocated);
  const canAllocate = p.status === "POSTED" && unallocated.gt(0) && can(ctx, "payment.create");
  const openBills = canAllocate
    ? (await prisma.vendorBill.findMany({ where: { AND: [companyScopeWhere(ctx), { companyId: p.companyId, vendorId: p.vendorId, status: "POSTED" }] }, orderBy: { billDate: "asc" }, take: 200 }))
        .map((b) => ({ b, due: billOutstanding(b) }))
        .filter(({ due }) => due.gt(0))
    : [];

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Finance", "Vendor payments", p.number ?? "Draft"]}
        title={p.number ?? "Vendor payment"}
        subtitle={`${p.vendor.name} · ${formatMoney(p.amount)} · ${formatDate(p.paymentDate)}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={p.status} />
            {p.status === "POSTED" && can(ctx, "payment.cancel") ? (
              <ActionButton path={`/vendor-payments/${id}/cancel`} label="Cancel" variant="ghost" prompt="Reason for cancelling" promptField="reason" confirm="Cancel this payment? Its allocations and journal are reversed." />
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader><CardTitle>Allocations</CardTitle></CardHeader>
            <CardContent>
              {p.allocations.length === 0 ? (
                <p className="text-sm text-muted">Not allocated to any bill.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                    <tr className="border-b border-[var(--ic-border)]">
                      <th className="py-2 pr-2">Bill</th>
                      <th className="py-2 pr-2">Allocated</th>
                      <th className="py-2 text-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {p.allocations.map((a) => (
                      <tr key={a.id} className={`border-b border-[var(--ic-border)] last:border-0 ${a.reversedAt ? "text-subtle line-through" : ""}`}>
                        <td className="py-2 pr-2">
                          <Link href={`/purchasing/bills/${a.bill.id}`} className="text-primary hover:underline">{a.bill.number}</Link>
                          <span className="text-2xs text-subtle"> · {a.bill.vendorInvoiceNumber}</span>
                        </td>
                        <td className="py-2 pr-2">{formatDateTime(a.createdAt)}{a.reversedAt ? ` · reversed ${formatDateTime(a.reversedAt)}` : ""}</td>
                        <td className="py-2 text-right">{formatMoney(a.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </CardContent>
          </Card>

          {canAllocate ? (
            <Card>
              <CardHeader><CardTitle>Allocate remaining {formatMoney(p.unallocated)}</CardTitle></CardHeader>
              <CardContent>
                {openBills.length === 0 ? (
                  <p className="text-sm text-muted">This vendor has no open posted bills in this company. The balance stays as an advance.</p>
                ) : (
                  <ul className="space-y-3">
                    {openBills.map(({ b, due }) => (
                      <li key={b.id}>
                        <ApiForm path="/payable-allocations" extra={{ paymentId: id }} submitLabel="Apply" successMessage="Allocated" className="flex flex-wrap items-end gap-3 space-y-0">
                          <input type="hidden" name="allocations.0.billId" value={b.id} />
                          <div className="min-w-48 text-sm">
                            <Link href={`/purchasing/bills/${b.id}`} className="font-medium text-primary hover:underline">{b.number}</Link>
                            <p className="text-2xs text-subtle">Invoice {b.vendorInvoiceNumber} · outstanding {formatMoney(due.toString())}</p>
                          </div>
                          <Input
                            type="number"
                            name="allocations.0.amount"
                            min="0.01"
                            step="0.01"
                            max={Math.min(due.toNumber(), unallocated.toNumber())}
                            defaultValue={(due.lt(unallocated) ? due : unallocated).toFixed(2)}
                            required
                            className="w-36"
                            aria-label={`Amount for ${b.number}`}
                          />
                        </ApiForm>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ) : null}

          {p.notes ? (
            <Card>
              <CardHeader><CardTitle>Notes</CardTitle></CardHeader>
              <CardContent><p className="whitespace-pre-line text-sm">{p.notes}</p></CardContent>
            </Card>
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div>
                  <dt className="text-subtle">Vendor</dt>
                  <dd><Link href={`/purchasing/vendors/${p.vendorId}`} className="text-primary hover:underline">{p.vendor.name}</Link></dd>
                </div>
                <div><dt className="text-subtle">Paid from</dt><dd>{p.bankAccount.name}</dd></div>
                <div><dt className="text-subtle">Method / reference</dt><dd>{humanize(p.method)} · {p.reference ?? "—"}</dd></div>
                <div><dt className="text-subtle">Amount</dt><dd>{formatMoney(p.amount)}</dd></div>
                <div><dt className="text-subtle">Allocated / unallocated</dt><dd>{formatMoney(p.allocatedAmount)} / {formatMoney(p.unallocated)}</dd></div>
                <div><dt className="text-subtle">Bank reconciled</dt><dd>{p.reconciled ? "Yes" : "No"}</dd></div>
                {p.journalEntryId ? (
                  <div><dt className="text-subtle">Journal</dt><dd><Link href={`/finance/journals/${p.journalEntryId}`} className="text-primary hover:underline">View journal</Link></dd></div>
                ) : null}
                {p.postedAt ? <div><dt className="text-subtle">Posted</dt><dd>{formatDateTime(p.postedAt)}</dd></div> : null}
                {p.cancelReason ? (
                  <div><dt className="text-subtle">Cancelled</dt><dd className="whitespace-pre-line">{formatDateTime(p.cancelledAt)} · {p.cancelReason}</dd></div>
                ) : null}
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="vendor_payment" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
