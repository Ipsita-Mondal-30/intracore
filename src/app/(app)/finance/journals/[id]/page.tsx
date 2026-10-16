import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getJournal } from "@/features/finance/journals";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ActionButton } from "@/components/erp/action-button";
import { StatusBadge } from "@/components/erp/status-badge";
import { AuditTrail } from "@/components/erp/document-view";
import { formatDate, formatDateTime, formatMoney, humanize } from "@/components/erp/format";

const SOURCE_PATHS: Record<string, string> = {
  SALES_INVOICE: "/finance/invoices",
  CREDIT_NOTE: "/finance/credit-notes",
  RECEIPT: "/finance/receipts",
  VENDOR_BILL: "/purchasing/bills",
  DEBIT_NOTE: "/finance/debit-notes",
  VENDOR_PAYMENT: "/finance/payments",
  STOCK_ENTRY: "/inventory/entries",
  EXPENSE_CLAIM: "/finance/expenses",
};

export default async function JournalPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAccessContext();
  if (!can(ctx, "finance.view")) notFound();
  const j = await getJournal(ctx, id).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const manual = j.sourceType === "MANUAL";
  const canPost = can(ctx, "finance.post") && ctx.companies.get(j.companyId) === "all";
  const sourcePath = SOURCE_PATHS[j.sourceType];
  const title = j.number ?? "Draft journal";

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Finance", "Journals", title]}
        title={title}
        subtitle={j.memo ?? undefined}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={j.status} />
            {manual && j.status === "DRAFT" && canPost ? (
              <>
                <ActionButton path={`/journals/${id}/post`} label="Post" variant="default" confirm="Post this journal? Posted journals cannot be edited, only reversed." />
                <ActionButton path={`/journals/${id}`} method="DELETE" label="Delete" variant="ghost" confirm="Delete this draft journal?" redirectTo="/finance/journals" />
              </>
            ) : null}
            {manual && j.status === "POSTED" && canPost ? (
              <ActionButton path={`/journals/${id}/reverse`} label="Reverse" prompt="Reason for reversing" confirm="Post an equal and opposite journal dated today?" redirectTo="/finance/journals/:id" />
            ) : null}
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Lines</CardTitle>
              {j.balanced ? <Badge tone="success">Balanced</Badge> : <Badge tone="danger">Out of balance</Badge>}
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[560px] text-sm">
                  <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                    <tr className="border-b border-[var(--ic-border)]">
                      <th className="py-2 pr-2">Account</th>
                      <th className="py-2 pr-2">Description</th>
                      <th className="py-2 pr-2 text-right">Debit</th>
                      <th className="py-2 text-right">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {j.lines.map((l) => (
                      <tr key={l.id} className="border-b border-[var(--ic-border)]">
                        <td className="py-2 pr-2"><span className="font-mono text-xs">{l.account.code}</span> {l.account.name}</td>
                        <td className="py-2 pr-2 text-muted">{l.description ?? "—"}</td>
                        <td className="py-2 pr-2 text-right">{Number(l.debit) ? formatMoney(l.debit) : ""}</td>
                        <td className="py-2 text-right">{Number(l.credit) ? formatMoney(l.credit) : ""}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="font-semibold">
                      <td className="py-2 pr-2" colSpan={2}>Total</td>
                      <td className="py-2 pr-2 text-right">{formatMoney(j.totalDebit)}</td>
                      <td className="py-2 text-right">{formatMoney(j.totalCredit)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader><CardTitle>Details</CardTitle></CardHeader>
            <CardContent>
              <dl className="space-y-2 text-sm">
                <div><dt className="text-subtle">Date</dt><dd>{formatDate(j.date)}</dd></div>
                <div><dt className="text-subtle">Period</dt><dd>{j.period ? `${j.period.name}${j.period.status === "CLOSED" ? " (closed)" : ""}` : "Assigned on posting"}</dd></div>
                <div>
                  <dt className="text-subtle">Source</dt>
                  <dd>
                    {humanize(j.sourceType)}
                    {sourcePath && j.sourceId ? (
                      <> · <Link href={`${sourcePath}/${j.sourceId}`} className="text-primary hover:underline">Open document</Link></>
                    ) : null}
                  </dd>
                </div>
                {j.postedAt ? <div><dt className="text-subtle">Posted</dt><dd>{formatDateTime(j.postedAt)}</dd></div> : null}
                {j.reversalOf ? (
                  <div>
                    <dt className="text-subtle">Reverses</dt>
                    <dd><Link href={`/finance/journals/${j.reversalOf.id}`} className="text-primary hover:underline">{j.reversalOf.number ?? "journal"}</Link></dd>
                  </div>
                ) : null}
                {j.reversedBy ? (
                  <div>
                    <dt className="text-subtle">Reversed by</dt>
                    <dd><Link href={`/finance/journals/${j.reversedBy.id}`} className="text-primary hover:underline">{j.reversedBy.number ?? "journal"}</Link></dd>
                  </div>
                ) : null}
                {!manual && j.status === "POSTED" ? (
                  <p className="text-2xs text-subtle">System journals are reversed by cancelling their source document.</p>
                ) : null}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>History</CardTitle></CardHeader>
            <CardContent><AuditTrail ctx={ctx} entity="journal_entry" entityId={id} /></CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
