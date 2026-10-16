import { prisma } from "@/lib/db/prisma";
import { can, companyScopeWhere, getAccessContext } from "@/lib/access";
import { param } from "@/components/erp/list-controls";
import { loyaltyBalance, loyaltyStatement } from "@/features/marketing/loyalty";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { Pagination } from "@/components/erp/list-controls";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { formatDate, formatDateTime, formatMoney, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function LoyaltyPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = <PageHeader breadcrumbs={["Communication", "Loyalty"]} title="Loyalty points" subtitle="Points earned on posted invoices, redeemed, adjusted and expired. The ledger is append-only." />;
  if (!can(ctx, "loyalty.view")) {
    return <div className="space-y-4">{header}<p className="text-sm text-muted">You don&apos;t have permission to view loyalty points.</p></div>;
  }
  const customers = await prisma.customer.findMany({ where: { organizationId: ctx.organizationId, status: "ACTIVE" }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 1000 });
  const customerId = param(params, "customerId");
  const selected = customerId && customers.some((c) => c.id === customerId) ? customerId : null;
  const manage = can(ctx, "loyalty.manage");
  const [balance, statement, invoices] = selected
    ? await Promise.all([
        loyaltyBalance(ctx, selected),
        loyaltyStatement(ctx, selected, { page: param(params, "page"), pageSize: 25 }),
        manage
          ? prisma.salesInvoice.findMany({ where: { ...companyScopeWhere(ctx), customerId: selected, status: { in: ["POSTED", "CANCELLED"] } }, select: { id: true, number: true, status: true, grandTotal: true, invoiceDate: true }, orderBy: { invoiceDate: "desc" }, take: 20 })
          : [],
      ])
    : [null, null, []];
  const earned = new Set(
    selected ? (await prisma.loyaltyLedgerEntry.findMany({ where: { organizationId: ctx.organizationId, customerId: selected, sourceType: "SALES_INVOICE" }, select: { sourceId: true, kind: true } })).map((e) => `${e.kind}:${e.sourceId}`) : [],
  );

  return (
    <div className="space-y-4">
      {header}
      <Card>
        <CardContent className="pt-5">
          <form method="get" className="flex flex-wrap items-end gap-2">
            <Select name="customerId" defaultValue={selected ?? ""} className="max-w-xs" aria-label="Customer">
              <option value="">Choose a customer…</option>
              {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Button type="submit" size="sm" variant="secondary">Show</Button>
          </form>
        </CardContent>
      </Card>

      {balance && statement ? (
        <>
          <Card>
            <CardContent className="flex flex-wrap gap-6 pt-5 text-sm">
              <div><p className="text-2xs text-subtle">Balance</p><p className="text-2xl font-semibold">{balance.balance} pts</p></div>
              <div><p className="text-2xs text-subtle">Worth</p><p className="text-2xl font-semibold">{formatMoney(balance.value)}</p></div>
              <div className="text-xs text-muted">
                {balance.programme.enabled
                  ? `${balance.programme.pointsPerCurrencyUnit} pts per ₹1 · 1 pt = ${formatMoney(balance.programme.pointValue)} · redeem from ${balance.programme.minRedeemPoints} pts · ${balance.programme.expiryDays ? `expire after ${balance.programme.expiryDays} days` : "no expiry"}`
                  : "The loyalty programme is disabled (Settings). Balances stay visible; earning and redeeming are off."}
              </div>
            </CardContent>
          </Card>

          {manage && balance.programme.enabled ? (
            <div className="grid gap-4 lg:grid-cols-3">
              <Card>
                <CardHeader><CardTitle>Redeem</CardTitle></CardHeader>
                <CardContent>
                  <ApiForm path={`/loyalty/customers/${selected}/redeem`} submitLabel="Redeem" successMessage="Points redeemed" className="space-y-3">
                    <Field label="Points"><Input name="points" type="number" min={1} step={1} required /></Field>
                    <Field label="Reference" hint="Bill or order number; the same reference is never redeemed twice"><Input name="reference" maxLength={120} /></Field>
                  </ApiForm>
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Adjust</CardTitle></CardHeader>
                <CardContent>
                  <ApiForm path={`/loyalty/customers/${selected}/adjust`} submitLabel="Adjust" successMessage="Balance adjusted" className="space-y-3">
                    <Field label="Points (negative to deduct)"><Input name="points" type="number" step={1} required /></Field>
                    <Field label="Reason"><Input name="reason" required maxLength={500} /></Field>
                  </ApiForm>
                </CardContent>
              </Card>
              <Card>
                <CardHeader><CardTitle>Invoices</CardTitle></CardHeader>
                <CardContent>
                  {invoices.length === 0 ? <p className="text-sm text-muted">No posted invoices.</p> : (
                    <ul className="space-y-2 text-sm">
                      {invoices.map((inv) => (
                        <li key={inv.id} className="flex flex-wrap items-center justify-between gap-2">
                          <span>{inv.number ?? "—"} · {formatDate(inv.invoiceDate)} · {formatMoney(inv.grandTotal.toString())}</span>
                          {inv.status === "POSTED" && !earned.has(`EARN:${inv.id}`) ? <ActionButton path={`/loyalty/invoices/${inv.id}/earn`} label="Award points" /> : null}
                          {inv.status === "CANCELLED" && earned.has(`EARN:${inv.id}`) && !earned.has(`REVERSAL:${inv.id}`) ? <ActionButton path={`/loyalty/invoices/${inv.id}/reverse`} label="Reverse points" variant="ghost" /> : null}
                          {earned.has(`EARN:${inv.id}`) && inv.status === "POSTED" ? <span className="text-2xs text-subtle">Points awarded</span> : null}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          ) : null}

          <Card>
            <CardHeader><CardTitle>Statement</CardTitle></CardHeader>
            <CardContent>
              <RecordsTable
                columns={[{ key: "date", label: "Date" }, { key: "kind", label: "Type" }, { key: "points", label: "Points" }, { key: "balance", label: "Balance" }, { key: "reason", label: "Details" }, { key: "expires", label: "Expires" }]}
                empty="No loyalty activity."
              >
                {statement.items.length
                  ? statement.items.map((e) => (
                      <RecordsTableRow key={e.id}>
                        <RecordsTableCell>{formatDateTime(e.createdAt)}</RecordsTableCell>
                        <RecordsTableCell>{humanize(e.kind)}</RecordsTableCell>
                        <RecordsTableCell className={e.points < 0 ? "text-danger" : ""}>{e.points > 0 ? `+${e.points}` : e.points}</RecordsTableCell>
                        <RecordsTableCell>{e.balanceAfter}</RecordsTableCell>
                        <RecordsTableCell>{e.reason ?? "—"}</RecordsTableCell>
                        <RecordsTableCell>{formatDate(e.expiresAt)}</RecordsTableCell>
                      </RecordsTableRow>
                    ))
                  : undefined}
              </RecordsTable>
              <Pagination {...statement} params={params} basePath="/communication/loyalty" />
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
