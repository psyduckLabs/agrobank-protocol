#!/usr/bin/env bash
# Prueba del indexador contra un Postgres local con las migraciones de supabase/.
set -euo pipefail
cd "$(dirname "$0")/.."
NAME=agrobank-pg-test; PORT=54329
docker rm -f $NAME >/dev/null 2>&1 || true
docker run -d --name $NAME -e POSTGRES_PASSWORD=agrobank -p 127.0.0.1:$PORT:5432 postgres:16-alpine >/dev/null
for i in $(seq 1 30); do docker exec $NAME pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2
for f in supabase/local-test/auth_stub.sql supabase/migrations/*.sql; do
  docker exec -i $NAME psql -q -v ON_ERROR_STOP=1 -U postgres < "$f"
done
echo "migraciones aplicadas"
cd apps/web
set -a; . ./.env.local; set +a
export DATABASE_URL=postgres://postgres:agrobank@127.0.0.1:$PORT/postgres
node scripts/indexer.ts | head -1
node scripts/indexer.ts --reconcile-out ../../docs/indexer-reconciliation.json | tail -25
docker rm -f $NAME >/dev/null
