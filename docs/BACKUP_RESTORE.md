# Backup and restore

One Postgres database holds every organization, so backups are platform-level (`BackupRun` has no
organization). There are two independent layers.

## 1. Provider backups (primary)

Supabase takes automatic daily backups of the project database (retention depends on the plan:
7 days on Pro, longer on Team/Enterprise). With the **PITR add-on** it keeps WAL and can restore to
any second inside the retention window.

Restore (provider):
1. Supabase dashboard → Project → Database → Backups.
2. Pick a daily backup, or "Point in time" and a timestamp just before the incident.
3. Supabase restores **in place** (the project is unavailable during the restore). If you need to
   inspect first, restore into a new project ("Restore to a new project" / branching) and copy data back.
4. After the restore: `npx prisma migrate status` against `DIRECT_URL`, `GET /api/health?db=1`,
   run `POST /api/v1/jobs/run` once, spot-check recent records, and record a `PROVIDER` row in
   `backup_runs` (kind `PROVIDER`) with a note of what was restored.

Storage objects (documents, call recordings, audit archives) live in Supabase Storage and are **not**
part of the database backup. Keep bucket versioning/replication per Supabase guidance.

## 2. Logical dumps (`scripts/backup.sh`)

A portable `pg_dump -Fc` you control: survives losing the Supabase project, can be restored anywhere.

```bash
# production (explicit opt-in for a non-local URL; use the direct connection, not the pooler)
ALLOW_REMOTE=1 BACKUP_DIR=/secure/backups scripts/backup.sh "$DIRECT_URL"
```

- Output: `intracore-<UTC>.dump` plus `.sha256`, `.counts` (row count of every public table taken
  **inside the same REPEATABLE READ snapshot** as the dump, so it is exact even while the app writes)
  and `.run` (the `BackupRun` id). Default directory `./backups` (gitignored); refuses `src/`.
- Records `BackupRun` RUNNING → SUCCEEDED (location, size, checksum) or FAILED (sanitised tail of stderr).
- `pg_dump` must be the same major version as the server or newer. Prisma URL options
  (`pgbouncer`, `schema`, …) are stripped; `sslmode` is kept.
- Copy the dump and sidecars off the machine (encrypted object storage). Dumps contain every
  tenant's data and encrypted integration secrets: treat them as production data.

## Restore drill (`scripts/verify-backup.sh`)

```bash
DATABASE_URL=<db holding backup_runs> scripts/verify-backup.sh backups/intracore-<UTC>.dump
```

1. Checks the SHA-256.
2. Drops and creates the scratch database `intracore_restore_check` on a **local** server
   (`VERIFY_ADMIN_URL`, default `postgresql://postgres@localhost:54329/postgres`; non-local is refused).
3. `pg_restore --exit-on-error --no-owner --no-acl` (strict: any error fails the drill).
4. Counts rows in every public table and diffs against `.counts`.
5. Sets `BackupRun.verifiedAt` and `verifyNotes` (duration, tables, rows) — or writes a FAILED note.
   The scratch DB is dropped unless `KEEP_RESTORE_DB=1`.

A full Supabase dump references Supabase schemas, roles and extensions that plain local Postgres
lacks, so the strict local drill may stop on them. Drill production dumps against a scratch
Supabase project instead: `ALLOW_REMOTE=1 scripts/restore.sh <dump> <scratch project URL>`, then
diff that database's row counts against the `.counts` file (the counting query is in `verify-backup.sh`).

## Restore (`scripts/restore.sh`)

```bash
scripts/restore.sh backups/intracore-<UTC>.dump postgresql://…/target_db
```

- The target is always explicit. `pg_restore --clean --if-exists --no-owner --exit-on-error`
  drops and recreates every object in the dump.
- Refuses when the target is `DATABASE_URL`/`DIRECT_URL` from `.env` (compared by host:port/db)
  unless `--i-understand-this-overwrites-production` is passed; refuses non-local targets unless
  `ALLOW_REMOTE=1`; verifies the checksum first; prints the post-restore steps.
- Production procedure: put the app in maintenance (pause cron, scale down), take a fresh
  `backup.sh` of the current state, restore, run `npx prisma migrate status`, `GET /api/health?db=1`,
  compare row counts with the `.counts` file, resume cron.

## RPO / RTO

| Path | RPO (data loss) | RTO (time to recover) |
|---|---|---|
| Supabase PITR | seconds | minutes to ~1 h, grows with DB size |
| Supabase daily backup | up to 24 h | minutes to ~1 h |
| `backup.sh` dump | time since the last dump (schedule it, e.g. nightly + before migrations) | restore time measured by `verify-backup.sh` (recorded in `verifyNotes`) + DNS/app config |

## What is tested

`tests/backup-restore.db.test.ts` (local test DB only; skipped with a message if `pg_dump`/`psql`/
`pg_restore` are missing):

1. `backup.sh` against the local test database → `BackupRun` SUCCEEDED, checksum equals the file's
   SHA-256, `sizeBytes` equals the file size, `.counts` present.
2. Guards: non-local source refused, dump directory inside `src/` refused, non-local scratch server refused.
3. `verify-backup.sh` restores into `intracore_restore_check`; every table's row count equals the
   snapshot counts; a fixture organization created before the backup exists in the restore;
   `verifiedAt`/`verifyNotes` are set.
4. `restore.sh` refuses a target equal to the (stand-in) production URL without the flag and a
   non-local target; after deleting the fixture row from the restored copy, `restore.sh … --i-understand…`
   brings it back.

Last local run: 176 tables / 1 321 rows restored in ~1 s, counts identical.
