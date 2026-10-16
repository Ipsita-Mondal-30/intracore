# IntraCore API v1

All ERP endpoints live under `/api/v1`. The CRM screens built before v1 still use Server
Actions; new modules expose one write path (these endpoints) that both the UI and external
clients use.

## Conventions

| Topic | Rule |
|---|---|
| Auth | Supabase session cookie (same as the app). No session → `401 UNAUTHORIZED`. No membership in the active organization → `403`. |
| Authorization | Deny by default. Every service checks a `module.action` permission (`customer.view`, `quotation.approve`, ...). Missing → `403 FORBIDDEN`. |
| Company / branch scope | Company-scoped records are only visible to members scoped to that company (or branch). Ids outside your scope return `404 NOT_FOUND`, never `403`, so they are not confirmed to exist. Owners see every company. |
| Success | `{ "ok": true, "data": ... }` |
| Errors | `{ "ok": false, "error": "message", "code": "CODE", "details"?: [...] }` with a matching status. |
| Validation | `422 VALIDATION_ERROR`, `details: [{ path, message }]`. |
| Conflicts | `409 CONFLICT` (unique value taken), `422 INVALID_REFERENCE` (id from another tenant / missing), `422 INVALID_STATE` (illegal status transition). |
| Lists | `?page=1&pageSize=25` (max 100) `&sort=<field>&dir=asc|desc&q=<search>` plus endpoint filters. Response `data: { items, total, page, pageSize }`. Unknown sort fields → 422. |
| Money & quantities | Sent and returned as decimal strings (`"1250.50"`), never floats. |
| Idempotency | `POST` endpoints marked (idem) accept an `Idempotency-Key` header. A retry with the same key and body returns the stored response with `idempotent-replayed: true`; same key + different body → `422 IDEMPOTENCY_KEY_REUSED`; retry while the first call is still running → `409 IDEMPOTENCY_IN_PROGRESS`. Failed calls release the key. Keys expire after 24h. |
| Audit | Every mutation writes `audit_logs` (actor, action, entity, company, changed fields) in the same transaction. |

## Platform (Phase 1)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/me` | any member | Permissions and company/branch scopes of the caller |
| GET | `/companies` | `company.view` | Companies in scope, with branches in scope and typed settings |
| POST | `/companies` (idem) | `company.create` | Creates the company and a `HO` branch; the creator is scoped to it |
| GET | `/companies/:id` | `company.view` | |
| PATCH | `/companies/:id` | `company.update` (+ `company.administer` for `settings`) | `settings` is deep-merged and validated |
| POST | `/companies/:id/branches` (idem) | `company.update` | Requires access to every branch of the company |
| PATCH | `/branches/:id` | `company.update` | |
| GET | `/companies/:id/number-sequences` | `company.view` | Prefix / padding / next number per document type |
| PATCH | `/companies/:id/number-sequences/:type` | `company.administer` | `nextNumber` may only move forward |
| GET / PUT | `/members/:id/scopes` | `company.administer` | Replaces scopes within companies the caller fully administers |
| GET | `/audit-logs` | `audit.view` | Filters: `entity, entityId, companyId, userId, action, from, to` |
| GET | `/tasks` | own tasks; all with `task.view_all` | Filters: `status, assignedUserId, entityType, entityId, dueBefore` |
| POST | `/tasks` (idem) | `task.create` | `entityType/entityId` must be a record the caller can access |
| PATCH | `/tasks/:id` | assignee/creator or `task.view_all` | Changing `remindAt` re-arms the reminder |
| GET | `/documents?entityType=&entityId=` | `document.view` | |
| POST | `/documents` | `document.create` | multipart: `entityType`, `entityId`, `file` (≤ 20MB, pdf/images/office/csv/txt) |
| GET | `/documents/:id` | `document.view` | Returns a 5-minute signed download URL |
| DELETE | `/documents/:id` | `document.delete` | Soft delete + storage removal |
| GET/POST | `/jobs/run?job=<name>` | `Authorization: Bearer $CRON_SECRET` | Jobs: `task-reminders`, `follow-up-reminder-emails`, `idempotency-cleanup` (all when `job` omitted) |

Example:

```bash
curl -X POST https://<host>/api/v1/tasks \
  -H 'content-type: application/json' -H 'idempotency-key: 5f0c...' \
  --cookie "<supabase session cookies>" \
  -d '{"title":"Call back about the quote","entityType":"company","entityId":"cmp_...","dueAt":"2026-10-20T10:00:00Z","remindAt":"2026-10-20T09:30:00Z"}'
```

## CRM (Phase 2)

Customers, contacts, opportunities and products are organization-level master data shared
by every company of the tenant; quotations and sales orders belong to one company + branch.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET / POST (idem) | `/customers` | `customer.view` / `customer.create` | POST returns `409 DUPLICATE` with candidate matches in `details` unless `ignoreDuplicates: true` |
| GET / PATCH | `/customers/:id` | `customer.view` / `customer.update` (`customer.delete` to archive via `status: "ARCHIVED"`) | |
| GET | `/customers/duplicates?gstin=&email=&phone=&name=` | `customer.view` | Uses the org's matching rules |
| GET | `/customers/:id/timeline` | `customer.view` | Interactions + history of leads converted into this customer |
| GET / PUT | `/customers/:id/prices` | `customer.view` / `customer.update` | `{ prices: [{ productId, unitPrice | null }] }` |
| GET / POST (idem) | `/contacts` | `contact.*` | Filter `customerId` |
| GET / PATCH | `/contacts/:id` | `contact.*` | |
| GET / POST (idem) | `/opportunities` | `opportunity.*` | Filters `stage`, `open=true|false`, `customerId`, `ownerUserId` |
| GET / PATCH | `/opportunities/:id` | `opportunity.*` | Closed (WON/LOST) deals are read-only |
| POST | `/opportunities/:id/stage` | `opportunity.update` | `{ stage, lossReason? }` — open stages move freely; LOST needs a reason; WON/LOST are terminal |
| GET | `/opportunities/:id/timeline` | `opportunity.view` | |
| POST (idem) | `/activities` | `activity.create` | `{ type: CALL|EMAIL|MEETING|NOTE, subject, customerId?|contactId?|opportunityId?, ... }` |
| POST (idem) | `/leads/:id/convert` | `lead.convert` (+ `customer.create` / `contact.create` / `opportunity.create` for what it creates) | Transactional; retrying returns the first result with `alreadyConverted: true`; `409 DUPLICATE` unless `customerId` or `ignoreDuplicates` |
| GET / PUT | `/crm/settings` | read: any member; write `crm.administer` | `{ duplicates: { customer: [gstin,email,phone,name], lead: [email,phone,whatsapp,company] } }` |
| GET | `/crm/reports/funnel?from=&to=` | `crm.report` | Lead conversion, pipeline by stage (weighted), win rate, quotations, orders |

## Catalog

| Method | Path | Permission |
|---|---|---|
| GET / POST (idem) | `/products` | `product.view` / `product.create` |
| GET / PATCH | `/products/:id` | `product.view` / `product.update` (`product.delete` to archive) |
| GET | `/catalog/lookups` | `product.view` — units, categories, tax rates |
| POST (idem) | `/uoms`, `/product-categories`, `/tax-rates` | `catalog.administer` |
| PATCH | `/tax-rates/:id` | `catalog.administer` (name / active only; lines keep a rate snapshot) |

## Sales

Lines: `{ productId?, description?, quantity, uomId?, unitPrice?, discountPercent?, taxRateId? }`.
Prices are tax-exclusive. A blank `unitPrice` uses the customer's negotiated price, then the
product price; a blank `taxRateId` uses the product's rate. GST is CGST+SGST when the branch
(or company) state equals the place of supply (default: the customer's state), else IGST.
Each line is rounded half-up to 2 dp.

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET / POST (idem) | `/quotations` | `quotation.view` / `quotation.create` | Number from the company sequence; superseded revisions hidden unless `includeSuperseded=true` |
| GET / PATCH | `/quotations/:id` | `quotation.view` / `quotation.update` | PATCH only while DRAFT |
| POST (idem) | `/quotations/:id/submit` | `quotation.update` | → PENDING_APPROVAL when a line discount exceeds `settings.quotation.approvalDiscountPercent` or the total exceeds `approvalAmount`; otherwise APPROVED |
| POST (idem) | `/quotations/:id/approve` · `/return` | `quotation.approve` | The author cannot approve their own quotation; `return` needs `{ note }` and goes back to DRAFT |
| POST (idem) | `/quotations/:id/send` · `/accept` · `/reject` | `quotation.update` | accept requires a still-valid quote and marks a linked open opportunity WON; reject needs `{ reason }` |
| POST (idem) | `/quotations/:id/cancel` | `quotation.delete` | |
| POST (idem) | `/quotations/:id/revise` | `quotation.create` | New DRAFT revision (same number, revision+1); the old one becomes SUPERSEDED |
| POST (idem) | `/quotations/:id/convert` | `sales_order.create` | ACCEPTED only; at most one sales order per quotation; repeats return `{ salesOrder, alreadyConverted: true }` |
| GET / POST (idem) | `/sales-orders` | `sales_order.view` / `sales_order.create` | |
| GET / PATCH | `/sales-orders/:id` | `sales_order.view` / `sales_order.update` | DRAFT: edit. CONFIRMED with nothing delivered: amendment (counted + audited). Otherwise 422 |
| POST (idem) | `/sales-orders/:id/confirm` | `sales_order.update` | |
| POST (idem) | `/sales-orders/:id/cancel` | `sales_order.cancel` | `{ reason }`; not after any delivery |

Jobs added: `quotation-expiry` (APPROVED/SENT past valid-until → EXPIRED).

Printable documents: `/print/quotations/:id`, `/print/orders/:id` (browser print / save as PDF).

## Inventory (Phase 3)

Stock lifecycle, valuation and sample requests: [docs/INVENTORY.md](INVENTORY.md).

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET / POST (idem) | `/warehouses` | `inventory.view` / `inventory.administer` | Each warehouse gets a default `STOCK` location; every company gets a `MAIN` warehouse |
| PATCH | `/warehouses/:id` | `inventory.administer` | Cannot deactivate while it holds stock |
| POST (idem) | `/warehouses/:id/locations` | `inventory.administer` | |
| PUT | `/products/:id/uom-conversions` | `product.update` | `{ conversions: [{ uomId, factor }] }` |
| GET | `/stock/levels` | `inventory.view` | `companyId, warehouseId, productId, lowOnly` → on hand / reserved / available |
| GET | `/stock/reorder-suggestions?companyId=` | `inventory.view` | Net of open purchase orders |
| POST | `/stock/reconcile` | `inventory.administer` | `{ companyId, fix? }` — compare/rebuild caches from the ledger |
| GET / POST (idem) | `/stock-entries` | `inventory.view` / `inventory.create` (+ `inventory.post` with `post: true`) | OPENING, RECEIPT, ISSUE, ADJUSTMENT, TRANSFER |
| GET | `/stock-entries/:id` | `inventory.view` | Lines, ledger moves, linked documents |
| POST (idem) | `/stock-entries/:id/post` | `inventory.post` | Retry-safe |
| POST (idem) | `/stock-entries/:id/cancel` | `inventory.post` | `{ reason }`; posted entries are reversed |
| POST (idem) | `/stock-entries/:id/return` | `inventory.create` (+ `inventory.post`) | Posted DELIVERY → SALES_RETURN, posted GOODS_RECEIPT → PURCHASE_RETURN |
| POST (idem) | `/sales-orders/:id/reserve` | `sales_order.update` | Top up reservations (idempotent) |
| POST (idem) | `/sales-orders/:id/deliver` | `inventory.create` + `inventory.post` | `{ lines: [{ salesOrderLineId, quantity, lotNumber? }] }` |

Sales orders now take `warehouseId` (defaults to the branch's warehouse, or the company's
only warehouse). `confirm` reserves stock and returns `reservations: [{ salesOrderLineId,
reserved, short }]`; amendments re-reserve; `cancel` releases.

## Purchasing (Phase 3)

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET / POST (idem) | `/vendors` | `vendor.view` / `vendor.create` | GSTIN unique per organization |
| GET / PATCH | `/vendors/:id` | `vendor.view` / `vendor.update` (`vendor.delete` to archive) | |
| GET / POST (idem) | `/purchase-orders` | `purchase_order.view` / `purchase_order.create` | Lines need a product; priced at purchase price; CGST+SGST vs IGST by branch vs supplier state |
| GET / PATCH | `/purchase-orders/:id` | `purchase_order.view` / `purchase_order.update` | PATCH while DRAFT |
| POST (idem) | `/purchase-orders/:id/submit` | `purchase_order.update` | → PENDING_APPROVAL above `settings.purchase.approvalAmount`, else APPROVED |
| POST (idem) | `/purchase-orders/:id/approve` · `/return` | `purchase_order.approve` | Creator cannot approve; return needs `{ note }` |
| POST (idem) | `/purchase-orders/:id/cancel` | `purchase_order.cancel` | `{ reason }`; not after goods were received (close instead) |
| POST (idem) | `/purchase-orders/:id/close` | `purchase_order.update` | Short-close a partially received order |
| POST (idem) | `/purchase-orders/:id/receive` | `inventory.create` + `inventory.post` | `{ lines: [{ purchaseOrderLineId, quantity, lotNumber?, expiryDate? }] }` — goods receipt; the only way a PO adds stock |
| GET / POST (idem) | `/vendor-bills` | `vendor_bill.view` / `vendor_bill.create` | Lines may link `purchaseOrderLineId` (defaults price/tax from the PO); vendor invoice number unique per vendor |
| GET | `/vendor-bills/:id` | `vendor_bill.view` | |
| POST (idem) | `/vendor-bills/:id/post` | `vendor_bill.post` | Three-way match: billed ≤ received − returned |
| POST (idem) | `/vendor-bills/:id/cancel` | `vendor_bill.cancel` | `{ reason }`; un-bills the PO quantities |

Jobs added: `low-stock-alerts`.

New system roles: **Inventory Manager**, **Purchase Manager** (created for existing
organizations by migration `20261016120000_inventory_and_purchasing`).

## Finance (Phase 4)

Accounting model, posting rules and GST notes: [docs/FINANCE.md](FINANCE.md).

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST (idem) | `/companies/:id/finance/setup` | `finance.administer` | `{ accountingStartDate, fiscalYearStartMonth? }` — chart, mappings, fiscal year, bank/cash, categories |
| GET / POST (idem) | `/companies/:id/fiscal-years` | `finance.view` / `finance.administer` | POST `{ containingDate }` |
| PATCH | `/accounting-periods/:id` | `finance.administer` | `{ status: OPEN|CLOSED, reason? }` (reason required to reopen) |
| GET / POST (idem) | `/companies/:id/accounts` | `finance.view` / `finance.administer` | GET includes mappings and mapping keys |
| PATCH | `/accounts/:id` | `finance.administer` | Code/type locked once used |
| PUT | `/companies/:id/account-mappings` | `finance.administer` | `{ mappings: { KEY: accountId } }`, type-checked |
| GET / POST (idem) | `/companies/:id/bank-accounts` | `finance.view` / `finance.administer` | |
| POST (idem) | `/tax-rates/:id/versions` | `catalog.administer` | `{ rate, effectiveFrom }` |
| GET / POST (idem) | `/sales-invoices` | `invoice.view` / `invoice.create` | Filters `status, customerId, outstanding=true|overdue` |
| GET / PATCH | `/sales-invoices/:id` | `invoice.view` / `invoice.create` | PATCH while DRAFT |
| POST (idem) | `/sales-invoices/:id/post` | `invoice.post` | Number + journal; retry-safe |
| POST (idem) | `/sales-invoices/:id/cancel` | `invoice.cancel` | `{ reason }`; only unsettled invoices |
| GET | `/sales-invoices/:id/einvoice-payload` | `invoice.view` | Payload + blocking errors |
| POST (idem) | `/sales-invoices/:id/einvoice` | `invoice.post` | `422 NOT_CONFIGURED` without a provider |
| POST (idem) | `/sales-orders/:id/invoice` | `invoice.create` | Draft for delivered goods / ordered services |
| GET / POST (idem) | `/credit-notes` · `/credit-notes/:id` · `/credit-notes/:id/{post|cancel}` | `invoice.*` | Lines reference invoice lines |
| GET / POST (idem) | `/receipts` | `receipt.view` / `receipt.create` | Posts immediately; `allocations: [{ invoiceId, amount }]` |
| GET · POST (idem) | `/receipts/:id` · `/receipts/:id/cancel` | `receipt.view` / `receipt.cancel` | |
| POST (idem) | `/receivable-allocations` | `receipt.create` / `invoice.post` | `{ receiptId | creditNoteId, allocations }` |
| GET / POST (idem) | `/vendor-payments` · `/vendor-payments/:id` · `/vendor-payments/:id/cancel` | `payment.*` | |
| POST (idem) | `/payable-allocations` | `payment.create` / `vendor_bill.post` | `{ paymentId | debitNoteId, allocations: [{ billId, amount }] }` |
| GET / POST (idem) | `/debit-notes` · `/debit-notes/:id` · `/debit-notes/:id/{post|cancel}` | `vendor_bill.*` | |
| POST (idem) | `/vendor-bills/:id/approve` | `vendor_bill.approve` | Required above `settings.purchase.billApprovalAmount` |
| GET / POST (idem) | `/expense-claims` · `/expense-claims/:id` (GET/PATCH) | `expense.view` / `expense.create` | Claimants see their own claims |
| POST (idem) | `/expense-claims/:id/{submit|approve|reject|cancel|pay}` | claimant / `expense.approve` / `expense.pay` | `pay { bankAccountId, paidOn?, reference? }` |
| GET / POST (idem) | `/companies/:id/expense-categories` | `expense.view` / `finance.administer` | |
| POST (idem) | `/bank-accounts/:id/imports` | `finance.post` | Manual CSV import (no bank feed) |
| GET | `/bank-accounts/:id/transactions` · `/bank-accounts/:id/cashbook` | `finance.view` | |
| GET · POST | `/bank-transactions/:id/matches` · `/bank-transactions/:id/{reconcile|unreconcile}` | `finance.view` / `finance.post` | |
| POST (idem) | `/account-transfers` | `finance.post` | |
| GET / POST (idem) | `/journals` · `/journals/:id` (GET/PATCH/DELETE drafts) · `/journals/:id/{post|reverse}` | `finance.view` / `finance.post` | Reverse only manual journals |
| GET | `/companies/:id/reports/{trial-balance|general-ledger|profit-and-loss|balance-sheet|receivables-aging|payables-aging|reconciliation|gstr1|gstr3b}` | `finance.report` | GST reports take `gstin, from, to` |
| GET | `/companies/:id/statements/{customers|vendors}/:partyId` | `finance.report` | |

Jobs added: `overdue-invoice-reminders`. New system role: **Accountant**.
