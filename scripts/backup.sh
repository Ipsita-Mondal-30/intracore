#!/usr/bin/env bash
# Logical backup of the whole database (all tenants) with pg_dump custom format.
#
#   scripts/backup.sh [SOURCE_URL]
#
#   SOURCE_URL         defaults to $DATABASE_URL from the environment (this script never reads .env).
#                      On Supabase use the direct/session connection (DIRECT_URL, port 5432), not the
#                      transaction pooler.
#   BACKUP_DIR         where dumps go (default ./backups, gitignored; never inside src/)
#   BACKUP_RECORD_URL  database that gets the BackupRun row (default: SOURCE_URL)
#   ALLOW_REMOTE=1     required for a non-localhost source (production runs set it explicitly)
#
# Writes <dir>/intracore-<UTC timestamp>.dump plus sidecars:
#   .sha256   checksum (shasum -a 256 -c compatible)
#   .counts   "table rowcount" for every public table, taken in the SAME snapshot as the dump
#   .run      the BackupRun id
# Records BackupRun RUNNING -> SUCCEEDED | FAILED. Prints BACKUP_FILE=… and BACKUP_RUN_ID=… last.
set -euo pipefail
export PGOPTIONS="${PGOPTIONS:--c client_min_messages=warning}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_DUMP="${PG_DUMP:-$(command -v pg_dump || echo /opt/homebrew/bin/pg_dump)}"
PSQL="${PSQL:-$(command -v psql || echo /opt/homebrew/opt/postgresql@17/bin/psql)}"

die() { echo "backup: $*" >&2; exit 1; }
# Prisma URLs carry options libpq rejects (pgbouncer, schema, connection_limit): keep only sslmode.
libpq_url() {
  local base="${1%%\?*}" query="" ssl
  [[ "$1" == *\?* ]] && query="${1#*\?}"
  ssl="$(printf '%s' "$query" | tr '&' '\n' | grep '^sslmode=' || true)"
  if [ -n "$ssl" ]; then printf '%s?%s' "$base" "$ssl"; else printf '%s' "$base"; fi
}
is_local() { [[ "$1" =~ (@|//)(localhost|127\.0\.0\.1)(:|/) ]]; }
sql_quote() { printf "%s" "$1" | sed "s/'/''/g"; }

SOURCE="${1:-${DATABASE_URL:-}}"
[ -n "$SOURCE" ] || die "no source: pass a URL or set DATABASE_URL"
is_local "$SOURCE" || [ "${ALLOW_REMOTE:-}" = "1" ] || die "refusing non-local source without ALLOW_REMOTE=1"
SOURCE="$(libpq_url "$SOURCE")"
RECORD="$(libpq_url "${BACKUP_RECORD_URL:-$SOURCE}")"
[ -x "$PG_DUMP" ] || die "pg_dump not found (set PG_DUMP)"

BACKUP_DIR="${BACKUP_DIR:-$ROOT/backups}"
case "$BACKUP_DIR" in /*) ;; *) BACKUP_DIR="$PWD/$BACKUP_DIR";; esac
inside_src() { case "$1/" in "$ROOT/src/"*|"$(cd "$ROOT" && pwd -P)/src/"*) return 0;; esac; return 1; }
inside_src "$BACKUP_DIR" && die "refusing to write a dump inside src/"
mkdir -p "$BACKUP_DIR"
BACKUP_DIR="$(cd "$BACKUP_DIR" && pwd -P)"
inside_src "$BACKUP_DIR" && die "refusing to write a dump inside src/"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="$BACKUP_DIR/intracore-$STAMP.dump"
WORK="$(mktemp -d)"
RUN_ID=""

record() { "$PSQL" "$RECORD" -qtAX -v ON_ERROR_STOP=1 -c "$1"; }
on_error() {
  local msg; msg="$(tail -c 400 "$WORK/err" 2>/dev/null | tr '\n' ' ')"
  [ -n "$RUN_ID" ] && record "UPDATE backup_runs SET status = 'FAILED', error = '$(sql_quote "${msg:-backup failed}")', \"finishedAt\" = now() AT TIME ZONE 'UTC' WHERE id = '$RUN_ID'" >/dev/null 2>&1 || true
  rm -f "$FILE" "$FILE.counts"
  echo "backup: FAILED ${msg}" >&2
}
trap 'on_error' ERR
trap 'exec 3>&- 2>/dev/null || true; rm -rf "$WORK"' EXIT

RUN_ID="$(record "INSERT INTO backup_runs (id, kind, status, \"startedAt\") VALUES ('bk' || substr(md5(random()::text || clock_timestamp()::text), 1, 23), 'PG_DUMP', 'RUNNING', now() AT TIME ZONE 'UTC') RETURNING id")"
echo "backup: run $RUN_ID -> $FILE"

# Hold one REPEATABLE READ transaction open, export its snapshot, and dump + count inside it,
# so the row counts describe exactly what the dump contains even while the app keeps writing.
mkfifo "$WORK/in"
"$PSQL" "$SOURCE" -qtAX -v ON_ERROR_STOP=1 <"$WORK/in" >"$WORK/out" 2>"$WORK/err" &
SNAP_PID=$!
exec 3>"$WORK/in"
echo "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();" >&3
for _ in $(seq 1 100); do [ -s "$WORK/out" ] && break; sleep 0.1; done
SNAPSHOT="$(head -n 1 "$WORK/out")"
[ -n "$SNAPSHOT" ] || { echo "could not export a snapshot" >>"$WORK/err"; false; }

"$PG_DUMP" -Fc --snapshot="$SNAPSHOT" -f "$FILE" "$SOURCE" 2>>"$WORK/err"

cat >&3 <<'SQL'
SELECT table_name || ' ' || (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I', table_name), false, true, '')))[1]::text
FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;
COMMIT;
SQL
exec 3>&-
wait "$SNAP_PID"
tail -n +2 "$WORK/out" >"$FILE.counts"
[ -s "$FILE.counts" ] || { echo "row counts missing" >>"$WORK/err"; false; }

CHECKSUM="$(shasum -a 256 "$FILE" | awk '{print $1}')"
echo "$CHECKSUM  $(basename "$FILE")" >"$FILE.sha256"
echo "$RUN_ID" >"$FILE.run"
SIZE="$(wc -c <"$FILE" | tr -d ' ')"

record "UPDATE backup_runs SET status = 'SUCCEEDED', location = '$(sql_quote "$FILE")', \"sizeBytes\" = $SIZE, checksum = '$CHECKSUM', \"finishedAt\" = now() AT TIME ZONE 'UTC' WHERE id = '$RUN_ID'" >/dev/null
echo "backup: OK $(wc -l <"$FILE.counts" | tr -d ' ') tables, $SIZE bytes, sha256 $CHECKSUM"
echo "BACKUP_FILE=$FILE"
echo "BACKUP_RUN_ID=$RUN_ID"
