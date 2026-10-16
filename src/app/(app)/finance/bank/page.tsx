import type { ReactNode } from "react";
import Link from "next/link";
import { can, getAccessContext } from "@/lib/access";
import { listCompanies } from "@/features/companies/service";
import { listBankAccounts } from "@/features/finance/setup";
import { getCashbook } from "@/features/finance/bank";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { RecordsTable, RecordsTableCell, RecordsTableRow } from "@/components/ui/records-table";
import { ApiForm, Field } from "@/components/erp/api-form";
import { param } from "@/components/erp/list-controls";
import { dateInput, formatMoney, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function BankPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const header = (actions?: ReactNode) => (
    <PageHeader breadcrumbs={["Finance", "Bank & cash"]} title="Bank & cash" subtitle="Ledger balances of bank and cash accounts. Statements are imported manually; there is no live bank feed." actions={actions} />
  );
  const companies = can(ctx, "finance.view") && can(ctx, "company.view") ? await listCompanies(ctx) : [];
  if (companies.length === 0) {
    return (
      <div className="space-y-4">
        {header()}
        <Card><CardContent className="pt-5 text-sm text-muted">{can(ctx, "finance.view") ? "You do not have access to any company yet." : "You don't have access to finance. Ask an administrator for the finance view permission."}</CardContent></Card>
      </div>
    );
  }
  const company = companies.find((c) => c.id === param(params, "companyId")) ?? companies[0];
  const banks = await listBankAccounts(ctx, company.id);
  const balances = new Map(await Promise.all(banks.map(async (b) => [b.id, (await getCashbook(ctx, b.id, {})).closingBalance] as const)));
  const active = banks.filter((b) => b.isActive);
  const canTransfer = can(ctx, "finance.post") && company.settings.finance.enabled && active.length >= 2;

  return (
    <div className="space-y-4">
      {header(
        <form method="get" className="flex items-center gap-2">
          <Select name="companyId" defaultValue={company.id} aria-label="Company" className="w-auto">
            {companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
          </Select>
          <Button type="submit" size="sm" variant="secondary">Switch</Button>
        </form>,
      )}

      {!company.settings.finance.enabled ? (
        <Card><CardContent className="pt-5 text-sm text-muted">Finance is not set up for {company.name}. <Link href={`/finance/setup?companyId=${company.id}`} className="text-primary hover:underline">Set it up</Link> to track bank and cash.</CardContent></Card>
      ) : null}

      <Card>
        <CardContent className="pt-5">
          <RecordsTable
            columns={[
              { key: "name", label: "Account" },
              { key: "kind", label: "Kind" },
              { key: "bank", label: "Bank" },
              { key: "ledger", label: "Ledger account" },
              { key: "balance", label: "Ledger balance", className: "text-right" },
            ]}
            empty={<>No bank or cash accounts yet. Add them under <Link href={`/finance/setup?companyId=${company.id}`} className="text-primary hover:underline">Finance setup</Link>.</>}
          >
            {banks.length
              ? banks.map((b) => (
                  <RecordsTableRow key={b.id}>
                    <RecordsTableCell>
                      <Link href={`/finance/bank/${b.id}`} className="font-medium text-primary hover:underline">{b.name}</Link>
                      {b.isActive ? null : <Badge tone="neutral" className="ml-2">Inactive</Badge>}
                    </RecordsTableCell>
                    <RecordsTableCell>{humanize(b.kind)}</RecordsTableCell>
                    <RecordsTableCell>{[b.bankName, b.accountNumberLast4 ? `••••${b.accountNumberLast4}` : null].filter(Boolean).join(" ") || "—"}</RecordsTableCell>
                    <RecordsTableCell>{b.account.code} · {b.account.name}</RecordsTableCell>
                    <RecordsTableCell className="text-right font-medium">{formatMoney(balances.get(b.id))}</RecordsTableCell>
                  </RecordsTableRow>
                ))
              : undefined}
          </RecordsTable>
        </CardContent>
      </Card>

      {canTransfer ? (
        <Card>
          <CardHeader><CardTitle>Transfer between accounts</CardTitle></CardHeader>
          <CardContent>
            <ApiForm path="/account-transfers" submitLabel="Post transfer" successMessage="Transfer posted" confirm="Post this transfer to the ledger?" className="grid gap-3 sm:grid-cols-5">
              <Field label="From">
                <Select name="fromBankAccountId" required>
                  {active.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Select>
              </Field>
              <Field label="To">
                <Select name="toBankAccountId" required defaultValue={active[1].id}>
                  {active.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Select>
              </Field>
              <Field label="Date"><Input type="date" name="transferDate" defaultValue={dateInput(new Date())} /></Field>
              <Field label="Amount"><Input name="amount" inputMode="decimal" pattern="\d+(\.\d{1,2})?" required /></Field>
              <Field label="Reference"><Input name="reference" placeholder="Optional" /></Field>
            </ApiForm>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
