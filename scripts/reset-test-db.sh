#!/usr/bin/env bash
# Recreate the local test databases from scratch and apply all migrations.
# Refuses to touch anything that is not on localhost.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env.test; set +a
case "$DATABASE_URL" in *@localhost:*|*@127.0.0.1:*) ;; *) echo "refusing: DATABASE_URL is not local" >&2; exit 1;; esac
PSQL="${PG_BIN:-/opt/homebrew/opt/postgresql@17/bin}/psql -q -h localhost -p 54329 -U postgres"
for db in intracore_test intracore_shadow; do
  $PSQL -c "DROP DATABASE IF EXISTS $db WITH (FORCE)" -c "CREATE DATABASE $db"
  $PSQL -d "$db" -f scripts/local-db-bootstrap.sql 2>/dev/null
done
npx prisma migrate deploy
