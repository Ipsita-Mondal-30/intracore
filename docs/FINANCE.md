# Finance: accounting model, posting rules and assumptions

Code: `src/features/finance/`. The ledger writer is `ledger.ts`; nothing else creates journals.

> **Review required.** This is a working double-entry implementation built for Indian GST
> businesses. A qualified accountant should review three things before you rely on it for
> statutory books or tax filing:
> - the chart of accounts template;
> - the posting rules below;
> - the GST classification.

## Turning accounting on

Finance is **off** per company until `POST /companies/:id/finance/setup`
(`{ accountingStartDate, fiscalYearStartMonth = 4 }`). Setup creates:

- a starter chart of accounts and the account mappings;
- the fiscal year containing the start date, split into 12 monthly periods (all OPEN);
- default *Cash* and *Primary bank* accounts, and default expense categories.

Documents dated **before** `accountingStartDate` stay operational only and never create a
journal. Bring opening balances in with a manual journal, and opening stock with an
`OPENING` stock entry.

## Ledger rules (enforced twice: service and database)

| Rule | Service | Database |
|---|---|---|
| Σ debit = Σ credit > 0 for every posted journal | `postJournal` → `UNBALANCED` | deferred constraint triggers `journal_lines_balanced`, `journal_entries_balanced` |
| A line is either a debit or a credit, never negative | normalisation | `CHECK journal_lines_amounts_check` |
| Posted journals are never edited or deleted | no update paths | triggers `journal_lines_immutable`, `journal_entries_immutable` (only POSTED → REVERSED is allowed) |
| Dated in an OPEN accounting period | `PERIOD_CLOSED` / `NO_PERIOD` | — |
| Accounts are active, non-group, same company | `INVALID_ACCOUNT` | composite FK (organizationId, companyId, accountId) |
| Mapping keys must be configured | `MAPPING_MISSING` (never guesses an account) | composite FK on `account_mappings` |
| One journal per business event | returns the existing journal (retry-safe) | `UNIQUE (companyId, sourceType, sourceId, sourceEvent)` |

**Rounding:** money is `Decimal(18,2)`, rounded half-up to 2 dp per line. GST on an intra-state
line is split by rounding the CGST half and setting SGST equal to it, so CGST = SGST exactly.
There is no invoice-level round-off to the rupee.

**Corrections:** cancelling a source document writes an equal and opposite reversal journal,
dated on the cancellation day and linked by `reversalOfId`. The original is marked `REVERSED`.
Manual journals are reversed with `POST /journals/:id/reverse`.

**Period close:** periods close in order, and only when they hold no draft journals. Reopening
needs a reason, which is audited. Closed periods reject every posting, including reversals.
No year-end closing entries are posted; the balance sheet shows accumulated profit as its own
equity line.

## When each business event creates a journal

| Event | Journal (`sourceType`) | Debit | Credit |
|---|---|---|---|
| Sales invoice **posted** | SALES_INVOICE | Accounts receivable (grand total, customer-tagged) | Sales revenue (taxable value); Output CGST / SGST / IGST |
| Credit note posted | CREDIT_NOTE | Sales revenue; Output GST | Accounts receivable |
| Receipt posted | RECEIPT | Bank/cash ledger | Accounts receivable |
| Vendor bill **posted** | VENDOR_BILL | Stocked PO lines: GRNI at receipt cost, plus price variance for any difference. Other lines: purchases/expense. Input CGST / SGST / IGST | Accounts payable (grand total, vendor-tagged) |
| Debit note posted | DEBIT_NOTE | Accounts payable | Mirror of the bill lines (GRNI / expense, input GST) |
| Vendor payment posted | VENDOR_PAYMENT | Accounts payable | Bank/cash ledger |
| Goods receipt posted | STOCK_ENTRY | Inventory (stock value) | GRNI |
| Delivery posted | STOCK_ENTRY | Cost of goods sold | Inventory (moving-average cost) |
| Sales return posted | STOCK_ENTRY | Inventory | Cost of goods sold |
| Purchase return posted | STOCK_ENTRY | GRNI | Inventory |
| Opening stock | STOCK_ENTRY | Inventory | Opening balance equity |
| Misc. receipt / issue / adjustment | STOCK_ENTRY | Inventory or Stock adjustments | the other one |
| Stock transfer (same company) | — | (no journal: value unchanged) | |
| Expense claim **approved** | EXPENSE_CLAIM / approve | Each category's expense account | Employee reimbursements payable |
| Expense claim **paid** | EXPENSE_CLAIM / pay | Employee reimbursements payable | Bank/cash ledger |
| Bank/cash transfer | TRANSFER | Destination ledger | Source ledger |
| Manual journal posted | MANUAL | as entered | as entered |

**Events that never create a journal:**
- quotation accepted;
- sales order confirmed;
- stock reserved;
- purchase order approved;
- invoice / bill / credit note saved as a draft;
- expense claim submitted;
- bank statement imported.

Accepting a quotation or confirming an order is **not** a sale or a payment.

## Receivables and payables

- An invoice's outstanding balance = grand total − paid − credited. Bills work the same way.
- Settlement is recorded as allocations: receipt or credit note → invoice, payment or debit note → bill.
  - Allocating locks the target rows. An allocation may not exceed the outstanding balance
    (`OVERPAYMENT`), or the source's unallocated amount (`OVERALLOCATED`).
  - The unallocated part of a receipt stays on account (a credit balance for the customer)
    until it is allocated. Nothing is silently written off.
- Invoice numbers are assigned **on posting**, per fiscal year (`INV/26-27/00001`, ≤ 16
  characters). A failed posting rolls back, so issued numbers have no gaps.
- **Controlled cancellation:**
  - a posted invoice can be cancelled only while nothing is settled against it;
  - otherwise reverse the receipts or issue a credit note;
  - posted bills follow the same rule with payments and debit notes.
- Goods invoice only once delivered (net of returns); services invoice up to the ordered quantity.
  `SalesOrderLine.invoicedQty` prevents double invoicing.
- Bills above `settings.purchase.billApprovalAmount` need approval, and the person who entered
  the bill cannot approve it.
- Posting enforces three-way match (billed ≤ received − returned).
- The overdue-invoice job notifies the customer owner internally, at most once every
  `settings.receivables.reminderIntervalDays`. Emailing customers goes through the communication centre.

## GST

- **Rates are not hardcoded.** Each tax code has effective-dated versions (`TaxRateVersion`),
  and documents snapshot the rate in force on their own date. `POST /tax-rates/:id/versions` schedules a change.
- **Supply type per tax code** (`TaxKind`: TAXABLE, EXEMPT, NIL_RATED, ZERO_RATED, NON_GST)
  drives GSTR-1 classification.
- **Intra- vs inter-state:** CGST+SGST when the seller state equals the place of supply, otherwise IGST.
  - Seller state is the branch GSTIN/state, falling back to the company.
  - Place of supply defaults to the customer's state.
- **Multi-GSTIN:** a branch with its own GSTIN is its own registration. Invoices snapshot the
  seller GSTIN, and returns are prepared per GSTIN.
- **Posting validates:**
  - the place of supply is a valid GST state code;
  - B2B customer GSTINs pass the GSTN check digit.
- **Return preparation** (`/companies/:id/reports/gstr1|gstr3b`) builds review summaries:
  - GSTR-1: B2B, B2CL, B2CS, credit/debit notes, nil/exempt, HSN summary and document ranges;
  - GSTR-3B: outward tax, and ITC from posted bills.
  
  **Nothing is filed.** Two things need a qualified person:
  - the B2CL threshold is a setting (`settings.gst.b2clThreshold`) — confirm the current figure;
  - ITC eligibility (blocked credits, GSTR-2B matching, reversals) is not modelled.
- **E-invoice and e-way bills:**
  - `GET /sales-invoices/:id/einvoice-payload` builds the IRP payload and lists blocking problems;
  - registration needs an explicitly configured provider adapter (`EInvoiceProvider`), and
    without one the API returns `NOT_CONFIGURED`;
  - PIN codes are not captured yet, so payloads are reported as not ready;
  - e-way bills are not implemented.
- **Not supported:** reverse charge on sales, TDS/TCS, export with/without payment
  (LUT) flows, and composition-scheme invoices.

## Bank and cash

There is **no live bank connection.**
- Statements come in as manual CSV imports (`BankImport`); re-importing an overlapping file skips
  rows that already exist.
- Reconciliation matches one statement line to one ledger line that moved the same bank
  account by the same amount.
- Receipts and payments report `reconciled: true` once their bank line is matched.
- The cashbook is the bank/cash ledger with a running balance.

## Reports

All reports read posted (and reversed) journals in the database; drafts never count.

| Report | What it shows |
|---|---|
| Trial balance | Totals debit = credit |
| General ledger | Opening balance + lines + running balance |
| Profit & loss | For a date range |
| Balance sheet | As of a date; shows whether assets = liabilities + equity + accumulated profit |
| Receivables / payables aging | Buckets: current, 1–30, 31–60, 61–90, 90+ days past due, plus unapplied credits |
| Customer / vendor statements | From posted documents with a running balance |
| Reconciliation | Every posted document since accounting start has a matching journal. Control accounts (AR, AP, inventory) agree with the documents and stock valuation. |

## Assumptions a reviewer should check

1. **Perpetual inventory with GRNI.** If a goods receipt was posted before accounting started
   but its bill after, GRNI will show a balance; clear it with a manual journal. A debit note's
   GRNI credit uses the billed price, so a price-corrected return can leave a small GRNI residue.
2. **Expense claims don't claim input GST** (employee bills usually aren't in the company's
   GSTIN); the full amount is expensed.
3. **Credit notes reduce revenue and output tax** in the period they are issued.
   Goods coming back are a separate sales-return stock entry.
4. **Cancellations reverse in the cancellation period,** not the original period.
5. **One currency per company** (the company's base currency). Multi-currency, exchange-rate
   differences and revaluation are not implemented.
