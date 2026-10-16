## Administration (Phase 7)

All endpoints are under `/api/v1/admin` with the shared `{ ok, data }` / `{ ok: false, error, code, details? }`
shape. "(idem)" endpoints honour `Idempotency-Key`. Lists take `page, pageSize, sort, dir, q`.
Services: `src/features/admin/{users,roles,settings,audit,imports,retention,backups}.ts`. Guide: [docs/ADMIN.md](../ADMIN.md).

### Users and roles

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/admin/members` | `member.view` | Filters `status (ACTIVE\|DISABLED), roleId`, `q` = name/email; sort `joinedAt`. Items carry `user`, `role`, `isOwner`, `scopes[{company, branch}]` |
| POST (idem) | `/admin/members/:id/role` | `member.change_role` | `{ roleId }`. Ownership follows the `owner` role. 422 `SELF_CHANGE`, 422 `LAST_OWNER`, 403 `ROLE_ESCALATION` (role or target's current role exceeds the actor's permissions; owners exempt), 403 non-owner touching an owner, 422 `INVALID_REFERENCE` for another org's role |
| POST (idem) | `/admin/members/:id/suspend` · `/reactivate` | `member.remove` | Status DISABLED/ACTIVE (suspended members fail auth immediately). Same guards. Other actions → 404 |
| GET / POST (idem) | `/admin/roles` | `role.view` / `role.manage` | Items: role + `permissions` (effective codes, as auth resolves them), `memberCount`, `invitationCount`. POST `{ code, name, description?, permissions: [codes] }`; unknown code or a system-role code → 422; escalation → 403; 201 |
| GET / PATCH / DELETE | `/admin/roles/:id` | `role.view` / `role.manage` | PATCH `{ name?, description?, permissions? }` (replaces the set). System roles → 422 `SYSTEM_ROLE`. DELETE with members/invitations → 422 `ROLE_IN_USE` |
| GET | `/admin/permissions` | `role.view` | `{ modules: [{ module, permissions }], roles: [{ id, code, name, isSystem, memberCount, modules: { module: grantedCount } }] }` |
| GET / PUT | `/members/:id/scopes` | `company.administer` | Existing endpoint for company/branch scopes |

### Settings and environment

| Method | Path | Access | Notes |
|---|---|---|---|
| GET / PATCH | `/admin/settings/org` | `system.configure` | Partial `orgSettingsSchema` (`duplicates`, `loyalty`); merged then validated; unknown keys 422; arrays replace. Audit `org.settings_updated` with dotted changed keys only |
| GET / PATCH | `/admin/companies/:id/settings` | `company.administer` + full company scope (404 otherwise) | Partial `companySettingsSchema`; any `finance` key → 422 `FINANCE_MANAGED` (use finance setup). Audit `company.settings_updated` |
| GET | `/admin/environment` | `system.configure` | Booleans only: `requiredEnvComplete, database, supabaseAuth, supabaseServiceRole, encryptionKey, cronSecret, email, siteUrl, integrations: { provider: connected }` |

### Audit

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/admin/audit` | `audit.view` | Filters `userId, entity, entityId, action` (prefix), `companyId, from, to`, `q` (text in action). Org-level entries + entries of companies in the caller's scope. Items carry `previous`, `next`, `user` |

### Imports

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/admin/imports/template?entity=` | `data.import` + entity create | CSV download (header + example row) |
| POST | `/admin/imports` | `data.import` + `customer.create` / `contact.create` / `vendor.create` / `product.create` | `{ entity, csv, filename?, dryRun = true }`. ≤ 5 MB, ≤ 5 000 rows; header must match the template (422 `INVALID_COLUMNS`). → `{ jobId, dryRun, totalRows, imported, duplicates, errors, failedRows: [{ row, kind: error\|duplicate, reason, data }] }`. Dry run writes nothing; commit creates via the module services (one transaction per row) and records an `ImportJob` |
| GET | `/admin/imports` · `/admin/imports/:id` | `data.import` | Admin import jobs (filter `entity`) |

### Retention

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/admin/retention` | `retention.manage` | Allowlisted targets with rule, `minKeepDays`, `ownerOnly`, `policy` |
| PUT (idem) / DELETE | `/admin/retention/:target` | `retention.manage` (+ owner for `audit_logs`) | `{ keepDays, isEnabled }`; keepDays ≥ target minimum (audit_logs 365) else 422; unknown target 404 |
| GET | `/admin/retention/:target/preview?keepDays=` | `retention.manage` | Dry run → `{ count, thisRun, cutoff, batchLimit }` |
| POST | `/admin/retention/run` | `retention.manage` | Applies this org's enabled policies now |

### Backups

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/admin/backups` | `backup.view` | `{ status: { lastSucceeded, lastVerified, lastFailed }, runs }` (platform-level; `sizeBytes` as string). Filter `status` |
