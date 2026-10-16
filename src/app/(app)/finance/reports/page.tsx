import type { ReactNode } from "react";
import Link from "next/link";
import { ZodError } from "zod";
import { prisma } from "@/lib/db/prisma";
import { isAppError } from "@/lib/errors";
import { can, getAccessContext, type AccessContext } from "@/lib/access";
import { listCompanies } from "@/features/companies/service";
import {
  balanceSheet,
  financeReconciliation,
  generalLedger,
  payablesAging,
  profitAndLoss,
  receivablesAging,
  trialBalance,
} from "@/features/finance/reports";
import { gstr1, gstr3b } from "@/features/finance/gst-reports";
import { DownloadJson } from "@/features/finance/download-json";
import { PageHeader } from "@/components/layout/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { param } from "@/components/erp/list-controls";
import { dateInput, formatDate, formatMoney, formatQty, humanize } from "@/components/erp/format";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
type Params = Record<string, string | string[] | undefined>;

const REPORTS = {
  trial: "Trial balance",
  ledger: "General ledger",
  pl: "Profit & loss",
  bs: "Balance sheet",
  ar: "Receivables aging",
  ap: "Payables aging",
  recon: "Ledger vs documents",
  gstr1: "GSTR-1",
  gstr3b: "GSTR-3B",
} as const;
type ReportKey = keyof typeof REPORTS;

const BUCKET_LABELS = { current: "Not due", "1_30": "1–30 days", "31_60": "31–60 days", "61_90": "61–90 days", over_90: "Over 90 days" } as const;
const BUCKETS = Object.keys(BUCKET_LABELS) as (keyof typeof BUCKET_LABELS)[];

/** Runs a report; validation and access errors come back as a message to show. */
async function attempt<T>(fn: () => Promise<T>): Promise<{ data: T } | { error: string }> {
  try {
    return { data: await fn() };
  } catch (e) {
    if (isAppError(e)) return { error: e.message };
    if (e instanceof ZodError) return { error: e.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
    throw e;
  }
}

// ─── Small table primitives ──────────────────────────────────────────────────

const cell = "py-2 pr-3";
const num = `${cell} text-right tabular-nums`;

function Table({ head, children, foot, empty }: { head: (string | [string, "num"])[]; children: ReactNode[]; foot?: ReactNode; empty?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead className="text-left text-2xs uppercase tracking-wide text-subtle">
          <tr className="border-b border-[var(--ic-border)]">
            {head.map((h) => (typeof h === "string" ? <th key={h} className={cell}>{h}</th> : <th key={h[0]} className={`${cell} text-right`}>{h[0]}</th>))}
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--ic-border)]">
          {children.length ? children : <tr><td colSpan={head.length} className="py-6 text-center text-muted">{empty ?? "Nothing to show."}</td></tr>}
        </tbody>
        {foot ? <tfoot className="border-t-2 border-[var(--ic-border)] font-semibold">{foot}</tfoot> : null}
      </table>
    </div>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle>{aside}</CardHeader>
      <CardContent className="space-y-4">{children}</CardContent>
    </Card>
  );
}

function ErrorNote({ error }: { error: string }) {
  return <p className="rounded-xl bg-red-50 px-3 py-2 text-sm text-danger">{error}</p>;
}

function Check({ ok, yes, no }: { ok: boolean; yes: string; no: string }) {
  return ok ? <Badge tone="success">✓ {yes}</Badge> : <Badge tone="danger">✗ {no}</Badge>;
}

/** GET form for one report's parameters; keeps company and report selection. */
function ParamsForm({ companyId, report, children }: { companyId: string; report: ReportKey; children: ReactNode }) {
  return (
    <form method="get" className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="companyId" value={companyId} />
      <input type="hidden" name="report" value={report} />
      {children}
      <Button type="submit" size="sm" variant="secondary">Run</Button>
    </form>
  );
}

function DateField({ name, label, value }: { name: string; label: string; value: string }) {
  return (
    <label className="text-xs text-muted">
      <span className="mb-1 block">{label}</span>
      <Input type="date" name={name} defaultValue={value} className="w-auto" />
    </label>
  );
}

const today = () => dateInput(new Date());

// ─── Page ────────────────────────────────────────────────────────────────────

export default async function FinanceReportsPage({ searchParams }: Props) {
  const params = await searchParams;
  const ctx = await getAccessContext();
  const message = (text: string) => (
    <div className="space-y-4">
      <PageHeader breadcrumbs={["Finance", "Reports"]} title="Finance reports" />
      <Card><CardContent className="pt-5 text-sm text-muted">{text}</CardContent></Card>
    </div>
  );
  if (!can(ctx, "finance.report")) return message("You don't have access to finance reports. Ask an administrator for the finance report permission.");
  const companies = can(ctx, "company.view") ? await listCompanies(ctx) : [];
  if (companies.length === 0) return message("You do not have access to any company yet.");

  const company = companies.find((c) => c.id === param(params, "companyId")) ?? companies[0];
  const requested = param(params, "report");
  const report: ReportKey = requested && requested in REPORTS ? (requested as ReportKey) : "trial";
  const finance = company.settings.finance;
  const gstins = [...new Set([company.gstin, ...company.branches.map((b) => b.gstin)].filter((g): g is string => Boolean(g)))];
  const props = { ctx, companyId: company.id, params, report };

  return (
    <div className="space-y-4">
      <PageHeader
        breadcrumbs={["Finance", "Reports"]}
        title="Finance reports"
        subtitle="Computed from posted journals and documents. Draft journals never count."
        actions={
          <form method="get" className="flex flex-wrap items-center gap-2">
            <Select name="companyId" defaultValue={company.id} aria-label="Company" className="w-auto">
              {companies.map((c) => <option key={c.id} value={c.id}>{c.code} · {c.name}</option>)}
            </Select>
            <Select name="report" defaultValue={report} aria-label="Report" className="w-auto">
              {(Object.keys(REPORTS) as ReportKey[]).map((k) => <option key={k} value={k}>{REPORTS[k]}</option>)}
            </Select>
            <Button type="submit" size="sm" variant="secondary">Open</Button>
          </form>
        }
      />

      {!finance.enabled && report !== "gstr1" && report !== "gstr3b" ? (
        <p className="rounded-xl bg-amber-50 px-3 py-2 text-sm text-warning">
          Finance is not set up for {company.name}, so there are no journals yet. <Link href={`/finance/setup?companyId=${company.id}`} className="underline">Set it up</Link>.
        </p>
      ) : null}

      {report === "trial" ? <TrialBalanceReport {...props} /> : null}
      {report === "ledger" ? <LedgerReport {...props} /> : null}
      {report === "pl" ? <ProfitAndLossReport {...props} startMonth={finance.fiscalYearStartMonth} /> : null}
      {report === "bs" ? <BalanceSheetReport {...props} /> : null}
      {report === "ar" || report === "ap" ? <AgingReport {...props} kind={report} /> : null}
      {report === "recon" ? <ReconciliationReport {...props} /> : null}
      {report === "gstr1" || report === "gstr3b" ? <GstReport {...props} kind={report} gstins={gstins} /> : null}
    </div>
  );
}

type ReportProps = { ctx: AccessContext; companyId: string; params: Params; report: ReportKey };

// ─── Ledger reports ──────────────────────────────────────────────────────────

async function TrialBalanceReport({ ctx, companyId, params, report }: ReportProps) {
  const asOf = param(params, "asOf") || "";
  const r = await attempt(() => trialBalance(ctx, companyId, { asOf: asOf || undefined }));
  return (
    <Section title="Trial balance" aside={"data" in r ? <Check ok={r.data.balanced} yes="Debits equal credits" no="Out of balance" /> : null}>
      <ParamsForm companyId={companyId} report={report}><DateField name="asOf" label="As of (empty = all time)" value={asOf} /></ParamsForm>
      {"error" in r ? <ErrorNote error={r.error} /> : (
        <Table
          head={["Code", "Account", "Type", ["Debit", "num"], ["Credit", "num"]]}
          empty="No postings yet."
          foot={<tr><td className={cell} colSpan={3}>Total</td><td className={num}>{formatMoney(r.data.totalDebit)}</td><td className={num}>{formatMoney(r.data.totalCredit)}</td></tr>}
        >
          {r.data.rows.map((row) => (
            <tr key={row.accountId}>
              <td className={`${cell} font-mono text-xs`}>{row.code}</td>
              <td className={cell}><Link href={`/finance/reports?companyId=${companyId}&report=ledger&accountId=${row.accountId}`} className="text-primary hover:underline">{row.name}</Link></td>
              <td className={cell}>{humanize(row.type)}</td>
              <td className={num}>{row.debit !== "0.00" ? formatMoney(row.debit) : ""}</td>
              <td className={num}>{row.credit !== "0.00" ? formatMoney(row.credit) : ""}</td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

async function LedgerReport({ ctx, companyId, params, report }: ReportProps) {
  const accountId = param(params, "accountId") || "";
  const from = param(params, "from") || "";
  const to = param(params, "to") || "";
  const accounts = await prisma.account.findMany({ where: { organizationId: ctx.organizationId, companyId, isGroup: false }, select: { id: true, code: true, name: true }, orderBy: { code: "asc" } });
  const r = accountId ? await attempt(() => generalLedger(ctx, companyId, { accountId, from: from || undefined, to: to || undefined })) : null;
  return (
    <Section title="General ledger" aside={r && "data" in r ? <span className="text-sm text-muted">Opening {formatMoney(r.data.openingBalance)} · Closing <strong className="text-foreground">{formatMoney(r.data.closingBalance)}</strong></span> : null}>
      <ParamsForm companyId={companyId} report={report}>
        <label className="text-xs text-muted">
          <span className="mb-1 block">Account</span>
          <Select name="accountId" defaultValue={accountId} required className="w-auto">
            <option value="">Choose account…</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} · {a.name}</option>)}
          </Select>
        </label>
        <DateField name="from" label="From" value={from} />
        <DateField name="to" label="To" value={to} />
      </ParamsForm>
      {!r ? <p className="text-sm text-muted">Choose an account to see its movements.</p> : "error" in r ? <ErrorNote error={r.error} /> : (
        <Table head={["Date", "Journal", "Source", "Memo", ["Debit", "num"], ["Credit", "num"], ["Balance", "num"]]} empty="No movements in this range.">
          {r.data.lines.map((l) => (
            <tr key={l.lineId}>
              <td className={cell}>{formatDate(l.date)}</td>
              <td className={cell}><Link href={`/finance/journals/${l.id}`} className="text-primary hover:underline">{l.number ?? "—"}</Link></td>
              <td className={cell}>{humanize(l.sourceType)}</td>
              <td className={`${cell} max-w-xs truncate`}>{l.description ?? l.memo ?? "—"}</td>
              <td className={num}>{l.debit !== "0.00" ? formatMoney(l.debit) : ""}</td>
              <td className={num}>{l.credit !== "0.00" ? formatMoney(l.credit) : ""}</td>
              <td className={`${num} font-medium`}>{formatMoney(l.balance)}</td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

function amountRows({ rows }: { rows: { code: string; name: string; amount: string }[] }) {
  return rows.map((row) => (
    <tr key={row.code}>
      <td className={`${cell} font-mono text-xs`}>{row.code}</td>
      <td className={cell}>{row.name}</td>
      <td className={num}>{formatMoney(row.amount)}</td>
    </tr>
  ));
}

async function ProfitAndLossReport({ ctx, companyId, params, report, startMonth }: ReportProps & { startMonth: number }) {
  // Default: the current fiscal year.
  const now = new Date();
  const fyYear = now.getUTCMonth() + 1 >= startMonth ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
  const from = param(params, "from") || dateInput(new Date(Date.UTC(fyYear, startMonth - 1, 1)));
  const to = param(params, "to") || dateInput(new Date(Date.UTC(fyYear + 1, startMonth - 1, 0)));
  const r = await attempt(() => profitAndLoss(ctx, companyId, { from, to }));
  return (
    <Section title="Profit & loss" aside={<span className="text-sm text-muted">{formatDate(from)} – {formatDate(to)}</span>}>
      <ParamsForm companyId={companyId} report={report}>
        <DateField name="from" label="From" value={from} />
        <DateField name="to" label="To" value={to} />
      </ParamsForm>
      {"error" in r ? <ErrorNote error={r.error} /> : (
        <>
          <Table head={["Code", "Income", ["Amount", "num"]]} empty="No income in this period." foot={<tr><td className={cell} colSpan={2}>Total income</td><td className={num}>{formatMoney(r.data.income.total)}</td></tr>}>
            {amountRows({ rows: r.data.income.rows })}
          </Table>
          <Table head={["Code", "Expenses", ["Amount", "num"]]} empty="No expenses in this period." foot={<tr><td className={cell} colSpan={2}>Total expenses</td><td className={num}>{formatMoney(r.data.expenses.total)}</td></tr>}>
            {amountRows({ rows: r.data.expenses.rows })}
          </Table>
          <p className="flex justify-between border-t border-[var(--ic-border)] pt-3 text-base font-semibold">
            <span>{Number(r.data.netProfit) < 0 ? "Net loss" : "Net profit"}</span>
            <span className={Number(r.data.netProfit) < 0 ? "text-danger" : "text-success"}>{formatMoney(r.data.netProfit)}</span>
          </p>
        </>
      )}
    </Section>
  );
}

async function BalanceSheetReport({ ctx, companyId, params, report }: ReportProps) {
  const asOf = param(params, "asOf") || today();
  const r = await attempt(() => balanceSheet(ctx, companyId, { asOf }));
  return (
    <Section title="Balance sheet" aside={"data" in r ? <Check ok={r.data.balanced} yes="Assets = liabilities + equity" no="Does not balance" /> : null}>
      <ParamsForm companyId={companyId} report={report}><DateField name="asOf" label="As of" value={asOf} /></ParamsForm>
      {"error" in r ? <ErrorNote error={r.error} /> : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Table head={["Code", "Assets", ["Amount", "num"]]} empty="No asset balances." foot={<tr><td className={cell} colSpan={2}>Total assets</td><td className={num}>{formatMoney(r.data.assets.total)}</td></tr>}>
            {amountRows({ rows: r.data.assets.rows })}
          </Table>
          <div className="space-y-4">
            <Table head={["Code", "Liabilities", ["Amount", "num"]]} empty="No liability balances." foot={<tr><td className={cell} colSpan={2}>Total liabilities</td><td className={num}>{formatMoney(r.data.liabilities.total)}</td></tr>}>
              {amountRows({ rows: r.data.liabilities.rows })}
            </Table>
            <Table head={["Code", "Equity", ["Amount", "num"]]} foot={<tr><td className={cell} colSpan={2}>Total equity</td><td className={num}>{formatMoney(r.data.equity.total)}</td></tr>}>
              {[
                ...amountRows({ rows: r.data.equity.rows }),
                <tr key="profit"><td className={cell} /><td className={cell}>Accumulated profit (not yet closed to retained earnings)</td><td className={num}>{formatMoney(r.data.equity.accumulatedProfit)}</td></tr>,
              ]}
            </Table>
            <p className="flex justify-between text-base font-semibold"><span>Liabilities + equity</span><span>{formatMoney(r.data.totalLiabilitiesAndEquity)}</span></p>
          </div>
        </div>
      )}
    </Section>
  );
}

// ─── Aging and reconciliation ────────────────────────────────────────────────

async function AgingReport({ ctx, companyId, params, report, kind }: ReportProps & { kind: "ar" | "ap" }) {
  const asOf = param(params, "asOf") || today();
  const r = await attempt(() => (kind === "ar" ? receivablesAging : payablesAging)(ctx, companyId, { asOf }));
  const statement = kind === "ar" ? "/finance/statements/customers" : "/finance/statements/vendors";
  return (
    <Section title={REPORTS[kind]} aside={<span className="text-2xs text-subtle">Outstanding posted {kind === "ar" ? "invoices" : "bills"} by days past due</span>}>
      <ParamsForm companyId={companyId} report={report}><DateField name="asOf" label="As of" value={asOf} /></ParamsForm>
      {"error" in r ? <ErrorNote error={r.error} /> : (
        <Table
          head={[kind === "ar" ? "Customer" : "Vendor", ...BUCKETS.map((b): [string, "num"] => [BUCKET_LABELS[b], "num"]), ["Total", "num"], [kind === "ar" ? "Unapplied credit" : "Unapplied debit", "num"]]}
          empty="Nothing outstanding."
          foot={
            <tr>
              <td className={cell}>Total</td>
              {BUCKETS.map((b) => <td key={b} className={num}>{formatMoney(r.data.totals[b])}</td>)}
              <td className={num}>{formatMoney(r.data.totals.total)}</td>
              <td />
            </tr>
          }
        >
          {r.data.rows.map((row) => (
            <tr key={row.partyId}>
              <td className={cell}><Link href={`${statement}/${row.partyId}?companyId=${companyId}`} className="text-primary hover:underline">{row.partyName}</Link></td>
              {BUCKETS.map((b) => <td key={b} className={num}>{row[b] !== "0.00" ? formatMoney(row[b]) : ""}</td>)}
              <td className={`${num} font-medium`}>{formatMoney(row.total)}</td>
              <td className={num}>{row.unappliedCredit !== "0.00" ? formatMoney(row.unappliedCredit) : ""}</td>
            </tr>
          ))}
        </Table>
      )}
    </Section>
  );
}

async function ReconciliationReport({ ctx, companyId }: ReportProps) {
  const r = await attempt(() => financeReconciliation(ctx, companyId));
  if ("error" in r) return <Section title={REPORTS.recon}><ErrorNote error={r.error} /></Section>;
  if (!r.data.enabled) return <Section title={REPORTS.recon}><p className="text-sm text-muted">Finance is not set up for this company.</p></Section>;
  return (
    <>
      <Section title="Control accounts" aside={<span className="text-2xs text-subtle">Ledger balance vs open documents since {formatDate(r.data.accountingStartDate)}</span>}>
        <Table head={["Control", ["Ledger", "num"], ["Documents", "num"], "Matches"]}>
          {r.data.controls.map((c) => (
            <tr key={c.control}>
              <td className={cell}>{c.control}</td>
              <td className={num}>{c.ledger === null ? <span className="text-danger">Not mapped</span> : formatMoney(c.ledger)}</td>
              <td className={num}>{formatMoney(c.documents)}</td>
              <td className={cell}>{c.matches ? <span className="text-success" aria-label="Matches">✓</span> : <span className="text-danger" aria-label="Does not match">✗</span>}</td>
            </tr>
          ))}
        </Table>
      </Section>
      <Section title="Documents without a matching journal" aside={r.data.issues.length ? <Badge tone="danger">{r.data.issues.length}</Badge> : <Badge tone="success">✓ None</Badge>}>
        <Table head={["Document", "Number", "Problem"]} empty="Every posted document has a matching journal.">
          {r.data.issues.map((i) => (
            <tr key={`${i.documentType}:${i.documentId}`}>
              <td className={cell}>{humanize(i.documentType)}</td>
              <td className={cell}>{i.number ?? "—"}</td>
              <td className={`${cell} text-danger`}>{i.problem}</td>
            </tr>
          ))}
        </Table>
      </Section>
    </>
  );
}

// ─── GST ─────────────────────────────────────────────────────────────────────

type RateRow = { rate: string; taxable: string; igst: string; cgst: string; sgst: string };

function Rates({ rates }: { rates: RateRow[] }) {
  return (
    <span className="text-2xs text-muted">
      {rates.map((r) => (
        <span key={r.rate} className="block">
          {formatQty(r.rate)}%: {formatMoney(r.taxable)} + tax {formatMoney(Number(r.igst) + Number(r.cgst) + Number(r.sgst))}
        </span>
      ))}
    </span>
  );
}

const taxCells = (t: { taxable: string; igst: string; cgst: string; sgst: string }) => [
  <td key="t" className={num}>{formatMoney(t.taxable)}</td>,
  <td key="i" className={num}>{formatMoney(t.igst)}</td>,
  <td key="c" className={num}>{formatMoney(t.cgst)}</td>,
  <td key="s" className={num}>{formatMoney(t.sgst)}</td>,
];
const taxHead: [string, "num"][] = [["Taxable", "num"], ["IGST", "num"], ["CGST", "num"], ["SGST", "num"]];

function Disclaimer({ text }: { text: string }) {
  return <p className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-warning">{text}</p>;
}

async function GstReport({ ctx, companyId, params, report, kind, gstins }: ReportProps & { kind: "gstr1" | "gstr3b"; gstins: string[] }) {
  if (gstins.length === 0) {
    return <Section title={REPORTS[kind]}><p className="text-sm text-muted">This company and its branches have no GSTIN. Add one under Settings → Companies.</p></Section>;
  }
  // Default: the previous calendar month (the usual return period).
  const now = new Date();
  const gstinParam = param(params, "gstin");
  const gstin = gstinParam && gstins.includes(gstinParam) ? gstinParam : gstins[0];
  const from = param(params, "from") || dateInput(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const to = param(params, "to") || dateInput(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)));
  const query = { gstin, from, to };
  const form = (
    <ParamsForm companyId={companyId} report={report}>
      <label className="text-xs text-muted">
        <span className="mb-1 block">GSTIN</span>
        <Select name="gstin" defaultValue={gstin} className="w-auto">
          {gstins.map((g) => <option key={g} value={g}>{g}</option>)}
        </Select>
      </label>
      <DateField name="from" label="From" value={from} />
      <DateField name="to" label="To" value={to} />
    </ParamsForm>
  );
  const fileName = `${kind}-${gstin}-${from}-${to}.json`;

  if (kind === "gstr3b") {
    const r = await attempt(() => gstr3b(ctx, companyId, query));
    if ("error" in r) return <Section title="GSTR-3B summary">{form}<ErrorNote error={r.error} /></Section>;
    const d = r.data;
    const outward = d["3.1(a) outward taxable supplies (net of credit notes)"];
    const itc = d["4(A)(5) all other ITC (from posted vendor bills)"];
    return (
      <Section title="GSTR-3B summary" aside={<DownloadJson json={JSON.stringify(d, null, 2)} fileName={fileName} />}>
        <Disclaimer text={d.disclaimer} />
        {form}
        <Table head={["Section", ...taxHead]}>
          {[
            <tr key="out"><td className={cell}>3.1(a) Outward taxable supplies (net of credit notes)</td>{taxCells(outward)}</tr>,
            <tr key="nil"><td className={cell}>3.1(c) Nil rated / exempt</td><td className={num}>{formatMoney(d["3.1(c) nil rated / exempt"].taxable)}</td><td colSpan={3} /></tr>,
            <tr key="itc"><td className={cell}>4(A)(5) All other ITC (from posted vendor bills)</td>{taxCells(itc)}</tr>,
            <tr key="net" className="font-semibold">
              <td className={cell}>Net tax before set-off</td><td />
              <td className={num}>{formatMoney(d.netTaxBeforeSetOff.igst)}</td>
              <td className={num}>{formatMoney(d.netTaxBeforeSetOff.cgst)}</td>
              <td className={num}>{formatMoney(d.netTaxBeforeSetOff.sgst)}</td>
            </tr>,
          ]}
        </Table>
      </Section>
    );
  }

  const r = await attempt(() => gstr1(ctx, companyId, query));
  if ("error" in r) return <Section title="GSTR-1 preparation">{form}<ErrorNote error={r.error} /></Section>;
  const d = r.data;
  return (
    <>
      <Section title="GSTR-1 preparation" aside={<DownloadJson json={JSON.stringify(d, null, 2)} fileName={fileName} />}>
        <Disclaimer text={d.disclaimer} />
        {form}
        <p className="text-sm text-muted">{d.gstin}{d.state ? ` · ${d.state}` : ""} · {formatDate(d.period.from)} – {formatDate(d.period.to)}</p>
        {d.warnings.length ? (
          <ul className="list-disc space-y-1 rounded-xl bg-red-50 py-2 pl-7 pr-3 text-sm text-danger">
            {d.warnings.map((w) => <li key={w}>{w}</li>)}
          </ul>
        ) : null}
      </Section>

      <Section title="B2B — registered customers">
        <Table head={["Customer GSTIN", "Invoice", "Date", ["Value", "num"], "Place of supply", "Reverse charge", "Rates"]} empty="No B2B invoices.">
          {d.b2b.map((x) => (
            <tr key={x.invoiceNumber}>
              <td className={cell}>{x.customerGstin}{x.gstinValid ? null : <Badge tone="danger" className="ml-2">Invalid</Badge>}</td>
              <td className={cell}>{x.invoiceNumber}</td>
              <td className={cell}>{formatDate(x.invoiceDate)}</td>
              <td className={num}>{formatMoney(x.invoiceValue)}</td>
              <td className={cell}>{x.placeOfSupply ?? "—"}</td>
              <td className={cell}>{x.reverseCharge ? "Yes" : "No"}</td>
              <td className={cell}><Rates rates={x.rates} /></td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="B2CL — large inter-state to unregistered">
        <Table head={["Invoice", "Date", ["Value", "num"], "Place of supply", "Rates"]} empty="No B2CL invoices.">
          {d.b2cl.map((x) => (
            <tr key={x.invoiceNumber}>
              <td className={cell}>{x.invoiceNumber}</td>
              <td className={cell}>{formatDate(x.invoiceDate)}</td>
              <td className={num}>{formatMoney(x.invoiceValue)}</td>
              <td className={cell}>{x.placeOfSupply ?? "—"}</td>
              <td className={cell}><Rates rates={x.rates} /></td>
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="B2CS — other unregistered (summary)">
        <Table head={["Place of supply", "Type", ["Rate", "num"], ...taxHead]} empty="No B2CS supplies.">
          {d.b2cs.map((x) => (
            <tr key={`${x.placeOfSupply}|${x.rate}`}>
              <td className={cell}>{x.placeOfSupply ?? "—"}</td>
              <td className={cell}>{humanize(x.type)}</td>
              <td className={num}>{formatQty(x.rate)}%</td>
              {taxCells(x)}
            </tr>
          ))}
        </Table>
      </Section>

      <Section title="Credit / debit notes">
        <Table head={["Note", "Date", "Customer", "Original invoice", ["Value", "num"], "Place of supply", "Rates"]} empty="No credit or debit notes.">
          {d.creditDebitNotes.map((x) => (
            <tr key={x.noteNumber ?? `${x.originalInvoice}-${String(x.noteDate)}`}>
              <td className={cell}>{x.noteNumber ?? "—"}</td>
              <td className={cell}>{formatDate(x.noteDate)}</td>
              <td className={cell}>{x.registered ? x.customerGstin : "Unregistered"}</td>
              <td className={cell}>{x.originalInvoice ?? "—"} <span className="text-2xs text-subtle">{formatDate(x.originalInvoiceDate)}</span></td>
              <td className={num}>{formatMoney(x.noteValue)}</td>
              <td className={cell}>{x.placeOfSupply ?? "—"}</td>
              <td className={cell}><Rates rates={x.rates} /></td>
            </tr>
          ))}
        </Table>
      </Section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Section title="Nil rated, exempt and non-GST">
          <Table head={["Category", ["Value", "num"]]}>
            {[
              <tr key="nil"><td className={cell}>Nil rated</td><td className={num}>{formatMoney(d.nilExemptNonGst.nilRated)}</td></tr>,
              <tr key="ex"><td className={cell}>Exempt</td><td className={num}>{formatMoney(d.nilExemptNonGst.exempt)}</td></tr>,
              <tr key="non"><td className={cell}>Non-GST</td><td className={num}>{formatMoney(d.nilExemptNonGst.nonGst)}</td></tr>,
            ]}
          </Table>
        </Section>
        <Section title="Documents issued">
          <Table head={["Document", "From", "To", ["Total", "num"], ["Cancelled", "num"]]}>
            {[
              <tr key="inv">
                <td className={cell}>Invoices</td>
                <td className={cell}>{d.documents.invoices.from ?? "—"}</td>
                <td className={cell}>{d.documents.invoices.to ?? "—"}</td>
                <td className={num}>{d.documents.invoices.total}</td>
                <td className={num}>{d.documents.invoices.cancelled}</td>
              </tr>,
            ]}
          </Table>
        </Section>
      </div>

      <Section title="HSN / SAC summary">
        <Table head={["HSN/SAC", ["Rate", "num"], ["Quantity", "num"], ["Value", "num"], ...taxHead]} empty="No invoice lines.">
          {d.hsnSummary.map((x) => (
            <tr key={`${x.hsn}|${x.rate}`}>
              <td className={cell}>{x.hsn === "MISSING" ? <Badge tone="danger">Missing</Badge> : x.hsn}</td>
              <td className={num}>{formatQty(x.rate)}%</td>
              <td className={num}>{formatQty(x.quantity)}</td>
              <td className={num}>{formatMoney(x.value)}</td>
              {taxCells(x)}
            </tr>
          ))}
        </Table>
      </Section>
    </>
  );
}
