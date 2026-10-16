# Business metrics (analytics dashboard)

Code: `src/features/analytics/metrics.ts` (registry `METRICS`), shared scope helpers in
`src/features/analytics/scope.ts`, MIS in `src/features/analytics/mis.ts`.
API: `GET /api/v1/analytics`, `GET /api/v1/analytics/metrics`, `GET /api/v1/mis` (see `docs/api/analytics-reports.md`).
UI: `/analytics` (each card's **?** shows the definition below), `/analytics/mis`.

## Rules that apply to every metric

- **Source.** Every figure is an aggregate query (`count` / `groupBy` / `aggregate`, or parameterized
  `$queryRaw` for column arithmetic) over the operational tables. No metric loads rows into the app to add them up.
- **Tenant and scope.** Always the caller's organization. Company/branch documents use the member's company and
  branch scopes (`companyScopeWhere` semantics); tables without a branch (stock, tickets, expense claims,
  receipts) use the member's companies. Module visibility rules are applied on top:
  leads (`lead.view_all` or assigned), tickets (`ticket.assign` or assignee/creator), expense claims
  (`expense.approve`/`expense.pay` or own claims), projects (`project.update` or membership).
  `?companyId=` narrows to one company in scope (404 otherwise).
- **Permissions.** `GET /analytics` needs `dashboard.view`. Each metric lists the permissions it needs; a
  section appears only when the caller holds at least one of its metrics' permissions. Missing sections are
  omitted, not a 403.
- **Period.** `from`..`to`, inclusive, `yyyy-mm-dd`, UTC calendar days. Default: first day of the current month
  to today. `@db.Date` columns compare as dates; timestamp columns use `[from 00:00 UTC, to+1 00:00 UTC)`.
  Metrics whose date field says **snapshot** describe the state now and ignore the period.
- **Currency.** Money is summed per company and folded per company **base currency**; the result is a map
  `{ "INR": "1234.00" }`. Different currencies are never added together. Every currency of the selected
  companies appears (with `"0.00"` when empty). Amounts are decimal strings with 2 dp.
- **Percentages** are 0–100 with 1 dp, `null` when the denominator is zero.
- **Consistency checks** (tests/analytics-reports.db.test.ts): receivables/payables equal the finance aging
  report totals and buckets; the SLA breach rate equals the service report; sums equal the underlying rows.

## Metrics

### Sales and quotations (`sales`)

| Key | Metric | Definition | Included records | Date field | Aggregation | Currency | Permission |
|---|---|---|---|---|---|---|---|
| `sales.quotations_created` | Quotations created | Number of quotations created in the period (each live revision counts once). | All statuses except SUPERSEDED (replaced revisions). | quotations.createdAt | count | Not a money value. | `quotation.view` |
| `sales.quotations_sent` | Quotations sent | Number of quotations marked sent to the customer in the period. | Any status, as long as sentAt falls in the period (a later revision does not undo a send). | quotations.sentAt | count | Not a money value. | `quotation.view` |
| `sales.quotations_accepted` | Quotations accepted | Number of quotations the customer accepted in the period. | status = ACCEPTED. | quotations.decidedAt | count | Not a money value. | `quotation.view` |
| `sales.quotations_accepted_value` | Accepted quotation value | Σ grand total (incl. GST) of quotations accepted in the period. | status = ACCEPTED. | quotations.decidedAt | sum(grandTotal) | Company base currency; summed per company, reported per currency (never mixed). | `quotation.view` |
| `sales.quotation_conversion_rate` | Quotation conversion rate | Accepted ÷ decided × 100, where decided = accepted + rejected in the period (1 dp; null when nothing was decided). | ACCEPTED and REJECTED only. EXPIRED, open and superseded quotations are not decisions. | quotations.decidedAt | count ratio | Not a money value. | `quotation.view` |
| `sales.orders_confirmed` | Sales orders confirmed | Number of sales orders confirmed in the period. | Confirmed orders (CONFIRMED, PARTIALLY_DELIVERED, DELIVERED); CANCELLED and DRAFT excluded. | sales_orders.confirmedAt | count | Not a money value. | `sales_order.view` |
| `sales.orders_value` | Sales order value | Σ grand total (incl. GST) of sales orders confirmed in the period. | Confirmed orders (CONFIRMED, PARTIALLY_DELIVERED, DELIVERED); CANCELLED and DRAFT excluded. | sales_orders.confirmedAt | sum(grandTotal) | Company base currency; summed per company, reported per currency (never mixed). | `sales_order.view` |
| `sales.invoiced_value` | Invoiced (taxable value) | Σ taxable value (excl. GST) of sales invoices dated in the period. Credit notes are not deducted here (see MIS net revenue). | status = POSTED. DRAFT and CANCELLED excluded. | sales_invoices.invoiceDate | sum(taxableTotal) | Company base currency; summed per company, reported per currency (never mixed). | `invoice.view` |
| `sales.invoiced_gross` | Invoiced (incl. GST) | Σ grand total (incl. GST) of sales invoices dated in the period. | status = POSTED. DRAFT and CANCELLED excluded. | sales_invoices.invoiceDate | sum(grandTotal) | Company base currency; summed per company, reported per currency (never mixed). | `invoice.view` |

### Lead pipeline and follow-ups (`leads`)

| Key | Metric | Definition | Included records | Date field | Aggregation | Currency | Permission |
|---|---|---|---|---|---|---|---|
| `leads.new` | New leads | Leads created in the period that the caller can see (lead.view_all, else assigned to the caller). | All statuses; archived leads excluded. | leads.createdAt | count | Not a money value. | `lead.view` |
| `leads.converted` | Leads converted | Visible leads converted to a customer in the period. | convertedAt set and a converted customer linked. | leads.convertedAt | count | Not a money value. | `lead.view` |
| `leads.pipeline_by_stage` | Open pipeline by stage | Current open leads grouped by pipeline stage: count and Σ expected value per stage. | Open leads: status not CONVERTED or LOST, not archived. | snapshot | count, sum(expectedValue) group by stage | Expected value is a plain lead estimate (no currency on leads). | `lead.view` |
| `leads.followups_due` | Follow-ups due in period | Pending follow-ups on visible leads whose due time falls in the period. | status = PENDING. | lead_follow_ups.dueAt | count | Not a money value. | `lead.view` |
| `leads.followups_overdue` | Overdue follow-ups | Pending follow-ups on visible leads that are past due right now. | status = PENDING and dueAt < now. | snapshot | count | Not a money value. | `lead.view` |
| `leads.followups_completed` | Follow-ups completed | Follow-ups on visible leads completed in the period (last update time of a COMPLETED follow-up). | status = COMPLETED. | lead_follow_ups.updatedAt | count | Not a money value. | `lead.view` |

### Inventory (`inventory`)

| Key | Metric | Definition | Included records | Date field | Aggregation | Currency | Permission |
|---|---|---|---|---|---|---|---|
| `inventory.stock_value` | Stock value | Σ value of the moving-average stock valuation per company and product (the same cache the finance inventory control compares). | Every valuation row (written only by posted stock entries). | snapshot | sum(stock_valuations.value) | Company base currency; summed per company, reported per currency (never mixed). | `inventory.view` |
| `inventory.below_reorder` | Products at or below reorder level | (company, product) pairs where company-wide available stock (Σ on hand − Σ reserved) ≤ the product's reorder level. | ACTIVE stocked GOODS with a reorder level. | snapshot | count over grouped balances | Not a money value. | `inventory.view` |
| `inventory.moves_by_type` | Stock movements by type | Per stock entry type: Σ inbound quantity, Σ outbound quantity (base units, all products) and number of moves in the period. Reversal moves of cancelled entries are included so they net out. | Every stock move (moves exist only for posted entries and their reversals). | stock_moves.movedAt | sum(quantity) split by sign, count; group by stock_entries.type | Not a money value. | `inventory.view` |

### Purchasing (`purchasing`)

| Key | Metric | Definition | Included records | Date field | Aggregation | Currency | Permission |
|---|---|---|---|---|---|---|---|
| `purchasing.open_commitment` | Open purchase commitment | Σ over purchase order lines of (ordered − received) × net unit price (line taxable value ÷ ordered qty, excl. GST). | Purchase orders in APPROVED or PARTIALLY_RECEIVED. | snapshot | sum((quantity − receivedQty) × taxableAmount ÷ quantity) | Company base currency; summed per company, reported per currency (never mixed). | `purchase_order.view` |
| `purchasing.open_orders` | Open purchase orders | Purchase orders awaiting (more) goods. | APPROVED or PARTIALLY_RECEIVED. | snapshot | count | Not a money value. | `purchase_order.view` |
| `purchasing.ordered_value` | Purchase orders placed | Σ grand total (incl. GST) of purchase orders dated in the period (same set as the procurement report). | Approved orders: not DRAFT, PENDING_APPROVAL or CANCELLED. | purchase_orders.orderDate | sum(grandTotal) | Company base currency; summed per company, reported per currency (never mixed). | `purchase_order.view` |
| `purchasing.receipts_value` | Goods received (value) | Σ stock value (receipt cost, excl. GST) of goods receipts posted in the period against purchase orders in scope. | GOODS_RECEIPT entries with status POSTED; cancelled receipts excluded. | stock_entries.postedAt | sum(stock_moves.value) of non-reversal moves | Company base currency; summed per company, reported per currency (never mixed). | `purchase_order.view` |

### Receivables (`receivables`)

| Key | Metric | Definition | Included records | Date field | Aggregation | Currency | Permission |
|---|---|---|---|---|---|---|---|
| `receivables.outstanding` | Outstanding | Σ (grandTotal − paidAmount − creditedAmount) over posted sales invoices. Equals the finance aging report total. | POSTED sales invoices with a positive balance; DRAFT and CANCELLED excluded. | snapshot | sum(grandTotal − paidAmount − creditedAmount) | Company base currency; summed per company, reported per currency (never mixed). | `invoice.view` |
| `receivables.overdue` | Overdue | Outstanding balance of posted sales invoices whose dueDate is before today (UTC). | POSTED sales invoices with a positive balance; DRAFT and CANCELLED excluded. | snapshot | sum(grandTotal − paidAmount − creditedAmount) where dueDate < today | Company base currency; summed per company, reported per currency (never mixed). | `invoice.view` |
| `receivables.aging` | Aging buckets | Outstanding by days past dueDate: current (≤ 0), 1–30, 31–60, 61–90, over 90. Same buckets as the finance aging report. | POSTED sales invoices with a positive balance; DRAFT and CANCELLED excluded. | snapshot | sum(grandTotal − paidAmount − creditedAmount) per bucket | Company base currency; summed per company, reported per currency (never mixed). | `invoice.view` |

### Payables (`payables`)

| Key | Metric | Definition | Included records | Date field | Aggregation | Currency | Permission |
|---|---|---|---|---|---|---|---|
| `payables.outstanding` | Outstanding | Σ (grandTotal − paidAmount − debitedAmount) over posted vendor bills. Equals the finance aging report total. | POSTED vendor bills with a positive balance; DRAFT and CANCELLED excluded. | snapshot | sum(grandTotal − paidAmount − debitedAmount) | Company base currency; summed per company, reported per currency (never mixed). | `vendor_bill.view` |
| `payables.overdue` | Overdue | Outstanding balance of posted vendor bills whose dueDate (else billDate) is before today (UTC). | POSTED vendor bills with a positive balance; DRAFT and CANCELLED excluded. | snapshot | sum(grandTotal − paidAmount − debitedAmount) where dueDate (else billDate) < today | Company base currency; summed per company, reported per currency (never mixed). | `vendor_bill.view` |
| `payables.aging` | Aging buckets | Outstanding by days past dueDate (else billDate): current (≤ 0), 1–30, 31–60, 61–90, over 90. Same buckets as the finance aging report. | POSTED vendor bills with a positive balance; DRAFT and CANCELLED excluded. | snapshot | sum(grandTotal − paidAmount − debitedAmount) per bucket | Company base currency; summed per company, reported per currency (never mixed). | `vendor_bill.view` |

### Expenses (`expenses`)

| Key | Metric | Definition | Included records | Date field | Aggregation | Currency | Permission |
|---|---|---|---|---|---|---|---|
| `expenses.approved_by_category` | Approved expenses by category | Σ claim line amounts per expense category for claims approved in the period. | Claims APPROVED or PAID (approved and not later rejected). Own claims only without expense.approve / expense.pay. | expense_claims.approvedAt | sum(expense_claim_lines.amount) group by category | Company base currency; summed per company, reported per currency (never mixed). | `expense.view` |
| `expenses.approved_total` | Expenses approved | Σ total amount of expense claims approved in the period. | APPROVED or PAID. | expense_claims.approvedAt | sum(totalAmount) | Company base currency; summed per company, reported per currency (never mixed). | `expense.view` |
| `expenses.paid_total` | Expenses reimbursed | Σ total amount of expense claims paid out in the period. | PAID. | expense_claims.paidAt | sum(totalAmount) | Company base currency; summed per company, reported per currency (never mixed). | `expense.view` |
| `expenses.awaiting_approval` | Claims awaiting approval | Σ total amount of submitted claims not yet decided. | SUBMITTED. | snapshot | sum(totalAmount) | Company base currency; summed per company, reported per currency (never mixed). | `expense.view` |

### Attendance and leave (`hr`)

| Key | Metric | Definition | Included records | Date field | Aggregation | Currency | Permission |
|---|---|---|---|---|---|---|---|
| `hr.attendance_by_status` | Attendance by status | Number of attendance records (employee-days) per status in the period, for employees in the caller's company/branch scope. | All attendance statuses. | attendance_records.date | count group by status | Not a money value. | `attendance.view` |
| `hr.leave_days_by_type` | Approved leave days by type | Σ working days charged by approved leave requests starting in the period, per leave type (a request is counted whole in the period it starts). | APPROVED. | leave_requests.startDate | sum(days) group by leave type | Not a money value. | `leave.view` |
| `hr.on_leave_today` | On leave today | Employees with an approved leave request covering today (UTC). | APPROVED. | snapshot | count | Not a money value. | `leave.view` |
| `hr.headcount` | Headcount | Employees currently on the rolls. | ONBOARDING, ACTIVE or ON_NOTICE (EXITED excluded). | snapshot | count | Not a money value. | `employee.view` |

### Service tickets (`service`)

| Key | Metric | Definition | Included records | Date field | Aggregation | Currency | Permission |
|---|---|---|---|---|---|---|---|
| `service.open_by_priority` | Open backlog by priority | Visible open tickets per priority (ticket.assign holders see the company; others their assigned or created tickets). | NEW, OPEN, IN_PROGRESS, ON_HOLD. | snapshot | count group by priority | Not a money value. | `ticket.view` |
| `service.open_backlog` | Open tickets | Visible open tickets. | NEW, OPEN, IN_PROGRESS, ON_HOLD. | snapshot | count | Not a money value. | `ticket.view` |
| `service.resolved` | Tickets resolved | Visible tickets resolved in the period. | Visible tickets with resolvedAt in the period, whatever their current status. | tickets.resolvedAt | count | Not a money value. | `ticket.view` |
| `service.sla_breach_rate` | Resolution SLA breach rate | Breached ÷ tickets with a resolution target × 100 (1 dp), where breached = resolvedAt > resolutionDueAt. Same rule as the service report. | Visible tickets with resolvedAt in the period, whatever their current status. | tickets.resolvedAt | count ratio | Not a money value. | `ticket.view` |
| `service.avg_resolution_hours` | Avg resolution time | Mean of (resolvedAt − createdAt) in hours (1 dp) over tickets resolved in the period. | Visible tickets with resolvedAt in the period, whatever their current status. | tickets.resolvedAt | avg(resolvedAt − createdAt) | Not a money value. | `ticket.view` |

### Projects (`projects`)

| Key | Metric | Definition | Included records | Date field | Aggregation | Currency | Permission |
|---|---|---|---|---|---|---|---|
| `projects.active` | Active projects: progress and budget | Per ACTIVE project (first 50 by code): progress = DONE tasks ÷ non-cancelled tasks × 100; hours = all logged hours; actual cost = hours × project hourly rate; budget used = actual ÷ budget × 100. | Projects with status ACTIVE visible to the caller (project.update, else membership). Tasks: CANCELLED excluded from the denominator. | snapshot (all-time hours) | count tasks group by project/status; sum(time_entries.hours) group by project | Budget and cost in the project's company base currency (shown per project). | `project.view` |
| `projects.overall_progress` | Overall progress (active projects) | Σ DONE tasks ÷ Σ non-cancelled tasks × 100 (1 dp) over all visible ACTIVE projects. | ACTIVE projects; CANCELLED tasks excluded. | snapshot | count ratio | Not a money value. | `project.view` |
| `projects.hours_logged` | Hours logged | Σ timesheet hours dated in the period on visible projects, split billable / non-billable. | Every time entry on a visible project (any project status). | time_entries.date | sum(hours) group by billable | Not a money value. | `project.view` |


## Management MIS (`GET /api/v1/mis`)

One company (default: the caller's first company by code) and period; needs `finance.report`. All amounts are
in that company's base currency. Every line in the response carries a `source` string.

| Line | Source |
|---|---|
| Revenue (invoiced) | `sales_invoices` POSTED, Σ `taxableTotal`, `invoiceDate` in period |
| Less credit notes | `credit_notes` POSTED, Σ `taxableTotal`, `noteDate` in period |
| Net revenue | invoiced − credit notes |
| Receivables / payables outstanding and overdue | same as the dashboard metrics (= aging report totals), as of today |
| Purchase spend | `vendor_bills` POSTED, Σ `taxableTotal`, `billDate` in period |
| Expense claims approved | `expense_claims` APPROVED/PAID, Σ `totalAmount`, `approvedAt` in period |
| Sales revenue (ledger), COGS, gross profit, gross margin % | journal lines on the `SALES_REVENUE` / `COGS` mapped accounts, journals POSTED/REVERSED dated in period. Margin = (revenue − COGS) ÷ revenue |
| Cash and bank balances | per bank/cash account: Σ debit − credit on its ledger account, journals POSTED/REVERSED dated ≤ period end |
| Top customers / products / vendors | `groupBy` with `orderBy _sum desc, take 10` over posted invoices, invoice lines and bills in period |

When finance is not enabled for the company, the ledger lines (COGS, gross margin, cash/bank) are listed in
`omitted` with the reason instead of being shown as zero.

## Recommended indexes (not yet in the schema)

The metrics work today using the existing `(organizationId, companyId, status…)` indexes; these would keep
period filters index-only on large tenants:

- `sales_invoices (organizationId, companyId, status, invoiceDate)`
- `quotations (organizationId, companyId, decidedAt)` and `(organizationId, companyId, createdAt)`
- `sales_orders (organizationId, companyId, confirmedAt)`
- `stock_moves (organizationId, companyId, movedAt)`
- `stock_entries (organizationId, companyId, type, status, postedAt)` (extend the existing index)
- `tickets (organizationId, companyId, resolvedAt)`
- `attendance_records (organizationId, date)`
- `leave_requests (organizationId, status, startDate)`
- `expense_claims (organizationId, companyId, status, approvedAt)`
- `vendor_bills (organizationId, companyId, status, billDate)`
- `credit_notes (organizationId, companyId, status, noteDate)`
- `data_exports (organizationId, requestedById, createdAt)`; `saved_reports (organizationId, createdById)`
