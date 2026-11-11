#!/usr/bin/env bash
# 本機測試用 PostgreSQL（資料放在 /tmp/mb-pgdata，port 54329；不會動到電腦上其他的資料庫）
#   bash tests/emulator/pg.sh start   # 建立／啟動資料庫並套用 supabase-sim.sql + schema.sql + policies.sql
#   bash tests/emulator/pg.sh reset   # 清空重建
#   bash tests/emulator/pg.sh stop
set -euo pipefail
if [ -z "${PG_BIN:-}" ]; then
  if [ -x /usr/lib/postgresql/16/bin/pg_ctl ]; then PG_BIN=/usr/lib/postgresql/16/bin
  elif command -v pg_ctl >/dev/null 2>&1; then PG_BIN="$(dirname "$(command -v pg_ctl)")"
  else echo "找不到 PostgreSQL（pg_ctl），請安裝 PostgreSQL 16 或設定 PG_BIN"; exit 1; fi
fi
PG_DATA="${PG_DATA:-/tmp/mb-pgdata}"
PG_PORT="${PG_PORT:-54329}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
# 以 root 執行時改用系統的 postgres 使用者（PostgreSQL 不允許以 root 啟動）；一般使用者直接執行
as_pg() { if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi; }
psql_q() { PGOPTIONS='--client-min-messages=warning' as_pg "$PG_BIN/psql" -h /tmp -p "$PG_PORT" -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

start() {
  if [ ! -d "$PG_DATA" ]; then
    mkdir -p "$PG_DATA"
    if [ "$(id -u)" = 0 ]; then chown postgres:postgres "$PG_DATA"; fi
    as_pg "$PG_BIN/initdb" -D "$PG_DATA" -U postgres -A trust -E UTF8 --locale=C >/dev/null
  fi
  if ! as_pg "$PG_BIN/pg_ctl" -D "$PG_DATA" status >/dev/null 2>&1; then
    as_pg "$PG_BIN/pg_ctl" -D "$PG_DATA" -o "-p $PG_PORT -k /tmp -c listen_addresses=127.0.0.1 -c fsync=off" -l "$PG_DATA/server.log" -w start >/dev/null
  fi
  if ! psql_q -d postgres -tAc "select 1 from pg_database where datname='mb'" | grep -q 1; then
    psql_q -d postgres -c "create database mb"
    psql_q -d mb -f "$HERE/supabase-sim.sql"
    psql_q -d mb -f "$ROOT/supabase/schema.sql"
    psql_q -d mb -f "$ROOT/supabase/policies.sql"
    echo "database mb created on port $PG_PORT"
  fi
}
stop() { as_pg "$PG_BIN/pg_ctl" -D "$PG_DATA" -m fast stop >/dev/null 2>&1 || true; }
reset() {
  start
  psql_q -d postgres -c "drop database if exists mb with (force)"
  start
}
case "${1:-start}" in start) start ;; stop) stop ;; reset) reset ;; *) echo "usage: pg.sh start|stop|reset"; exit 1 ;; esac
