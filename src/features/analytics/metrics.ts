import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { assertCan, can, type AccessContext } from "@/lib/access";
import { dec, money } from "@/lib/money";
import { leadVisibilityWhere } from "@/features/leads/scope";
import { ticketScope } from "@/features/service/tickets";
import { ACTIVE_TICKET } from "@/features/service/sla";
import { projectScope } from "@/features/projects/projects";
import {
  branchScope,
  companyScope,
  dateRange,
  day,
  pct,
  perCurrency,
  resolveScope,
  sqlScope,
  tsRange,
  utc,
  type Scope,
} from "@/features/analytics/scope";

/**
 * Business dashboard metrics. Every metric is computed in the database with aggregate
 * queries over the operational tables (no row-by-row loading), restricted to the caller's
 * organization and company/branch scope (and the module's own visibility rule, e.g. lead
 * assignment or ticket assignee). Money is summed per company and folded per company base
 * currency; different currencies are never added together.
 *
 * Period: `from`..`to` inclusive (yyyy-mm-dd, UTC days). Snapshot metrics ignore the period
 * and describe the state "now". docs/METRICS.md is generated from the same definitions.
 */

export const SECTIONS = [
  { key: "sales", label: "Sales and quotations" },
  { key: "leads", label: "Lead pipeline and follow-ups" },
  { key: "inventory", label: "Inventory" },
  { key: "purchasing", label: "Purchasing" },
  { key: "receivables", label: "Receivables" },
  { key: "payables", label: "Payables" },
  { key: "expenses", label: "Expenses" },
  { key: "hr", label: "Attendance and leave" },
  { key: "service", label: "Service tickets" },
  { key: "projects", label: "Projects" },
] as const;
export type SectionKey = (typeof SECTIONS)[number]["key"];

export type Metric = {
  key: string;
  label: string;
  section: SectionKey;
  /** Caller needs every listed permission */
  permissions: string[];
  definition: string;
  statusInclusion: string;
  /** Column the period applies to, or "snapshot" */
  dateField: string;
  aggregation: string;
  /** money: per-currency map; count/qty/percent/hours/breakdown: plain values */
  unit: "money" | "count" | "qty" | "percent" | "hours" | "breakdown";
  currency: string;
  compute: (s: Scope) => Promise<unknown>;
};

const BASE_CCY = "Company base currency; summed per company, reported per currency (never mixed).";
const NO_CCY = "Not a money value.";
/** Memoizes a shared query per dashboard run, so metrics reading the same aggregate query it once. */
const memo = new WeakMap<Scope, Map<string, Promise<unknown>>>();
function once<T>(s: Scope, key: string, run: () => Promise<T>): Promise<T> {
  const cache = memo.get(s) ?? new Map<string, Promise<unknown>>();
  memo.set(s, cache);
  if (!cache.has(key)) cache.set(key, run());
  return cache.get(key) as Promise<T>;
}

const sum = (rows: { _sum: Record<string, Prisma.Decimal | null> }[], key: string) => rows.reduce((t, r) => t.add(dec(r._sum[key])), dec(0));

// ─── Shared queries ──────────────────────────────────────────────────────────

/** Outstanding / aging per company, same formula and buckets as finance receivablesAging/payablesAging. */
export const agingOf = (s: Scope, kind: "receivables" | "payables") => once(s, `aging:${kind}`, () => agingQuery(s, kind));

async function agingQuery(s: Scope, kind: "receivables" | "payables") {
  const scope = sqlScope(s.ctx, s.companyIds, "t", true);
  const inner =
    kind === "receivables"
      ? Prisma.sql`SELECT t."companyId", t."grandTotal" - t."paidAmount" - t."creditedAmount" AS o, (${s.today}::date - t."dueDate") AS d
          FROM "sales_invoices" t WHERE ${scope} AND t."status" = 'POSTED'`
      : Prisma.sql`SELECT t."companyId", t."grandTotal" - t."paidAmount" - t."debitedAmount" AS o, (${s.today}::date - COALESCE(t."dueDate", t."billDate")) AS d
          FROM "vendor_bills" t WHERE ${scope} AND t."status" = 'POSTED'`;
  const rows = await prisma.$queryRaw<{ companyId: string; total: Prisma.Decimal; current: Prisma.Decimal | null; d1_30: Prisma.Decimal | null; d31_60: Prisma.Decimal | null; d61_90: Prisma.Decimal | null; over_90: Prisma.Decimal | null; count: number }[]>`
    SELECT x."companyId", SUM(x.o) AS total, COUNT(*)::int AS count,
      SUM(x.o) FILTER (WHERE x.d <= 0) AS current,
      SUM(x.o) FILTER (WHERE x.d BETWEEN 1 AND 30) AS d1_30,
      SUM(x.o) FILTER (WHERE x.d BETWEEN 31 AND 60) AS d31_60,
      SUM(x.o) FILTER (WHERE x.d BETWEEN 61 AND 90) AS d61_90,
      SUM(x.o) FILTER (WHERE x.d > 90) AS over_90
    FROM (${inner}) x WHERE x.o > 0 GROUP BY x."companyId"`;
  const fold = (k: "total" | "current" | "d1_30" | "d31_60" | "d61_90" | "over_90") => perCurrency(s, rows.map((r) => ({ companyId: r.companyId, amount: r[k] })));
  return {
    outstanding: fold("total"),
    documents: rows.reduce((n, r) => n + r.count, 0),
    overdue: perCurrency(s, rows.map((r) => ({ companyId: r.companyId, amount: dec(r.total).sub(dec(r.current)) }))),
    buckets: { current: fold("current"), "1_30": fold("d1_30"), "31_60": fold("d31_60"), "61_90": fold("d61_90"), over_90: fold("over_90") },
  };
}

function expenseVisibility(s: Scope): Prisma.ExpenseClaimWhereInput {
  const base = companyScope(s);
  return can(s.ctx, "expense.approve") || can(s.ctx, "expense.pay") ? base : { ...base, claimantId: s.ctx.userId };
}

const employeeScope = (s: Scope): Prisma.EmployeeWhereInput => branchScope(s);

const ticketsIn = (s: Scope): Prisma.TicketWhereInput => ({ AND: [ticketScope(s.ctx), { companyId: { in: s.companyIds } }] });
const projectsIn = (s: Scope): Prisma.ProjectWhereInput => ({ AND: [projectScope(s.ctx), { companyId: { in: s.companyIds } }] });

// ─── Registry ────────────────────────────────────────────────────────────────

export const METRICS: Metric[] = [
  // Sales
  {
    key: "sales.quotations_created", label: "Quotations created", section: "sales", permissions: ["quotation.view"], unit: "count",
    definition: "Number of quotations created in the period (each live revision counts once).",
    statusInclusion: "All statuses except SUPERSEDED (replaced revisions).", dateField: "quotations.createdAt", aggregation: "count", currency: NO_CCY,
    compute: (s) => prisma.quotation.count({ where: { ...branchScope(s), createdAt: tsRange(s), status: { not: "SUPERSEDED" } } }),
  },
  {
    key: "sales.quotations_sent", label: "Quotations sent", section: "sales", permissions: ["quotation.view"], unit: "count",
    definition: "Number of quotations marked sent to the customer in the period.",
    statusInclusion: "Any status, as long as sentAt falls in the period (a later revision does not undo a send).", dateField: "quotations.sentAt", aggregation: "count", currency: NO_CCY,
    compute: (s) => prisma.quotation.count({ where: { ...branchScope(s), sentAt: tsRange(s) } }),
  },
  {
    key: "sales.quotations_accepted", label: "Quotations accepted", section: "sales", permissions: ["quotation.view"], unit: "count",
    definition: "Number of quotations the customer accepted in the period.",
    statusInclusion: "status = ACCEPTED.", dateField: "quotations.decidedAt", aggregation: "count", currency: NO_CCY,
    compute: (s) => prisma.quotation.count({ where: { ...branchScope(s), status: "ACCEPTED", decidedAt: tsRange(s) } }),
  },
  {
    key: "sales.quotations_accepted_value", label: "Accepted quotation value", section: "sales", permissions: ["quotation.view"], unit: "money",
    definition: "Σ grand total (incl. GST) of quotations accepted in the period.",
    statusInclusion: "status = ACCEPTED.", dateField: "quotations.decidedAt", aggregation: "sum(grandTotal)", currency: BASE_CCY,
    compute: async (s) => perCurrency(s, (await prisma.quotation.groupBy({ by: ["companyId"], where: { ...branchScope(s), status: "ACCEPTED", decidedAt: tsRange(s) }, _sum: { grandTotal: true } })).map((r) => ({ companyId: r.companyId, amount: r._sum.grandTotal }))),
  },
  {
    key: "sales.quotation_conversion_rate", label: "Quotation conversion rate", section: "sales", permissions: ["quotation.view"], unit: "percent",
    definition: "Accepted ÷ decided × 100, where decided = accepted + rejected in the period (1 dp; null when nothing was decided).",
    statusInclusion: "ACCEPTED and REJECTED only. EXPIRED, open and superseded quotations are not decisions.", dateField: "quotations.decidedAt", aggregation: "count ratio", currency: NO_CCY,
    compute: async (s) => {
      const rows = await prisma.quotation.groupBy({ by: ["status"], where: { ...branchScope(s), status: { in: ["ACCEPTED", "REJECTED"] }, decidedAt: tsRange(s) }, _count: { _all: true } });
      const accepted = rows.find((r) => r.status === "ACCEPTED")?._count._all ?? 0;
      return pct(accepted, rows.reduce((n, r) => n + r._count._all, 0));
    },
  },
  {
    key: "sales.orders_confirmed", label: "Sales orders confirmed", section: "sales", permissions: ["sales_order.view"], unit: "count",
    definition: "Number of sales orders confirmed in the period.",
    statusInclusion: "Confirmed orders (CONFIRMED, PARTIALLY_DELIVERED, DELIVERED); CANCELLED and DRAFT excluded.", dateField: "sales_orders.confirmedAt", aggregation: "count", currency: NO_CCY,
    compute: (s) => prisma.salesOrder.count({ where: { ...branchScope(s), confirmedAt: tsRange(s), status: { notIn: ["CANCELLED", "DRAFT"] } } }),
  },
  {
    key: "sales.orders_value", label: "Sales order value", section: "sales", permissions: ["sales_order.view"], unit: "money",
    definition: "Σ grand total (incl. GST) of sales orders confirmed in the period.",
    statusInclusion: "Confirmed orders (CONFIRMED, PARTIALLY_DELIVERED, DELIVERED); CANCELLED and DRAFT excluded.", dateField: "sales_orders.confirmedAt", aggregation: "sum(grandTotal)", currency: BASE_CCY,
    compute: async (s) => perCurrency(s, (await prisma.salesOrder.groupBy({ by: ["companyId"], where: { ...branchScope(s), confirmedAt: tsRange(s), status: { notIn: ["CANCELLED", "DRAFT"] } }, _sum: { grandTotal: true } })).map((r) => ({ companyId: r.companyId, amount: r._sum.grandTotal }))),
  },
  {
    key: "sales.invoiced_value", label: "Invoiced (taxable value)", section: "sales", permissions: ["invoice.view"], unit: "money",
    definition: "Σ taxable value (excl. GST) of sales invoices dated in the period. Credit notes are not deducted here (see MIS net revenue).",
    statusInclusion: "status = POSTED. DRAFT and CANCELLED excluded.", dateField: "sales_invoices.invoiceDate", aggregation: "sum(taxableTotal)", currency: BASE_CCY,
    compute: async (s) => perCurrency(s, (await prisma.salesInvoice.groupBy({ by: ["companyId"], where: { ...branchScope(s), status: "POSTED", invoiceDate: dateRange(s) }, _sum: { taxableTotal: true } })).map((r) => ({ companyId: r.companyId, amount: r._sum.taxableTotal }))),
  },
  {
    key: "sales.invoiced_gross", label: "Invoiced (incl. GST)", section: "sales", permissions: ["invoice.view"], unit: "money",
    definition: "Σ grand total (incl. GST) of sales invoices dated in the period.",
    statusInclusion: "status = POSTED. DRAFT and CANCELLED excluded.", dateField: "sales_invoices.invoiceDate", aggregation: "sum(grandTotal)", currency: BASE_CCY,
    compute: async (s) => perCurrency(s, (await prisma.salesInvoice.groupBy({ by: ["companyId"], where: { ...branchScope(s), status: "POSTED", invoiceDate: dateRange(s) }, _sum: { grandTotal: true } })).map((r) => ({ companyId: r.companyId, amount: r._sum.grandTotal }))),
  },

  // Leads (org-level records; the company filter does not apply)
  {
    key: "leads.new", label: "New leads", section: "leads", permissions: ["lead.view"], unit: "count",
    definition: "Leads created in the period that the caller can see (lead.view_all, else assigned to the caller).",
    statusInclusion: "All statuses; archived leads excluded.", dateField: "leads.createdAt", aggregation: "count", currency: NO_CCY,
    compute: (s) => prisma.lead.count({ where: { ...leadVisibilityWhere(s.ctx), archivedAt: null, createdAt: tsRange(s) } }),
  },
  {
    key: "leads.converted", label: "Leads converted", section: "leads", permissions: ["lead.view"], unit: "count",
    definition: "Visible leads converted to a customer in the period.",
    statusInclusion: "convertedAt set and a converted customer linked.", dateField: "leads.convertedAt", aggregation: "count", currency: NO_CCY,
    compute: (s) => prisma.lead.count({ where: { ...leadVisibilityWhere(s.ctx), convertedAt: tsRange(s), convertedCustomerId: { not: null } } }),
  },
  {
    key: "leads.pipeline_by_stage", label: "Open pipeline by stage", section: "leads", permissions: ["lead.view"], unit: "breakdown",
    definition: "Current open leads grouped by pipeline stage: count and Σ expected value per stage.",
    statusInclusion: "Open leads: status not CONVERTED or LOST, not archived.", dateField: "snapshot", aggregation: "count, sum(expectedValue) group by stage", currency: "Expected value is a plain lead estimate (no currency on leads).",
    compute: async (s) => {
      const rows = await prisma.lead.groupBy({ by: ["stageId"], where: { ...leadVisibilityWhere(s.ctx), archivedAt: null, status: { notIn: ["CONVERTED", "LOST"] } }, _count: { _all: true }, _sum: { expectedValue: true } });
      const stages = await prisma.leadStage.findMany({ where: { organizationId: s.ctx.organizationId, id: { in: rows.map((r) => r.stageId).filter((x): x is string => !!x) } }, select: { id: true, name: true, sortOrder: true } });
      const byId = new Map(stages.map((st) => [st.id, st]));
      return rows
        .map((r) => ({ r, st: r.stageId ? byId.get(r.stageId) : undefined }))
        .sort((a, b) => (a.st?.sortOrder ?? 9999) - (b.st?.sortOrder ?? 9999))
        .map(({ r, st }) => ({ stageId: r.stageId, stage: st?.name ?? "No stage", count: r._count._all, expectedValue: dec(r._sum.expectedValue).toFixed(2) }));
    },
  },
  {
    key: "leads.followups_due", label: "Follow-ups due in period", section: "leads", permissions: ["lead.view"], unit: "count",
    definition: "Pending follow-ups on visible leads whose due time falls in the period.",
    statusInclusion: "status = PENDING.", dateField: "lead_follow_ups.dueAt", aggregation: "count", currency: NO_CCY,
    compute: (s) => prisma.leadFollowUp.count({ where: { organizationId: s.ctx.organizationId, lead: leadVisibilityWhere(s.ctx), status: "PENDING", dueAt: tsRange(s) } }),
  },
  {
    key: "leads.followups_overdue", label: "Overdue follow-ups", section: "leads", permissions: ["lead.view"], unit: "count",
    definition: "Pending follow-ups on visible leads that are past due right now.",
    statusInclusion: "status = PENDING and dueAt < now.", dateField: "snapshot", aggregation: "count", currency: NO_CCY,
    compute: (s) => prisma.leadFollowUp.count({ where: { organizationId: s.ctx.organizationId, lead: leadVisibilityWhere(s.ctx), status: "PENDING", dueAt: { lt: s.now } } }),
  },
  {
    key: "leads.followups_completed", label: "Follow-ups completed", section: "leads", permissions: ["lead.view"], unit: "count",
    definition: "Follow-ups on visible leads completed in the period (last update time of a COMPLETED follow-up).",
    statusInclusion: "status = COMPLETED.", dateField: "lead_follow_ups.updatedAt", aggregation: "count", currency: NO_CCY,
    compute: (s) => prisma.leadFollowUp.count({ where: { organizationId: s.ctx.organizationId, lead: leadVisibilityWhere(s.ctx), status: "COMPLETED", updatedAt: tsRange(s) } }),
  },

  // Inventory (stock tables carry no branch: scoped by company, like stock levels)
  {
    key: "inventory.stock_value", label: "Stock value", section: "inventory", permissions: ["inventory.view"], unit: "money",
    definition: "Σ value of the moving-average stock valuation per company and product (the same cache the finance inventory control compares).",
    statusInclusion: "Every valuation row (written only by posted stock entries).", dateField: "snapshot", aggregation: "sum(stock_valuations.value)", currency: BASE_CCY,
    compute: async (s) => perCurrency(s, (await prisma.stockValuation.groupBy({ by: ["companyId"], where: companyScope(s), _sum: { value: true } })).map((r) => ({ companyId: r.companyId, amount: r._sum.value }))),
  },
  {
    key: "inventory.below_reorder", label: "Products at or below reorder level", section: "inventory", permissions: ["inventory.view"], unit: "count",
    definition: "(company, product) pairs where company-wide available stock (Σ on hand − Σ reserved) ≤ the product's reorder level.",
    statusInclusion: "ACTIVE stocked GOODS with a reorder level.", dateField: "snapshot", aggregation: "count over grouped balances", currency: NO_CCY,
    compute: async (s) => {
      if (!s.companyIds.length) return 0;
      const org = s.ctx.organizationId;
      const [row] = await prisma.$queryRaw<{ n: number }[]>`
        SELECT COUNT(*)::int AS n
        FROM "products" p
        CROSS JOIN unnest(${s.companyIds}::text[]) AS c(id)
        LEFT JOIN (SELECT "companyId", "productId", SUM("quantity") AS q FROM "stock_balances" WHERE "organizationId" = ${org} AND "companyId" = ANY(${s.companyIds}::text[]) GROUP BY 1, 2) b
          ON b."productId" = p."id" AND b."companyId" = c.id
        LEFT JOIN (SELECT "companyId", "productId", SUM("quantity") AS q FROM "stock_reservations" WHERE "organizationId" = ${org} AND "companyId" = ANY(${s.companyIds}::text[]) GROUP BY 1, 2) r
          ON r."productId" = p."id" AND r."companyId" = c.id
        WHERE p."organizationId" = ${org} AND p."status" = 'ACTIVE' AND p."type" = 'GOODS' AND p."trackInventory" AND p."reorderLevel" IS NOT NULL
          AND COALESCE(b.q, 0) - COALESCE(r.q, 0) <= p."reorderLevel"`;
      return row?.n ?? 0;
    },
  },
  {
    key: "inventory.moves_by_type", label: "Stock movements by type", section: "inventory", permissions: ["inventory.view"], unit: "breakdown",
    definition: "Per stock entry type: Σ inbound quantity, Σ outbound quantity (base units, all products) and number of moves in the period. Reversal moves of cancelled entries are included so they net out.",
    statusInclusion: "Every stock move (moves exist only for posted entries and their reversals).", dateField: "stock_moves.movedAt", aggregation: "sum(quantity) split by sign, count; group by stock_entries.type", currency: NO_CCY,
    compute: async (s) => {
      const rows = await prisma.$queryRaw<{ type: string; inQty: Prisma.Decimal | null; outQty: Prisma.Decimal | null; moves: number }[]>`
        SELECT e."type"::text AS type, SUM(m."quantity") FILTER (WHERE m."quantity" > 0) AS "inQty", -SUM(m."quantity") FILTER (WHERE m."quantity" < 0) AS "outQty", COUNT(*)::int AS moves
        FROM "stock_moves" m JOIN "stock_entries" e ON e."id" = m."entryId"
        WHERE ${sqlScope(s.ctx, s.companyIds, "m", false)} AND m."movedAt" >= ${utc(s.fromTs)} AND m."movedAt" < ${utc(s.toExclusive)}
        GROUP BY e."type" ORDER BY e."type"`;
      return rows.map((r) => ({ type: r.type, inQty: dec(r.inQty).toString(), outQty: dec(r.outQty).toString(), moves: r.moves }));
    },
  },

  // Purchasing
  {
    key: "purchasing.open_commitment", label: "Open purchase commitment", section: "purchasing", permissions: ["purchase_order.view"], unit: "money",
    definition: "Σ over purchase order lines of (ordered − received) × net unit price (line taxable value ÷ ordered qty, excl. GST).",
    statusInclusion: "Purchase orders in APPROVED or PARTIALLY_RECEIVED.", dateField: "snapshot", aggregation: "sum((quantity − receivedQty) × taxableAmount ÷ quantity)", currency: BASE_CCY,
    compute: async (s) => {
      const rows = await prisma.$queryRaw<{ companyId: string; amount: Prisma.Decimal }[]>`
        SELECT t."companyId", SUM(GREATEST(l."quantity" - l."receivedQty", 0) * l."taxableAmount" / NULLIF(l."quantity", 0)) AS amount
        FROM "purchase_order_lines" l JOIN "purchase_orders" t ON t."id" = l."purchaseOrderId"
        WHERE ${sqlScope(s.ctx, s.companyIds, "t", true)} AND t."status" IN ('APPROVED', 'PARTIALLY_RECEIVED')
        GROUP BY t."companyId"`;
      return perCurrency(s, rows);
    },
  },
  {
    key: "purchasing.open_orders", label: "Open purchase orders", section: "purchasing", permissions: ["purchase_order.view"], unit: "count",
    definition: "Purchase orders awaiting (more) goods.",
    statusInclusion: "APPROVED or PARTIALLY_RECEIVED.", dateField: "snapshot", aggregation: "count", currency: NO_CCY,
    compute: (s) => prisma.purchaseOrder.count({ where: { ...branchScope(s), status: { in: ["APPROVED", "PARTIALLY_RECEIVED"] } } }),
  },
  {
    key: "purchasing.ordered_value", label: "Purchase orders placed", section: "purchasing", permissions: ["purchase_order.view"], unit: "money",
    definition: "Σ grand total (incl. GST) of purchase orders dated in the period (same set as the procurement report).",
    statusInclusion: "Approved orders: not DRAFT, PENDING_APPROVAL or CANCELLED.", dateField: "purchase_orders.orderDate", aggregation: "sum(grandTotal)", currency: BASE_CCY,
    compute: async (s) => perCurrency(s, (await prisma.purchaseOrder.groupBy({ by: ["companyId"], where: { ...branchScope(s), orderDate: dateRange(s), status: { notIn: ["DRAFT", "PENDING_APPROVAL", "CANCELLED"] } }, _sum: { grandTotal: true } })).map((r) => ({ companyId: r.companyId, amount: r._sum.grandTotal }))),
  },
  {
    key: "purchasing.receipts_value", label: "Goods received (value)", section: "purchasing", permissions: ["purchase_order.view"], unit: "money",
    definition: "Σ stock value (receipt cost, excl. GST) of goods receipts posted in the period against purchase orders in scope.",
    statusInclusion: "GOODS_RECEIPT entries with status POSTED; cancelled receipts excluded.", dateField: "stock_entries.postedAt", aggregation: "sum(stock_moves.value) of non-reversal moves", currency: BASE_CCY,
    compute: async (s) => {
      const rows = await prisma.$queryRaw<{ companyId: string; amount: Prisma.Decimal }[]>`
        SELECT t."companyId", SUM(m."value") AS amount
        FROM "stock_entries" e
        JOIN "purchase_orders" t ON t."id" = e."purchaseOrderId"
        JOIN "stock_moves" m ON m."entryId" = e."id" AND NOT m."isReversal"
        WHERE ${sqlScope(s.ctx, s.companyIds, "t", true)} AND e."type" = 'GOODS_RECEIPT' AND e."status" = 'POSTED'
          AND e."postedAt" >= ${utc(s.fromTs)} AND e."postedAt" < ${utc(s.toExclusive)}
        GROUP BY t."companyId"`;
      return perCurrency(s, rows);
    },
  },

  // Receivables / payables (snapshot; equal to the finance aging report totals)
  ...(["receivables", "payables"] as const).flatMap((kind): Metric[] => {
    const doc = kind === "receivables" ? "sales invoices" : "vendor bills";
    const formula = kind === "receivables" ? "grandTotal − paidAmount − creditedAmount" : "grandTotal − paidAmount − debitedAmount";
    const due = kind === "receivables" ? "dueDate" : "dueDate (else billDate)";
    const base = { section: kind, permissions: [kind === "receivables" ? "invoice.view" : "vendor_bill.view"], statusInclusion: `POSTED ${doc} with a positive balance; DRAFT and CANCELLED excluded.`, dateField: "snapshot", currency: BASE_CCY };
    return [
      { ...base, key: `${kind}.outstanding`, label: "Outstanding", unit: "money", definition: `Σ (${formula}) over posted ${doc}. Equals the finance aging report total.`, aggregation: `sum(${formula})`, compute: async (s) => (await agingOf(s, kind)).outstanding },
      { ...base, key: `${kind}.overdue`, label: "Overdue", unit: "money", definition: `Outstanding balance of posted ${doc} whose ${due} is before today (UTC).`, aggregation: `sum(${formula}) where ${due} < today`, compute: async (s) => (await agingOf(s, kind)).overdue },
      { ...base, key: `${kind}.aging`, label: "Aging buckets", unit: "breakdown", definition: `Outstanding by days past ${due}: current (≤ 0), 1–30, 31–60, 61–90, over 90. Same buckets as the finance aging report.`, aggregation: `sum(${formula}) per bucket`, compute: async (s) => (await agingOf(s, kind)).buckets },
    ];
  }),

  // Expenses
  {
    key: "expenses.approved_by_category", label: "Approved expenses by category", section: "expenses", permissions: ["expense.view"], unit: "breakdown",
    definition: "Σ claim line amounts per expense category for claims approved in the period.",
    statusInclusion: "Claims APPROVED or PAID (approved and not later rejected). Own claims only without expense.approve / expense.pay.", dateField: "expense_claims.approvedAt", aggregation: "sum(expense_claim_lines.amount) group by category", currency: BASE_CCY,
    compute: async (s) => {
      const rows = await prisma.expenseClaimLine.groupBy({ by: ["categoryId"], where: { claim: { ...expenseVisibility(s), status: { in: ["APPROVED", "PAID"] }, approvedAt: tsRange(s) } }, _sum: { amount: true } });
      const categories = await prisma.expenseCategory.findMany({ where: { organizationId: s.ctx.organizationId, id: { in: rows.map((r) => r.categoryId) } }, select: { id: true, name: true, companyId: true } });
      const byId = new Map(categories.map((c) => [c.id, c]));
      return rows
        .map((r) => ({ categoryId: r.categoryId, category: byId.get(r.categoryId)?.name ?? "—", currency: s.currencyOf.get(byId.get(r.categoryId)?.companyId ?? "") ?? null, amount: money(dec(r._sum.amount)).toFixed(2) }))
        .sort((a, b) => dec(b.amount).cmp(a.amount));
    },
  },
  {
    key: "expenses.approved_total", label: "Expenses approved", section: "expenses", permissions: ["expense.view"], unit: "money",
    definition: "Σ total amount of expense claims approved in the period.",
    statusInclusion: "APPROVED or PAID.", dateField: "expense_claims.approvedAt", aggregation: "sum(totalAmount)", currency: BASE_CCY,
    compute: async (s) => perCurrency(s, (await prisma.expenseClaim.groupBy({ by: ["companyId"], where: { ...expenseVisibility(s), status: { in: ["APPROVED", "PAID"] }, approvedAt: tsRange(s) }, _sum: { totalAmount: true } })).map((r) => ({ companyId: r.companyId, amount: r._sum.totalAmount }))),
  },
  {
    key: "expenses.paid_total", label: "Expenses reimbursed", section: "expenses", permissions: ["expense.view"], unit: "money",
    definition: "Σ total amount of expense claims paid out in the period.",
    statusInclusion: "PAID.", dateField: "expense_claims.paidAt", aggregation: "sum(totalAmount)", currency: BASE_CCY,
    compute: async (s) => perCurrency(s, (await prisma.expenseClaim.groupBy({ by: ["companyId"], where: { ...expenseVisibility(s), status: "PAID", paidAt: tsRange(s) }, _sum: { totalAmount: true } })).map((r) => ({ companyId: r.companyId, amount: r._sum.totalAmount }))),
  },
  {
    key: "expenses.awaiting_approval", label: "Claims awaiting approval", section: "expenses", permissions: ["expense.view"], unit: "money",
    definition: "Σ total amount of submitted claims not yet decided.",
    statusInclusion: "SUBMITTED.", dateField: "snapshot", aggregation: "sum(totalAmount)", currency: BASE_CCY,
    compute: async (s) => perCurrency(s, (await prisma.expenseClaim.groupBy({ by: ["companyId"], where: { ...expenseVisibility(s), status: "SUBMITTED" }, _sum: { totalAmount: true } })).map((r) => ({ companyId: r.companyId, amount: r._sum.totalAmount }))),
  },

  // HR
  {
    key: "hr.attendance_by_status", label: "Attendance by status", section: "hr", permissions: ["attendance.view"], unit: "breakdown",
    definition: "Number of attendance records (employee-days) per status in the period, for employees in the caller's company/branch scope.",
    statusInclusion: "All attendance statuses.", dateField: "attendance_records.date", aggregation: "count group by status", currency: NO_CCY,
    compute: async (s) => Object.fromEntries((await prisma.attendanceRecord.groupBy({ by: ["status"], where: { organizationId: s.ctx.organizationId, date: dateRange(s), employee: employeeScope(s) }, _count: { _all: true } })).map((r) => [r.status, r._count._all])),
  },
  {
    key: "hr.leave_days_by_type", label: "Approved leave days by type", section: "hr", permissions: ["leave.view"], unit: "breakdown",
    definition: "Σ working days charged by approved leave requests starting in the period, per leave type (a request is counted whole in the period it starts).",
    statusInclusion: "APPROVED.", dateField: "leave_requests.startDate", aggregation: "sum(days) group by leave type", currency: NO_CCY,
    compute: async (s) => {
      const rows = await prisma.leaveRequest.groupBy({ by: ["leaveTypeId"], where: { organizationId: s.ctx.organizationId, status: "APPROVED", startDate: dateRange(s), employee: employeeScope(s) }, _sum: { days: true }, _count: { _all: true } });
      const types = await prisma.leaveType.findMany({ where: { organizationId: s.ctx.organizationId, id: { in: rows.map((r) => r.leaveTypeId) } }, select: { id: true, code: true, name: true } });
      const byId = new Map(types.map((t) => [t.id, t]));
      return rows.map((r) => ({ leaveTypeId: r.leaveTypeId, code: byId.get(r.leaveTypeId)?.code ?? "—", name: byId.get(r.leaveTypeId)?.name ?? "—", requests: r._count._all, days: dec(r._sum.days).toString() }));
    },
  },
  {
    key: "hr.on_leave_today", label: "On leave today", section: "hr", permissions: ["leave.view"], unit: "count",
    definition: "Employees with an approved leave request covering today (UTC).",
    statusInclusion: "APPROVED.", dateField: "snapshot", aggregation: "count", currency: NO_CCY,
    compute: (s) => prisma.leaveRequest.count({ where: { organizationId: s.ctx.organizationId, status: "APPROVED", startDate: { lte: day(s.today) }, endDate: { gte: day(s.today) }, employee: employeeScope(s) } }),
  },
  {
    key: "hr.headcount", label: "Headcount", section: "hr", permissions: ["employee.view"], unit: "count",
    definition: "Employees currently on the rolls.",
    statusInclusion: "ONBOARDING, ACTIVE or ON_NOTICE (EXITED excluded).", dateField: "snapshot", aggregation: "count", currency: NO_CCY,
    compute: (s) => prisma.employee.count({ where: { ...employeeScope(s), status: { not: "EXITED" } } }),
  },

  // Service
  {
    key: "service.open_by_priority", label: "Open backlog by priority", section: "service", permissions: ["ticket.view"], unit: "breakdown",
    definition: "Visible open tickets per priority (ticket.assign holders see the company; others their assigned or created tickets).",
    statusInclusion: "NEW, OPEN, IN_PROGRESS, ON_HOLD.", dateField: "snapshot", aggregation: "count group by priority", currency: NO_CCY,
    compute: async (s) => Object.fromEntries((await prisma.ticket.groupBy({ by: ["priority"], where: { AND: [ticketsIn(s), { status: { in: ACTIVE_TICKET } }] }, _count: { _all: true } })).map((r) => [r.priority, r._count._all])),
  },
  {
    key: "service.open_backlog", label: "Open tickets", section: "service", permissions: ["ticket.view"], unit: "count",
    definition: "Visible open tickets.",
    statusInclusion: "NEW, OPEN, IN_PROGRESS, ON_HOLD.", dateField: "snapshot", aggregation: "count", currency: NO_CCY,
    compute: (s) => prisma.ticket.count({ where: { AND: [ticketsIn(s), { status: { in: ACTIVE_TICKET } }] } }),
  },
  ...((): Metric[] => {
    const resolved = (s: Scope) => once(s, "tickets:resolved", async () => {
      const assign = can(s.ctx, "ticket.assign");
      const [row] = await prisma.$queryRaw<{ resolved: number; targeted: number; breached: number; avgSeconds: number | null }[]>`
        SELECT COUNT(*)::int AS resolved,
          COUNT(*) FILTER (WHERE t."resolutionDueAt" IS NOT NULL)::int AS targeted,
          COUNT(*) FILTER (WHERE t."resolvedAt" > t."resolutionDueAt")::int AS breached,
          AVG(EXTRACT(EPOCH FROM (t."resolvedAt" - t."createdAt")))::float8 AS "avgSeconds"
        FROM "tickets" t
        WHERE ${sqlScope(s.ctx, s.companyIds, "t", false)}
          AND (${assign}::boolean OR t."assigneeId" = ${s.ctx.userId}::uuid OR t."createdById" = ${s.ctx.userId}::uuid)
          AND t."resolvedAt" >= ${utc(s.fromTs)} AND t."resolvedAt" < ${utc(s.toExclusive)}`;
      return row;
    });
    const base = { section: "service" as const, permissions: ["ticket.view"], statusInclusion: "Visible tickets with resolvedAt in the period, whatever their current status.", dateField: "tickets.resolvedAt", currency: NO_CCY };
    return [
      { ...base, key: "service.resolved", label: "Tickets resolved", unit: "count", definition: "Visible tickets resolved in the period.", aggregation: "count", compute: async (s) => (await resolved(s)).resolved },
      { ...base, key: "service.sla_breach_rate", label: "Resolution SLA breach rate", unit: "percent", definition: "Breached ÷ tickets with a resolution target × 100 (1 dp), where breached = resolvedAt > resolutionDueAt. Same rule as the service report.", aggregation: "count ratio", compute: async (s) => { const r = await resolved(s); return pct(r.breached, r.targeted); } },
      { ...base, key: "service.avg_resolution_hours", label: "Avg resolution time", unit: "hours", definition: "Mean of (resolvedAt − createdAt) in hours (1 dp) over tickets resolved in the period.", aggregation: "avg(resolvedAt − createdAt)", compute: async (s) => { const r = await resolved(s); return r.avgSeconds === null ? null : Math.round((r.avgSeconds / 3600) * 10) / 10; } },
    ];
  })(),

  // Projects
  {
    key: "projects.active", label: "Active projects: progress and budget", section: "projects", permissions: ["project.view"], unit: "breakdown",
    definition: "Per ACTIVE project (first 50 by code): progress = DONE tasks ÷ non-cancelled tasks × 100; hours = all logged hours; actual cost = hours × project hourly rate; budget used = actual ÷ budget × 100.",
    statusInclusion: "Projects with status ACTIVE visible to the caller (project.update, else membership). Tasks: CANCELLED excluded from the denominator.", dateField: "snapshot (all-time hours)", aggregation: "count tasks group by project/status; sum(time_entries.hours) group by project", currency: "Budget and cost in the project's company base currency (shown per project).",
    compute: async (s) => {
      const projects = await prisma.project.findMany({ where: { AND: [projectsIn(s), { status: "ACTIVE" }] }, select: { id: true, code: true, name: true, companyId: true, budget: true, hourlyRate: true }, orderBy: { code: "asc" }, take: 50 });
      const ids = projects.map((p) => p.id);
      const [tasks, hours] = await Promise.all([
        prisma.projectTask.groupBy({ by: ["projectId", "status"], where: { projectId: { in: ids }, status: { not: "CANCELLED" } }, _count: { _all: true } }),
        prisma.timeEntry.groupBy({ by: ["projectId"], where: { projectId: { in: ids } }, _sum: { hours: true } }),
      ]);
      return projects.map((p) => {
        const mine = tasks.filter((t) => t.projectId === p.id);
        const total = mine.reduce((n, t) => n + t._count._all, 0);
        const done = mine.find((t) => t.status === "DONE")?._count._all ?? 0;
        const logged = dec(hours.find((h) => h.projectId === p.id)?._sum.hours);
        const actual = p.hourlyRate ? money(logged.mul(p.hourlyRate)) : null;
        return {
          projectId: p.id, code: p.code, name: p.name, currency: s.currencyOf.get(p.companyId) ?? null,
          tasks: total, done, progress: pct(done, total), hours: logged.toString(),
          budget: p.budget?.toFixed(2) ?? null, actualCost: actual?.toFixed(2) ?? null,
          budgetUsedPercent: actual && p.budget?.gt(0) ? actual.div(p.budget).mul(100).toDecimalPlaces(1).toNumber() : null,
        };
      });
    },
  },
  {
    key: "projects.overall_progress", label: "Overall progress (active projects)", section: "projects", permissions: ["project.view"], unit: "percent",
    definition: "Σ DONE tasks ÷ Σ non-cancelled tasks × 100 (1 dp) over all visible ACTIVE projects.",
    statusInclusion: "ACTIVE projects; CANCELLED tasks excluded.", dateField: "snapshot", aggregation: "count ratio", currency: NO_CCY,
    compute: async (s) => {
      const rows = await prisma.projectTask.groupBy({ by: ["status"], where: { status: { not: "CANCELLED" }, project: { AND: [projectsIn(s), { status: "ACTIVE" }] } }, _count: { _all: true } });
      return pct(rows.find((r) => r.status === "DONE")?._count._all ?? 0, rows.reduce((n, r) => n + r._count._all, 0));
    },
  },
  {
    key: "projects.hours_logged", label: "Hours logged", section: "projects", permissions: ["project.view"], unit: "breakdown",
    definition: "Σ timesheet hours dated in the period on visible projects, split billable / non-billable.",
    statusInclusion: "Every time entry on a visible project (any project status).", dateField: "time_entries.date", aggregation: "sum(hours) group by billable", currency: NO_CCY,
    compute: async (s) => {
      const rows = await prisma.timeEntry.groupBy({ by: ["billable"], where: { organizationId: s.ctx.organizationId, date: dateRange(s), project: projectsIn(s) }, _sum: { hours: true } });
      const billable = sum(rows.filter((r) => r.billable), "hours");
      const total = sum(rows, "hours");
      return { total: total.toString(), billable: billable.toString(), nonBillable: total.sub(billable).toString() };
    },
  },
];

export const visibleMetrics = (ctx: AccessContext) => METRICS.filter((m) => m.permissions.every((p) => can(ctx, p)));

/** Metric definitions (no values) the caller may see. */
export function listMetricDefinitions(ctx: AccessContext) {
  assertCan(ctx, "dashboard.view");
  return visibleMetrics(ctx).map(({ compute: _, ...m }) => m);
}

/**
 * Dashboard: one entry per section the caller holds at least one metric permission for;
 * other sections are omitted (not a 403 for the whole dashboard).
 */
export async function getDashboard(ctx: AccessContext, query: unknown, now = new Date()) {
  assertCan(ctx, "dashboard.view");
  const s = await resolveScope(ctx, query, now);
  const metrics = visibleMetrics(ctx);
  const values = await Promise.all(metrics.map((m) => m.compute(s)));
  const sections = SECTIONS.map((section) => ({
    ...section,
    metrics: metrics
      .map((m, i) => ({ m, value: values[i] }))
      .filter(({ m }) => m.section === section.key)
      .map(({ m: { compute: _, ...meta }, value }) => ({ ...meta, value })),
  })).filter((section) => section.metrics.length > 0);
  return {
    period: { from: s.from, to: s.to },
    asOf: s.now,
    companies: s.companies,
    currencies: [...new Set(s.companies.map((c) => c.currency))],
    sections,
  };
}
