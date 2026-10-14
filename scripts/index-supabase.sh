#!/usr/bin/env bash
# Aplica las migraciones en un proyecto Supabase real e indexa Testnet con reconciliación.
# Requiere DATABASE_URL (connection string del proyecto) en el entorno o en
# /root/.config/agrobank/supabase.env.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f /root/.config/agrobank/supabase.env ] && { set -a; . /root/.config/agrobank/supabase.env; set +a; }
: "${DATABASE_URL:?Falta DATABASE_URL}"
applied=$(docker run --rm --network host postgres:16-alpine psql "$DATABASE_URL" -tAc "select to_regclass('public.oracle_audit') is not null" 2>/dev/null || echo f)
if [ "$applied" != "t" ]; then
  for f in supabase/migrations/*.sql; do
    docker run --rm -i --network host postgres:16-alpine psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 < "$f"
  done
  echo "migraciones aplicadas en Supabase"
else
  echo "migraciones ya presentes"
fi
cd apps/web
set -a; . ./.env.local; set +a
. /root/.config/agrobank/supabase.env
node scripts/indexer.ts --reconcile-out ../../docs/supabase-reconciliation.json 2>&1 | grep -v MODULE_TYPELESS | tail -20
