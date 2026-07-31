#!/usr/bin/env bash
# Прогоняет миграции и тесты модели защиты на чистой базе.
#
# Локально:  bash scripts/test-db.sh          (нужен запущенный postgres)
# В CI:      база поднимается сервис-контейнером, см. .github/workflows.
#
# PGURL по умолчанию рассчитан на локальный кластер; переопределяется
# переменной окружения.
set -euo pipefail
cd "$(dirname "$0")/.."

PGURL="${PGURL:-postgresql://postgres@localhost:5432/postgres}"
DBNAME="${DBNAME:-amzn_pl_test}"

echo "==> пересоздаю базу $DBNAME"
psql "$PGURL" -q -v ON_ERROR_STOP=1 -c "drop database if exists $DBNAME" \
                                    -c "create database $DBNAME"

TESTURL="${PGURL%/*}/$DBNAME"
psql_run() { psql "$TESTURL" -q -v ON_ERROR_STOP=1 "$@"; }

echo "==> заглушки окружения Supabase"
psql_run -f supabase/tests/00_supabase_stubs.sql

echo "==> миграции"
for f in supabase/migrations/*.sql; do
  echo "    $f"
  psql_run -f "$f"
done

echo "==> тесты безопасности"
psql_run -f supabase/tests/security_test.sql

echo "==> уборка"
psql "$PGURL" -q -c "drop database if exists $DBNAME" >/dev/null
echo "OK"
