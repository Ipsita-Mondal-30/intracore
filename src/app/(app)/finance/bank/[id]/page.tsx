import Link from "next/link";
import { notFound } from "next/navigation";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext } from "@/lib/access";
import { getCashbook, listBankTransactions } from "@/features/finance/bank";
import { BankImportForm } from "@/features/finance/bank-import-form";
import { ReconcileRow } from "@/features/finance/reconcile-row";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ActionButton } from "@/components/erp/action-button";
import { param } from "@/components/erp/list-controls";
import { formatDate, formatMoney, humanize } from "@/components/erp/format";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const TXN_STATUSES = ["UNRECONCILED", "RECONCILED", "IGNORED"] as const;
const th = "py-2 pr-2";

export default async function BankAccountPage({ params, searchParams }: Props) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await getAccessContext();
  if (!can(ctx, "finance.view")) notFound();
  const from = param(sp, "from") || undefined;
  const to = param(sp, "to") || undefined;
  const statusParam = param(sp, "status");
  const status = TXN_STATUSES.find((s) => s === statusParam);

  const [book, txns] = await Promise.all([getCashbook(ctx, id, { from, to }), listBankTransactions(ctx, id, { status, from, to })]).catch((e) => {
    if (isAppError(e) && e.status === 404) notFound();
    throw e;
  });
  const canPost = can(ctx, "finance.post");

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Finance", "Bank & cash", book.bankAccount.name]}
        title={book.bankAccount.name}
        subtitle={`${humanize(book.bankAccount.kind)} · ledger ${book.bankAccount.ledger}`}
        actions={<Link href="/finance/bank" className="text-sm text-primary hover:underline">All accounts</Link>}
      />

      <form method="get" className="flex flex-wrap items-center gap-2">
        <Input type="date" name="from" defaultValue={from ?? ""} aria-label="From" className="w-auto" />
        <Input type="date" name="to" defaultValue={to ?? ""} aria-label="To" className="w-auto" />
        <Select name="status" defaultValue={status ?? ""} aria-label="Statement line status" className="w-auto">
          <option value="">Statement lines: all</option>
          {TXN_STATUSES.map((s) => <option key={s} value={s}>{humanize(s)}</option>)}
        </Select>
        <Button type="submit" size="sm" variant="secondary">Apply</Button>
      </form>

      <Card>
        <CardHeader>
          <CardTitle>Cashbook</CardTitle>
          <span className="text-sm text-muted">Opening {formatMoney(book.openingBalance)} · Closing <strong className="text-foreground">{formatMoney(book.closingBalance)}</strong></span>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                <tr className="border-b border-[var(--ic-border)]">
                  <th className={th}>Date</th><th className={th}>Journal</th><th className={th}>Source</th><th className={th}>Memo</th>
                  <th className={`${th} text-right`}>Money in</th><th className={`${th} text-right`}>Money out</th><th className={`${th} text-right`}>Balance</th><th className="py-2">Reconciled</th>
                </tr>
              </thead>
              <tbody>
                {book.lines.length === 0 ? <tr><td colSpan={8} className="py-6 text-center text-muted">No ledger movements in this range.</td></tr> : null}
                {book.lines.map((l) => (
                  <tr key={l.id} className="border-b border-[var(--ic-border)] last:border-0">
                    <td className={th}>{formatDate(l.date)}</td>
                    <td className={th}>{l.journal ? <Link href={`/finance/journals?q=${encodeURIComponent(l.journal)}`} className="text-primary hover:underline">{l.journal}</Link> : "—"}</td>
                    <td className={th}>{humanize(l.sourceType)}</td>
                    <td className={`${th} max-w-xs truncate`}>{l.memo ?? "—"}</td>
                    <td className={`${th} text-right`}>{Number(l.moneyIn) ? formatMoney(l.moneyIn) : ""}</td>
                    <td className={`${th} text-right`}>{Number(l.moneyOut) ? formatMoney(l.moneyOut) : ""}</td>
                    <td className={`${th} text-right font-medium`}>{formatMoney(l.balance)}</td>
                    <td className="py-2">{l.reconciled ? <span className="text-success" aria-label="Reconciled">✓</span> : <span className="text-subtle" aria-label="Not reconciled">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {canPost ? (
        <Card>
          <CardHeader><CardTitle>Manual statement import</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted">This account is not connected to the bank. Upload a CSV statement to bring in lines for reconciliation.</p>
            <BankImportForm bankAccountId={id} />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle>Statement lines</CardTitle><span className="text-2xs text-subtle">From manual imports · latest 500</span></CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                <tr className="border-b border-[var(--ic-border)]">
                  <th className={th}>Date</th><th className={th}>Description</th><th className={th}>Reference</th><th className={`${th} text-right`}>Amount</th><th className={th}>Status</th><th className="py-2">Match</th>
                </tr>
              </thead>
              <tbody>
                {txns.length === 0 ? <tr><td colSpan={6} className="py-6 text-center text-muted">No statement lines{status ? " with this status" : ""}. Import a statement to start reconciling.</td></tr> : null}
                {txns.map((t) => (
                  <tr key={t.id} className="border-b border-[var(--ic-border)] align-top last:border-0">
                    <td className={th}>{formatDate(t.txnDate)}</td>
                    <td className={th}>{t.description}</td>
                    <td className={th}>{t.reference ?? "—"}</td>
                    <td className={`${th} text-right ${Number(t.amount) < 0 ? "text-danger" : "text-success"}`}>{formatMoney(t.amount)}</td>
                    <td className={th}>
                      <Badge tone={t.status === "RECONCILED" ? "success" : t.status === "IGNORED" ? "neutral" : "warning"}>{humanize(t.status)}</Badge>
                    </td>
                    <td className="py-2">
                      {t.status === "RECONCILED" ? (
                        <div className="flex flex-wrap items-center gap-2">
                          {t.matchedLine ? (
                            <Link href={`/finance/journals/${t.matchedLine.entry.id}`} className="text-primary hover:underline">{t.matchedLine.entry.number ?? "journal"}</Link>
                          ) : null}
                          {canPost ? <ActionButton path={`/bank-transactions/${t.id}/unreconcile`} label="Unreconcile" variant="ghost" confirm="Remove this match?" /> : null}
                        </div>
                      ) : t.status === "UNRECONCILED" && canPost ? (
                        <ReconcileRow transactionId={t.id} />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
