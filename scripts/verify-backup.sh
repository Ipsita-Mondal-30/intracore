#!/usr/bin/env bash
# Restore drill: prove a dump made by scripts/backup.sh can be restored.
#
#   scripts/verify-backup.sh <dump file> [BACKUP_RUN_ID]
#
#   VERIFY_ADMIN_URL  LOCAL maintenance connection (default postgresql://postgres@localhost:54329/postgres)
#   VERIFY_DB         scratch database, dropped and recreated (default intracore_restore_check)
#   BACKUP_RECORD_URL where the BackupRun row lives (default: $DATABASE_URL); verifiedAt/verifyNotes are set there
#   KEEP_RESTORE_DB=1 leave the scratch database for inspection (it is dropped otherwise)
#
# Steps: checksum → create scratch DB → pg_restore (strict: stops at the first error) → count rows in
# every public table → compare with the .counts taken in the dump's own snapshot → record the result.
# Exit 0 only when the checksum and every table count match.
set -euo pipefail
export PGOPTIONS="${PGOPTIONS:--c client_min_messages=warning}"

PG_RESTORE="${PG_RESTORE:-$(command -v pg_restore || echo /opt/homebrew/bin/pg_restore)}"
PSQL="${PSQL:-$(command -v psql || echo /opt/homebrew/opt/postgresql@17/bin/psql)}"

die() { echo "verify: $*" >&2; exit 1; }
libpq_url() {
  local base="${1%%\?*}" query="" ssl
  [[ "$1" == *\?* ]] && query="${1#*\?}"
  ssl="$(printf '%s' "$query" | tr '&' '\n' | grep '^sslmode=' || true)"
  if [ -n "$ssl" ]; then printf '%s?%s' "$base" "$ssl"; else printf '%s' "$base"; fi
}
is_local() { [[ "$1" =~ (@|//)(localhost|127\.0\.0\.1)(:|/) ]]; }
sql_quote() { printf "%s" "$1" | sed "s/'/''/g"; }

DUMP="${1:-}"
[ -f "$DUMP" ] || die "usage: verify-backup.sh <dump file> [BACKUP_RUN_ID]"
RUN_ID="${2:-$(cat "$DUMP.run" 2>/dev/null || true)}"
ADMIN="$(libpq_url "${VERIFY_ADMIN_URL:-postgresql://postgres@localhost:54329/postgres}")"
is_local "$ADMIN" || die "the scratch server must be local (VERIFY_ADMIN_URL)"
DB="${VERIFY_DB:-intracore_restore_check}"
[[ "$DB" =~ ^[a-z_][a-z0-9_]*$ ]] || die "invalid VERIFY_DB"
TARGET="${ADMIN%/*}/$DB"
RECORD="${BACKUP_RECORD_URL:-${DATABASE_URL:-}}"

record() {
  [ -n "$RUN_ID" ] && [ -n "$RECORD" ] || return 0
  "$PSQL" "$(libpq_url "$RECORD")" -qtAX -v ON_ERROR_STOP=1 -c "$1" >/dev/null
}
fail() {
  record "UPDATE backup_runs SET \"verifyNotes\" = '$(sql_quote "FAILED $(date -u +%FT%TZ): $1")' WHERE id = '$(sql_quote "$RUN_ID")'" || true
  die "$1"
}

echo "verify: 1/5 checksum"
if [ -f "$DUMP.sha256" ]; then
  (cd "$(dirname "$DUMP")" && shasum -a 256 -c "$(basename "$DUMP").sha256" >/dev/null) || fail "checksum mismatch"
else
  echo "verify:     no .sha256 sidecar, skipping"
fi
[ -s "$DUMP.counts" ] || fail "missing $DUMP.counts (made by backup.sh)"

echo "verify: 2/5 create scratch database $DB"
"$PSQL" "$ADMIN" -qtAX -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" -c "CREATE DATABASE $DB"
cleanup() { [ "${KEEP_RESTORE_DB:-}" = "1" ] || "$PSQL" "$ADMIN" -qtAX -c "DROP DATABASE IF EXISTS $DB WITH (FORCE)" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "verify: 3/5 pg_restore"
START=$(date +%s)
"$PG_RESTORE" --exit-on-error --no-owner --no-acl -d "$TARGET" "$DUMP" || fail "pg_restore failed"
SECONDS_TAKEN=$(( $(date +%s) - START ))

echo "verify: 4/5 compare row counts"
"$PSQL" "$TARGET" -qtAX -v ON_ERROR_STOP=1 >"$DUMP.restored-counts" <<'SQL'
SELECT table_name || ' ' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text
FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;
SQL
if ! DIFF="$(diff "$DUMP.counts" "$DUMP.restored-counts")"; then
  fail "row counts differ: $(echo "$DIFF" | head -n 10 | tr '\n' ' ')"
fi
TABLES=$(wc -l <"$DUMP.counts" | tr -d ' ')
ROWS=$(awk '{s += $2} END {print s}' "$DUMP.counts")

NOTES="restored $(basename "$DUMP") into $DB in ${SECONDS_TAKEN}s; $TABLES tables / $ROWS rows; row counts match"
echo "verify: 5/5 record result"
record "UPDATE backup_runs SET \"verifiedAt\" = now() AT TIME ZONE 'UTC', \"verifyNotes\" = '$(sql_quote "$NOTES")' WHERE id = '$(sql_quote "$RUN_ID")'"
echo "verify: OK $NOTES"
