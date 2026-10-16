import type { ReactNode } from "react";
import { prisma } from "@/lib/db/prisma";
import { can, getAccessContext } from "@/lib/access";
import { listCompanies } from "@/features/companies/service";
import { listAccounts, listBankAccounts, listFiscalYears } from "@/features/finance/setup";
import { MAPPING_KEYS, type MappingKey } from "@/features/finance/ledger";
import { listCatalogLookups } from "@/features/catalog/service";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ApiForm, Field } from "@/components/erp/api-form";
import { ActionButton } from "@/components/erp/action-button";
import { param } from "@/components/erp/list-controls";
import { StatusBadge } from "@/components/erp/status-badge";
import { dateInput, formatDate, formatQty, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"] as const;
const MONTHS = Array.from({ length: 12 }, (_, i) => new Date(Date.UTC(2000, i, 1)).toLocaleString("en-US", { month: "long", timeZone: "UTC" }));
const th = "py-2 pr-2";

function Message({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-4">
      <PageHeader breadcrumbs={["Finance", "Setup"]} title="Finance setup" />
      <Card><CardContent className="pt-5 text-sm text-muted">{children}</CardContent></Card>
    </div>
  );
}

export default async function FinanceSetupPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  if (!can(ctx, "finance.view")) return <Message>You don&apos;t have access to finance. Ask an administrator for the finance view permission.</Message>;

  const companies = can(ctx, "company.view") ? await listCompanies(ctx) : [];
  if (companies.length === 0) return <Message>You do not have access to any company yet.</Message>;
  const company = companies.find((c) => c.id === param(params, "companyId")) ?? companies[0];
  const finance = company.settings.finance;
  const admin = can(ctx, "finance.administer") && ctx.companies.get(company.id) === "all";

  const companySelect = (
    <form method="get" className="flex items-center gap-2">
      <Select name="companyId" defaultValue={company.id} aria-label="Company" className="w-auto">
        {companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
      </Select>
      <Button type="submit" size="sm" variant="secondary">Switch</Button>
    </form>
  );

  if (!finance.enabled) {
    return (
      <div className="space-y-4">
        <PageHeader breadcrumbs={["Finance", "Setup"]} title="Finance setup" subtitle={`${company.code} · ${company.name}`} actions={companySelect} />
        <Card>
          <CardHeader><CardTitle>Turn on accounting</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted">
              Accounting is not set up for this company yet. Setting it up creates the fiscal year containing the start date with monthly periods,
              and (optionally) a starter Indian chart of accounts with default mappings, a cash and a bank account, and expense categories.
            </p>
            <p className="rounded-xl bg-warning-soft px-3 py-2 text-sm text-warning">
              Documents dated before the accounting start date will not create journals. They stay operational only — record opening balances with a manual journal instead.
            </p>
            {admin ? (
              <ApiForm path={`/companies/${company.id}/finance/setup`} submitLabel="Set up finance" successMessage="Finance set up" confirm="Turn on accounting for this company? The start date cannot be changed here later." className="grid gap-3 sm:grid-cols-3">
                <Field label="Accounting start date"><Input type="date" name="accountingStartDate" required /></Field>
                <Field label="Fiscal year starts in" hint="April for Indian companies">
                  <Select name="fiscalYearStartMonth" defaultValue="4" data-json>
                    {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                  </Select>
                </Field>
                <label className="flex items-center gap-2 self-end pb-2 text-sm">
                  <input type="checkbox" name="seedChartOfAccounts" defaultChecked /> Create starter chart of accounts
                </label>
              </ApiForm>
            ) : (
              <p className="text-sm text-muted">Ask a finance administrator to set up accounting for this company.</p>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  const canTax = can(ctx, "catalog.administer") && can(ctx, "product.view");
  const [years, chart, banks, lookups, versions] = await Promise.all([
    listFiscalYears(ctx, company.id),
    listAccounts(ctx, company.id),
    listBankAccounts(ctx, company.id),
    canTax ? listCatalogLookups(ctx) : null,
    canTax ? prisma.taxRateVersion.findMany({ where: { organizationId: ctx.organizationId }, orderBy: { effectiveFrom: "asc" } }) : [],
  ]);
  const { accounts, mappings } = chart;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const posting = accounts.filter((a) => !a.isGroup && a.isActive);
  const groups = accounts.filter((a) => a.isGroup && a.isActive);
  const mapped = new Map(mappings.map((m) => [m.key, m.accountId]));
  const latestEnd = years[0]?.endDate;
  const nextYearDate = latestEnd ? dateInput(new Date(latestEnd.getTime() + 86_400_000)) : finance.accountingStartDate ?? "";

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Finance", "Setup"]}
        title="Finance setup"
        subtitle={`${company.code} · ${company.name} · accounting since ${formatDate(finance.accountingStartDate)} · fiscal year starts in ${MONTHS[finance.fiscalYearStartMonth - 1]}`}
        actions={companySelect}
      />

      <Card>
        <CardHeader><CardTitle>Fiscal years & periods</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          <p className="text-sm text-muted">Closed periods reject every posting. Close periods in order; reopening needs a reason.</p>
          {years.length === 0 ? <p className="text-sm text-muted">No fiscal years yet.</p> : null}
          {years.map((fy) => (
            <div key={fy.id}>
              <p className="mb-2 text-sm font-medium">{fy.name} <span className="text-2xs text-subtle">{formatDate(fy.startDate)} – {formatDate(fy.endDate)}</span></p>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[520px] text-sm">
                  <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                    <tr className="border-b border-[var(--ic-border)]"><th className={th}>Period</th><th className={th}>Dates</th><th className={th}>Status</th><th className="py-2" /></tr>
                  </thead>
                  <tbody>
                    {fy.periods.map((p) => (
                      <tr key={p.id} className="border-b border-[var(--ic-border)] last:border-0">
                        <td className={th}>{p.name}</td>
                        <td className={th}>{formatDate(p.startDate)} – {formatDate(p.endDate)}</td>
                        <td className={th}><StatusBadge status={p.status} />{p.closedAt ? <span className="ml-2 text-2xs text-subtle">{formatDate(p.closedAt)}</span> : null}</td>
                        <td className="py-2 text-right">
                          {admin ? (
                            p.status === "OPEN" ? (
                              <ActionButton path={`/accounting-periods/${p.id}`} method="PATCH" body={{ status: "CLOSED" }} label="Close" variant="ghost" confirm={`Close ${p.name}? No postings will be accepted in it.`} />
                            ) : (
                              <ActionButton path={`/accounting-periods/${p.id}`} method="PATCH" body={{ status: "OPEN" }} label="Reopen" variant="ghost" prompt={`Why reopen ${p.name}?`} />
                            )
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {admin ? (
            <ApiForm path={`/companies/${company.id}/fiscal-years`} submitLabel="Create fiscal year" successMessage="Fiscal year created" className="flex flex-wrap items-end gap-3">
              <Field label="Create next fiscal year" hint="Any date inside the new year"><Input type="date" name="containingDate" defaultValue={nextYearDate} required /></Field>
            </ApiForm>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Chart of accounts</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                <tr className="border-b border-[var(--ic-border)]"><th className={th}>Code</th><th className={th}>Name</th><th className={th}>Type</th><th className={th}>Group</th><th className={th}>Active</th><th className="py-2" /></tr>
              </thead>
              <tbody>
                {accounts.length === 0 ? <tr><td colSpan={6} className="py-6 text-center text-muted">No accounts yet.</td></tr> : null}
                {accounts.map((a) => (
                  <tr key={a.id} className="border-b border-[var(--ic-border)] last:border-0">
                    <td className={`${th} font-mono text-xs`}>{a.code}</td>
                    <td className={th}>
                      <span className={a.parentId ? "pl-4" : "font-medium"}>{a.name}</span>
                      {a.parentId ? <span className="ml-2 text-2xs text-subtle">in {byId.get(a.parentId)?.name}</span> : null}
                    </td>
                    <td className={th}>{humanize(a.type)}</td>
                    <td className={th}>{a.isGroup ? <Badge tone="neutral">Group</Badge> : "—"}</td>
                    <td className={th}>{a.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}</td>
                    <td className="py-2 text-right">
                      {admin ? (
                        <ActionButton
                          path={`/accounts/${a.id}`}
                          method="PATCH"
                          body={{ isActive: !a.isActive }}
                          label={a.isActive ? "Deactivate" : "Activate"}
                          variant="ghost"
                          confirm={a.isActive ? `Deactivate ${a.code} ${a.name}? It can no longer be used in new postings.` : undefined}
                        />
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {admin ? (
            <div>
              <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-subtle">New account</p>
              <ApiForm path={`/companies/${company.id}/accounts`} submitLabel="Create account" successMessage="Account created" className="grid gap-3 sm:grid-cols-5">
                <Field label="Code"><Input name="code" required placeholder="e.g. 5600" /></Field>
                <Field label="Name"><Input name="name" required /></Field>
                <Field label="Type">
                  <Select name="type" required>
                    {ACCOUNT_TYPES.map((t) => <option key={t} value={t}>{humanize(t)}</option>)}
                  </Select>
                </Field>
                <Field label="Parent group" hint="Must have the same type">
                  <Select name="parentId" defaultValue="">
                    <option value="">None</option>
                    {groups.map((g) => <option key={g.id} value={g.id}>{g.code} · {g.name} ({humanize(g.type)})</option>)}
                  </Select>
                </Field>
                <label className="flex items-center gap-2 self-end pb-2 text-sm">
                  <input type="checkbox" name="isGroup" /> Group (no postings)
                </label>
              </ApiForm>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Account mappings</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted">Which ledger account each automatic posting uses. Only active posting accounts of the required type can be chosen.</p>
          {admin ? (
            <ApiForm path={`/companies/${company.id}/account-mappings`} method="PUT" submitLabel="Save mappings" successMessage="Mappings saved" className="grid gap-3 sm:grid-cols-3">
              {(Object.keys(MAPPING_KEYS) as MappingKey[]).map((key) => (
                <Field key={key} label={humanize(key)} hint={`${humanize(MAPPING_KEYS[key])} account`}>
                  <Select name={`mappings.${key}`} defaultValue={mapped.get(key) ?? ""}>
                    <option value="">Not mapped</option>
                    {posting.filter((a) => a.type === MAPPING_KEYS[key]).map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                  </Select>
                </Field>
              ))}
            </ApiForm>
          ) : (
            <dl className="grid gap-2 text-sm sm:grid-cols-3">
              {(Object.keys(MAPPING_KEYS) as MappingKey[]).map((key) => {
                const account = byId.get(mapped.get(key) ?? "");
                return (
                  <div key={key}>
                    <dt className="text-subtle">{humanize(key)}</dt>
                    <dd>{account ? `${account.code} · ${account.name}` : <span className="text-danger">Not mapped</span>}</dd>
                  </div>
                );
              })}
            </dl>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Bank & cash accounts</CardTitle></CardHeader>
        <CardContent className="space-y-5">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
                <tr className="border-b border-[var(--ic-border)]"><th className={th}>Name</th><th className={th}>Kind</th><th className={th}>Bank</th><th className={th}>IFSC</th><th className={th}>Ledger account</th><th className="py-2">Active</th></tr>
              </thead>
              <tbody>
                {banks.length === 0 ? <tr><td colSpan={6} className="py-6 text-center text-muted">No bank or cash accounts yet.</td></tr> : null}
                {banks.map((b) => (
                  <tr key={b.id} className="border-b border-[var(--ic-border)] last:border-0">
                    <td className={`${th} font-medium`}>{b.name}</td>
                    <td className={th}>{humanize(b.kind)}</td>
                    <td className={th}>{[b.bankName, b.accountNumberLast4 ? `••••${b.accountNumberLast4}` : null].filter(Boolean).join(" ") || "—"}</td>
                    <td className={th}>{b.ifsc ?? "—"}</td>
                    <td className={th}>{b.account.code} · {b.account.name}</td>
                    <td className="py-2">{b.isActive ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {admin ? (
            <div>
              <p className="mb-2 text-2xs font-semibold uppercase tracking-wide text-subtle">New bank or cash account</p>
              <ApiForm path={`/companies/${company.id}/bank-accounts`} submitLabel="Create account" successMessage="Bank account created" className="grid gap-3 sm:grid-cols-3">
                <Field label="Name"><Input name="name" required placeholder="e.g. HDFC current" /></Field>
                <Field label="Kind">
                  <Select name="kind" defaultValue="BANK"><option value="BANK">Bank</option><option value="CASH">Cash</option></Select>
                </Field>
                <Field label="Ledger account" hint="An asset posting account">
                  <Select name="accountId" required>
                    {posting.filter((a) => a.type === "ASSET").map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
                  </Select>
                </Field>
                <Field label="Bank name"><Input name="bankName" /></Field>
                <Field label="Account number (last 4)"><Input name="accountNumberLast4" inputMode="numeric" pattern="[0-9]{4}" maxLength={4} /></Field>
                <Field label="IFSC"><Input name="ifsc" placeholder="HDFC0001234" /></Field>
              </ApiForm>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {lookups ? (
        <Card>
          <CardHeader><CardTitle>Tax rates by date</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted">Documents use the rate in force on their own date, so a change never rewrites history.</p>
            {lookups.taxRates.length === 0 ? <p className="text-sm text-muted">No tax rates yet.</p> : null}
            <div className="divide-y divide-[var(--ic-border)]">
              {lookups.taxRates.map((t) => {
                const history = versions.filter((v) => v.taxRateId === t.id);
                return (
                  <div key={t.id} className="grid gap-3 py-3 first:pt-0 md:grid-cols-2">
                    <div className="text-sm">
                      <p className="font-medium">{t.name} · {formatQty(t.rate)}% {t.isActive ? null : <Badge tone="neutral">Inactive</Badge>}</p>
                      <p className="text-2xs text-subtle">
                        {history.length ? history.map((v) => `${formatQty(v.rate)}% from ${formatDate(v.effectiveFrom)}`).join(" · ") : "No dated versions; the current rate applies to all dates."}
                      </p>
                    </div>
                    <ApiForm path={`/tax-rates/${t.id}/versions`} submitLabel="Add rate from date" successMessage="Rate scheduled" className="flex flex-wrap items-end gap-2">
                      <Input type="number" name="rate" step="0.001" min="0" max="100" required placeholder="Rate %" aria-label="Rate %" className="w-28" />
                      <Input type="date" name="effectiveFrom" required aria-label="Effective from" className="w-auto" />
                    </ApiForm>
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
