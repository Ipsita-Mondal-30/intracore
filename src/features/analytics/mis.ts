import { JournalStatus } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { assertCan, type AccessContext } from "@/lib/access";
import { companySettings } from "@/lib/settings";
import { dec, money } from "@/lib/money";
import { agingOf } from "@/features/analytics/metrics";
import { branchScope, dateRange, day, resolveScope, tsRange } from "@/features/analytics/scope";

/**
 * Management MIS for one company and period (default: the caller's first company, month to
 * date). Every line states its source. All amounts are in the company's base currency.
 * Document-based lines read POSTED documents in the caller's branch scope; ledger lines read
 * POSTED + REVERSED journals (a reversal nets its original) and are omitted, with a reason,
 * when finance is not enabled for the company.
 */

type Line = { key: string; label: string; value: string | number | null; source: string };
const ledgerStatuses = { in: [JournalStatus.POSTED, JournalStatus.REVERSED] };
const TOP = 10;

export async function getMis(ctx: AccessContext, query: unknown, now = new Date()) {
  assertCan(ctx, "finance.report");
  const all = await resolveScope(ctx, query, now);
  const company = all.companies[0];
  if (!company) {
    const empty = { source: "", rows: [] };
    return { company: null, period: { from: all.from, to: all.to }, finance: { enabled: false, accountingStartDate: null }, lines: [] as Line[], omitted: [], topCustomers: empty, topProducts: empty, vendorSpend: empty };
  }
  const s = { ...all, companyIds: [company.id], companies: [company], currencyOf: new Map([[company.id, company.currency]]) };
  const docScope = { ...branchScope(s), companyId: company.id };
  const posted = { ...docScope, status: "POSTED" as const };

  const [settingsRow, invoiced, credited, receivables, payables, expenses, customers, products, vendors] = await Promise.all([
    prisma.company.findUniqueOrThrow({ where: { id: company.id }, select: { settings: true } }),
    prisma.salesInvoice.aggregate({ where: { ...posted, invoiceDate: dateRange(s) }, _sum: { taxableTotal: true }, _count: true }),
    prisma.creditNote.aggregate({ where: { ...posted, noteDate: dateRange(s) }, _sum: { taxableTotal: true } }),
    agingOf(s, "receivables"),
    agingOf(s, "payables"),
    prisma.expenseClaim.aggregate({ where: { organizationId: ctx.organizationId, companyId: company.id, status: { in: ["APPROVED", "PAID"] }, approvedAt: tsRange(s) }, _sum: { totalAmount: true } }),
    prisma.salesInvoice.groupBy({ by: ["customerId"], where: { ...posted, invoiceDate: dateRange(s) }, _sum: { taxableTotal: true }, orderBy: { _sum: { taxableTotal: "desc" } }, take: TOP }),
    prisma.salesInvoiceLine.groupBy({
      by: ["productId"],
      where: { organizationId: ctx.organizationId, productId: { not: null }, invoice: { ...posted, invoiceDate: dateRange(s) } },
      _sum: { taxableAmount: true, quantity: true },
      orderBy: { _sum: { taxableAmount: "desc" } },
      take: TOP,
    }),
    prisma.vendorBill.groupBy({ by: ["vendorId"], where: { ...posted, billDate: dateRange(s) }, _sum: { taxableTotal: true }, orderBy: { _sum: { taxableTotal: "desc" } }, take: TOP }),
  ]);
  const purchaseSpend = await prisma.vendorBill.aggregate({ where: { ...posted, billDate: dateRange(s) }, _sum: { taxableTotal: true } });

  const [customerNames, productNames, vendorNames] = await Promise.all([
    prisma.customer.findMany({ where: { organizationId: ctx.organizationId, id: { in: customers.map((c) => c.customerId) } }, select: { id: true, name: true } }),
    prisma.product.findMany({ where: { organizationId: ctx.organizationId, id: { in: products.map((p) => p.productId!) } }, select: { id: true, sku: true, name: true } }),
    prisma.vendor.findMany({ where: { organizationId: ctx.organizationId, id: { in: vendors.map((v) => v.vendorId) } }, select: { id: true, name: true } }),
  ]);
  const name = <T extends { id: string }>(rows: T[], id: string | null) => rows.find((r) => r.id === id);

  const ccy = company.currency;
  const grossRevenue = money(dec(invoiced._sum.taxableTotal));
  const creditNotes = money(dec(credited._sum.taxableTotal));
  const lines: Line[] = [
    { key: "revenue.invoiced", label: "Revenue (invoiced, taxable value)", value: grossRevenue.toFixed(2), source: "sales_invoices: Σ taxableTotal, status POSTED, invoiceDate in period" },
    { key: "revenue.credit_notes", label: "Less: credit notes (taxable value)", value: creditNotes.toFixed(2), source: "credit_notes: Σ taxableTotal, status POSTED, noteDate in period" },
    { key: "revenue.net", label: "Net revenue", value: grossRevenue.sub(creditNotes).toFixed(2), source: "revenue.invoiced − revenue.credit_notes" },
    { key: "revenue.invoices", label: "Invoices posted", value: invoiced._count, source: "sales_invoices: count, status POSTED, invoiceDate in period" },
    { key: "receivables.outstanding", label: "Receivables outstanding", value: receivables.outstanding[ccy], source: "sales_invoices POSTED: Σ (grandTotal − paidAmount − creditedAmount) > 0, as of today (= receivables aging total)" },
    { key: "receivables.overdue", label: "Receivables overdue", value: receivables.overdue[ccy], source: "same, dueDate before today" },
    { key: "payables.outstanding", label: "Payables outstanding", value: payables.outstanding[ccy], source: "vendor_bills POSTED: Σ (grandTotal − paidAmount − debitedAmount) > 0, as of today (= payables aging total)" },
    { key: "payables.overdue", label: "Payables overdue", value: payables.overdue[ccy], source: "same, COALESCE(dueDate, billDate) before today" },
    { key: "purchases.spend", label: "Purchase spend (taxable value)", value: money(dec(purchaseSpend._sum.taxableTotal)).toFixed(2), source: "vendor_bills: Σ taxableTotal, status POSTED, billDate in period" },
    { key: "expenses.approved", label: "Expense claims approved", value: money(dec(expenses._sum.totalAmount)).toFixed(2), source: "expense_claims: Σ totalAmount, status APPROVED or PAID, approvedAt in period" },
  ];
  const omitted: { key: string; reason: string }[] = [];

  const finance = companySettings(settingsRow.settings).finance;
  if (!finance.enabled) {
    const reason = "Finance (double-entry ledger) is not enabled for this company";
    omitted.push({ key: "cogs", reason }, { key: "gross_margin", reason }, { key: "cash_bank", reason });
  } else {
    const [mappings, banks] = await Promise.all([
      prisma.accountMapping.findMany({ where: { companyId: company.id, key: { in: ["SALES_REVENUE", "COGS"] } } }),
      prisma.bankAccount.findMany({ where: { organizationId: ctx.organizationId, companyId: company.id }, select: { id: true, name: true, kind: true, accountId: true }, orderBy: { name: "asc" } }),
    ]);
    const accountOf = (key: string) => mappings.find((m) => m.key === key)?.accountId;
    const sums = await prisma.journalLine.groupBy({
      by: ["accountId"],
      where: { companyId: company.id, accountId: { in: [accountOf("SALES_REVENUE"), accountOf("COGS")].filter((x): x is string => !!x) }, entry: { status: ledgerStatuses, date: dateRange(s) } },
      _sum: { debit: true, credit: true },
    });
    const net = (id: string | undefined, sign: 1 | -1) => {
      const r = sums.find((x) => x.accountId === id);
      return dec(r?._sum.debit).sub(dec(r?._sum.credit)).mul(sign);
    };
    const ledgerRevenue = net(accountOf("SALES_REVENUE"), -1);
    const cogs = net(accountOf("COGS"), 1);
    const gross = ledgerRevenue.sub(cogs);
    lines.push(
      { key: "ledger.revenue", label: "Sales revenue (ledger)", value: ledgerRevenue.toFixed(2), source: "journal_lines on the SALES_REVENUE mapped account: credit − debit, journals POSTED/REVERSED dated in period" },
      { key: "cogs", label: "Cost of goods sold", value: cogs.toFixed(2), source: "journal_lines on the COGS mapped account: debit − credit, journals POSTED/REVERSED dated in period" },
      { key: "gross_profit", label: "Gross profit", value: gross.toFixed(2), source: "ledger.revenue − cogs" },
      { key: "gross_margin", label: "Gross margin %", value: ledgerRevenue.gt(0) ? gross.div(ledgerRevenue).mul(100).toDecimalPlaces(1).toNumber() : null, source: "gross_profit ÷ ledger.revenue × 100 (1 dp)" },
    );
    const balances = await prisma.journalLine.groupBy({
      by: ["accountId"],
      where: { companyId: company.id, accountId: { in: banks.map((b) => b.accountId) }, entry: { status: ledgerStatuses, date: { lte: day(s.to) } } },
      _sum: { debit: true, credit: true },
    });
    let cash = dec(0);
    for (const b of banks) {
      const r = balances.find((x) => x.accountId === b.accountId);
      const balance = dec(r?._sum.debit).sub(dec(r?._sum.credit));
      cash = cash.add(balance);
      lines.push({ key: `cash_bank.${b.id}`, label: `${b.kind === "CASH" ? "Cash" : "Bank"}: ${b.name}`, value: balance.toFixed(2), source: "journal_lines on the bank/cash ledger account: debit − credit, journals POSTED/REVERSED dated on or before period end" });
    }
    lines.push({ key: "cash_bank.total", label: "Cash and bank total", value: cash.toFixed(2), source: "Σ of the bank/cash balances above" });
  }

  return {
    company,
    period: { from: s.from, to: s.to },
    finance: { enabled: finance.enabled, accountingStartDate: finance.accountingStartDate ?? null },
    lines,
    omitted,
    topCustomers: {
      source: `sales_invoices POSTED in period: Σ taxableTotal group by customer, top ${TOP}`,
      rows: customers.map((c) => ({ customerId: c.customerId, name: name(customerNames, c.customerId)?.name ?? "—", amount: money(dec(c._sum.taxableTotal)).toFixed(2) })),
    },
    topProducts: {
      source: `sales_invoice_lines of POSTED invoices in period: Σ taxableAmount, Σ quantity group by product, top ${TOP}`,
      rows: products.map((p) => ({ productId: p.productId, sku: name(productNames, p.productId)?.sku ?? "—", name: name(productNames, p.productId)?.name ?? "—", quantity: dec(p._sum.quantity).toString(), amount: money(dec(p._sum.taxableAmount)).toFixed(2) })),
    },
    vendorSpend: {
      source: `vendor_bills POSTED in period: Σ taxableTotal group by vendor, top ${TOP}`,
      rows: vendors.map((v) => ({ vendorId: v.vendorId, name: name(vendorNames, v.vendorId)?.name ?? "—", amount: money(dec(v._sum.taxableTotal)).toFixed(2) })),
    },
  };
}
