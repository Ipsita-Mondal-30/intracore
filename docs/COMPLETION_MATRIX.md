# ERP completion matrix

State of the `erp/foundation` branch at the end of Phase 7. Status meanings:

- **Implemented and tested:** service, REST API and UI exist, and automated database tests cover the rules.
- **Partial:** works, but has a documented gap.
- **Scaffolded:** an interface or mock exists, with no real implementation.
- **Blocked by external setup:** the code is ready, but it needs accounts, credentials or a reviewer outside this repo.

**How it was verified:**
- 359 automated tests in 30 files (`npx vitest run`), against a local Postgres 17 database only. The suite was run twice in a row; both runs passed.
- `tsc --noEmit`, ESLint and `next build` are clean.
- The built app was smoke-tested over HTTP:
  - signed-out API calls get 401;
  - unsigned webhooks are rejected;
  - the job runner requires `CRON_SECRET`;
  - a portal invite link keeps its token through the login redirect.

**Not verified:**
- None of the UI pages have been clicked through in a browser with a real Supabase login.
- Nothing has been run against production or against any live third-party API.

## Platform and security

| Capability | Status | Tests | Notes |
|---|---|---|---|
| Tenancy, companies, branches (multi-GSTIN), member scopes, deny-by-default permissions | Implemented and tested | erp-foundation, permissions-tenant, rbac-maps | Composite foreign keys enforce tenant ownership. Records outside a user's scope return 404. |
| REST envelope, validation, idempotency keys, audit log with field diffs, gapless numbering | Implemented and tested | erp-foundation, every module | |
| Row-level security on every table | Implemented | migrations | RLS is enabled on all tables. The app uses the service role, so authorization is enforced in the services. |
| Background queue (retries, backoff, DEAD state, replay), job-run history, webhook dedupe | Implemented and tested | queue, communication | `background-queue` must be scheduled every minute. |

## Phases 1–4: CRM, sales, inventory, purchasing, finance

| Capability | Status | Tests | Notes |
|---|---|---|---|
| Leads → customers, contacts, opportunities | Implemented and tested | crm-sales, leads-security, e2e-acceptance | |
| Quotations (approval, revisions, expiry) → sales orders | Implemented and tested | crm-sales, e2e-acceptance | |
| Warehouses, stock ledger, moving-average valuation, reservations, transfers, returns, lots | Implemented and tested | inventory-purchasing, e2e-acceptance | |
| Vendors, purchase orders, goods receipts, three-way-matched bills | Implemented and tested | inventory-purchasing, finance, e2e-acceptance | |
| Double-entry ledger, periods, receivables, payables, expenses, bank and cash, reports | Implemented and tested | finance, e2e-acceptance | An accountant must review the chart of accounts and the posting rules (see [FINANCE.md](FINANCE.md)). |
| GST calculation and GSTR-1 / GSTR-3B preparation | Implemented and tested (preparation only) | finance | Nothing is filed. The B2CL threshold and ITC rules need review by a tax professional. |
| E-invoice and e-way bill | Scaffolded and blocked by external setup | finance | Payloads are built, but no IRP/GSP adapter is configured, so the API returns `NOT_CONFIGURED`. E-way bills are not implemented. |
| Bank feeds | Not implemented | — | CSV import only. The app never claims a live bank connection. |

## Phase 5: HR, projects, service, manufacturing, quality

| Capability | Status | Tests | Notes |
|---|---|---|---|
| Employees, lifecycle, departments, designations, shifts, holidays | Implemented and tested | hr | |
| Attendance and audited corrections | Implemented and tested | hr | There is no bulk-entry grid in the UI; the API accepts up to 500 records at once. |
| Leave types, balances, requests and approvals, calendar | Implemented and tested | hr | Leave spanning a year end must be split. Joiners' leave is not pro-rated. |
| Recruitment, interviews, feedback; performance cycles, goals, reviews | Implemented and tested | hr-payroll | |
| Payroll engine | Partial | hr-payroll | Components, proration, segregation of duties and the salary journal all work. **Not statutory**: there are no PF/ESI/PT/TDS rules (see [PAYROLL.md](PAYROLL.md)). There is no model for payroll inputs such as overtime or bonus. All deductions post to Salaries Payable. |
| Projects, tasks and subtasks, comments, time entries, progress and budget | Implemented and tested | projects | The UI is list-based, with no kanban board. |
| Tickets, SLA due dates, escalation job, internal vs public messages, feedback, reports | Implemented and tested | tickets | The SLA clock runs 24×7; there are no business hours. |
| Assets, warranties, AMC contracts, entitlements, coverage-validated claims, renewal quotations, reminders | Implemented and tested | service-field | |
| Visits, installations with checklists, dispatch and proof of delivery | Implemented and tested | service-field | |
| Route and location providers | Scaffolded | service-field | Interfaces only; they return `NOT_CONFIGURED`. |
| BOM versions, work orders, reservations, production issue and receipt, WIP costing, multi-level MRP | Implemented and tested | manufacturing-quality, e2e (ledger) | Not built: routings, scheduling, backflush, by-products. |
| Inspections, NCRs with corrective tasks, supplier evaluation, blocked-vendor PO guard, procurement report | Implemented and tested | manufacturing-quality | |

## Phase 6: automation, communication, marketing, documents, integrations

| Capability | Status | Tests | Notes |
|---|---|---|---|
| Workflow engine: allowlisted triggers, conditions and actions, dry run, run history, approvals with escalation | Implemented and tested | workflows | Workflows never execute code or SQL. Approvals do not change business records. |
| Reminders, notification history and preferences, dedupe-safe reminder jobs | Implemented and tested | notifications-documents, queue | |
| Templates, consent and opt-outs, communication log, delivery through the queue | Implemented and tested | communication, queue | |
| Mock providers (email, SMS, WhatsApp) | Implemented and tested | communication | Always labelled "simulated", and never counted as delivered. |
| WhatsApp Cloud API: sending, webhook verification, signature check, status updates, STOP | Implemented, tested with mocked HTTP; blocked by external setup | communication | Needs a Meta app, phone number ID, access token, app secret and verify token. Never run against the live API. |
| Resend email adapter | Implemented, tested with mocked HTTP; blocked by external setup | communication | Needs a Resend API key and a verified sender. |
| Real SMS provider | Scaffolded | — | Interface and mock only. |
| Segments, campaigns (approval, scheduling, resumable dispatch), metrics, feedback, loyalty ledger | Implemented and tested | marketing | Loyalty points are not awarded automatically when an invoice is posted; staff award them from the loyalty page. |
| Document versions, content sniffing, checksums | Implemented and tested | notifications-documents | |
| E-signature adapter | Scaffolded and blocked by external setup | notifications-documents | Only the mock provider exists, and it is marked "not a legal signature". A real provider (DocuSign, Leegality, etc.) needs an adapter and an account. |
| Integration framework: encrypted write-only credentials, health checks, sanitized errors, replay | Implemented and tested | communication | |

## Phase 7: portals, analytics, administration

| Capability | Status | Tests | Notes |
|---|---|---|---|
| Customer, dealer, vendor, employee and technician portals with explicit portal identities | Implemented and tested | portals | Each portal returns only whitelisted fields, and internal permissions are never inherited. Not built: vendor invoice attachments, and editing tasks in the employee portal. |
| Portal invitations (hashed single-use tokens, email match) | Implemented and tested | portals | Emails are sent only if Resend is configured. The accept link is always shown to the admin. |
| Dashboards: 40 defined metrics across 10 sections, tenant- and scope-aware | Implemented and tested | analytics-reports, e2e-acceptance | Definitions are in [METRICS.md](METRICS.md). Date ranges are UTC days. |
| Management MIS | Implemented and tested | analytics-reports | Lines that come from the ledger are left out, with a reason, when finance is off. |
| Report builder: allowlisted entities, bound parameters, row limits, 5-second timeout; saved reports | Implemented and tested | analytics-reports | |
| CSV exports through the queue: permissions re-checked at generation, formula neutralization, expiry cleanup | Implemented and tested | analytics-reports | |
| Members, custom roles, permission matrix, escalation and last-owner guards | Implemented and tested | admin | |
| Company and org settings editors, environment status (booleans only) | Implemented and tested | admin, erp-foundation | |
| Audit trail search | Implemented and tested | admin | |
| CSV imports (customers, contacts, vendors, products) with dry run | Implemented and tested | admin | Imports run inside the request; large files may need the queue. |
| Retention and archival (audit logs archived to storage before deletion, 365-day minimum) | Implemented and tested | admin | |
| Backups and restore | Implemented and drill tested locally; blocked by external setup for production | backup-restore | `backup.sh` → `verify-backup.sh` → `restore.sh` were exercised against the local database. Production relies on Supabase backups/PITR plus these scripts with `ALLOW_REMOTE=1` (see [BACKUP_RESTORE.md](BACKUP_RESTORE.md)). |
| End-to-end acceptance journeys | Implemented and tested | e2e-acceptance | Lead → Opportunity → Quotation → Order → Reservation → Delivery → Invoice → Payment → Ledger → Reports → Dashboard, and PO → GRN → Bill → Payment → Ledger. Both run through the HTTP routes as different roles. |

## Before going live

1. **Database migrations:** run `prisma migrate deploy` against production as a release step, after taking a backup. The build does not migrate.
2. **Storage buckets:** apply `supabase/migrations/20261016100000_private_buckets.sql`.
3. **Scheduled jobs:** set `CRON_SECRET` and schedule `/api/v1/jobs/run`:
   - every minute: `background-queue`, `workflow-dispatch`, `reminders`, `campaign-scheduler`;
   - every 15 minutes: `ticket-escalation`, `approval-escalation`;
   - daily: the remaining jobs (see [API.md](API.md)).
4. **Professional review:** have an accountant review the finance posting rules and GST. Payroll must not be used for statutory compliance.
5. **Providers:** configure WhatsApp, email and e-signature providers in Settings → Integrations, then test each against a sandbox account.
6. **Browser check:** with a real Supabase login, click through every module and each portal.
