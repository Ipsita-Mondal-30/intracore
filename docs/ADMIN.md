# Administration

Hub: `/settings/system`. API: [docs/api/admin.md](api/admin.md). Services: `src/features/admin/*`.

## Users, roles and permissions
- **System roles** get their permissions from `src/lib/permissions/catalog.ts` (code), so they are
  read-only here. **Custom roles** store `RolePermission` rows; `buildTenantContext` reads exactly
  those rows (plus the catalog for system roles), and `roleCodes()` in `roles.ts` resolves the same way.
- **Escalation guard:** a non-owner cannot create/edit a role, assign a role, or change/suspend a member
  whose role includes any permission the actor lacks (the `owner` role is owner-only). Owners are exempt.
- **Ownership** follows the `owner` role: assigning it sets `isOwner`, assigning anything else clears it.
  Nobody changes their own role/status (422 `SELF_CHANGE`); the org always keeps one active owner
  (422 `LAST_OWNER`, owner rows locked `FOR UPDATE` so two owners cannot demote each other concurrently).
- **Suspend** sets the member DISABLED (needs `member.remove`); auth rejects disabled members at once.
- Company/branch scopes stay on the existing `/members/:id/scopes` endpoint and the Companies page.

## Settings
- Org settings (`system.configure`) and company settings (`company.administer`) are partial patches
  merged into the stored JSON and validated with the full schema; unknown keys are 422 and the audit row
  records only the changed dotted keys.
- The `finance` section of company settings belongs to finance setup (it creates fiscal years and
  accounts) and is refused with 422 `FINANCE_MANAGED`.
- The environment panel shows booleans only, never values.

## Imports
- Entities: customer, contact, vendor, product; fixed column names (template download per entity).
- Needs `data.import` **and** the entity's create permission. Dry run (default) validates formats,
  references and duplicates and writes nothing; commit calls `createCustomer` / `createContact` /
  `createVendor` / `createProduct`, so validation, permission checks and audit rows are the same as the UI.
- One transaction per row (each service call is its own transaction): a bad row is reported with its
  spreadsheet row number and the other rows still import. A re-run reports already-imported rows as duplicates.
- Duplicates: customers use the org duplicate rules (`findDuplicateCustomers`) plus code; vendors code/GSTIN;
  products SKU/barcode; contacts email. Earlier rows of the same file count too.
- The dry run checks the template's own column rules, which mirror the services' schemas; at commit the
  service validation is authoritative (a row that passes the dry run can still fail, and is reported).
- Imports run synchronously in the request (5 000 rows ≈ tens of seconds). Move to the background queue if
  hosting timeouts bite.

## Exports
Owned by the reports/exports module at `/settings/exports` (exports run through the same services and
permission checks as the UI).

## Retention and archival
| Target | Purged | Kept | Min days |
|---|---|---|---|
| notifications | read, older than N | unread | 7 |
| communication_logs | SENT, DELIVERED, READ, FAILED, RECEIVED | QUEUED (in flight), BLOCKED (consent evidence) | 30 |
| webhook_events | PROCESSED, IGNORED | RECEIVED, FAILED (replayable) | 7 |
| background_jobs | SUCCEEDED | PENDING, RUNNING, DEAD, CANCELLED | 7 |
| audit_logs | older than N, **archived first** | — | 365 (owners only) |

- Nothing else can be purged: financial documents, journals, stock moves and master data are not in the allowlist.
- Job `retention` → `applyRetentionPolicies(now)`: per enabled policy, claims it with a conditional
  update on `lastRunAt`, deletes at most 5 000 oldest matching rows, records `lastRunAt`/`lastPurged` and an
  audit row (`retention.purged` / `retention.failed`). Re-running is harmless (purged rows no longer match).
- Audit-log archive: CSV of the batch written to the private `documents` bucket at
  `archives/<orgId>/audit-<ISO timestamp>.csv` **before** deleting; if the upload fails nothing is deleted.
- Dry run: `/settings/retention` → "Dry run" (count and cutoff).

## Backups
See [BACKUP_RESTORE.md](BACKUP_RESTORE.md). The status page `/settings/backups` lists `BackupRun`s
(size, checksum, verification).
