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
