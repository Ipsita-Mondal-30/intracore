#!/usr/bin/env bash
# Restore a pg_dump made by scripts/backup.sh into an explicitly named TARGET database.
#
#   scripts/restore.sh <dump file> <TARGET_URL> [--i-understand-this-overwrites-production]
#
# - TARGET is never defaulted. Existing objects in TARGET are dropped and recreated
#   (pg_restore --clean --if-exists --no-owner).
# - Refuses when TARGET is the DATABASE_URL/DIRECT_URL in .env (PROD_ENV_FILE) unless the flag is given.
# - Refuses a non-localhost TARGET unless ALLOW_REMOTE=1.
# - Verifies the .sha256 sidecar when present.
set -euo pipefail
export PGOPTIONS="${PGOPTIONS:--c client_min_messages=warning}"

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PG_RESTORE="${PG_RESTORE:-$(command -v pg_restore || echo /opt/homebrew/bin/pg_restore)}"
PROD_ENV_FILE="${PROD_ENV_FILE:-$ROOT/.env}"

die() { echo "restore: $*" >&2; exit 1; }
libpq_url() {
  local base="${1%%\?*}" query="" ssl
  [[ "$1" == *\?* ]] && query="${1#*\?}"
  ssl="$(printf '%s' "$query" | tr '&' '\n' | grep '^sslmode=' || true)"
  if [ -n "$ssl" ]; then printf '%s?%s' "$base" "$ssl"; else printf '%s' "$base"; fi
}
is_local() { [[ "$1" =~ (@|//)(localhost|127\.0\.0\.1)(:|/) ]]; }
# host:port/db of a URL, without credentials or options, for comparisons.
identity() { local u="${1%%\?*}"; u="${u#*://}"; u="${u##*@}"; printf '%s' "$u"; }

DUMP="${1:-}"
TARGET="${2:-}"
FLAG="${3:-}"
[ -f "$DUMP" ] && [ -n "$TARGET" ] || die "usage: restore.sh <dump file> <TARGET_URL> [--i-understand-this-overwrites-production]"
[ -z "$FLAG" ] || [ "$FLAG" = "--i-understand-this-overwrites-production" ] || die "unknown option $FLAG"

# Only read the two URL lines from the env file, for comparison; never connect to them.
if [ -f "$PROD_ENV_FILE" ]; then
  for key in DATABASE_URL DIRECT_URL; do
    prod="$(grep -E "^$key=" "$PROD_ENV_FILE" | tail -n 1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//" || true)"
    if [ -n "$prod" ] && [ "$(identity "$prod")" = "$(identity "$TARGET")" ] && [ "$FLAG" != "--i-understand-this-overwrites-production" ]; then
      die "refusing: TARGET is $key from $(basename "$PROD_ENV_FILE"). Pass --i-understand-this-overwrites-production to restore over it."
    fi
  done
fi
is_local "$TARGET" || [ "${ALLOW_REMOTE:-}" = "1" ] || die "refusing non-local TARGET without ALLOW_REMOTE=1"

cat <<EOF
restore: $(basename "$DUMP") -> $(identity "$TARGET")
  1. verify checksum (.sha256 sidecar)
  2. pg_restore --clean --if-exists --no-owner (drops and recreates every object in the dump)
  3. afterwards: run 'npx prisma migrate status' against TARGET, check /api/health?db=1,
     compare row counts with $(basename "$DUMP").counts, and re-run scheduled jobs
EOF

if [ -f "$DUMP.sha256" ]; then
  (cd "$(dirname "$DUMP")" && shasum -a 256 -c "$(basename "$DUMP").sha256" >/dev/null) || die "checksum mismatch"
  echo "restore: checksum OK"
fi

"$PG_RESTORE" --clean --if-exists --no-owner --exit-on-error -d "$(libpq_url "$TARGET")" "$DUMP"
echo "restore: OK"
