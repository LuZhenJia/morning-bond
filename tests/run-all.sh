#!/usr/bin/env bash
# =====================================================================
#  一次執行全部測試
#    bash tests/run-all.sh
#    OLD_GAME_URL="file:///完整路徑/晨光羈絆.html" bash tests/run-all.sh   # 加跑與 v1.1 單檔版的等價／相容測試
#  需要：Node.js 22 以上、Python 3（pip install playwright）、PostgreSQL 16、Google Chrome 或 Chromium
#  可調整：PG_BIN（PostgreSQL 執行檔資料夾）、CHROME（瀏覽器路徑）、WEB_PORT（預設 8080）
# =====================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
WEB_PORT="${WEB_PORT:-8080}"
cd "$HERE"
[ -d node_modules ] || npm install --no-audit --no-fund

bash emulator/pg.sh reset || { echo "PostgreSQL 啟動失敗（可用 PG_BIN 指定 PostgreSQL 16 的 bin 資料夾）"; exit 1; }
node --experimental-strip-types emulator/server.mjs > /tmp/mb-emulator.log 2>&1 &
EMU_PID=$!
python3 -m http.server "$WEB_PORT" --bind 127.0.0.1 --directory "$(dirname "$ROOT")" > /dev/null 2>&1 &
WEB_PID=$!
trap 'kill $EMU_PID $WEB_PID 2>/dev/null' EXIT
sleep 2

RESULTS=()
N=0
run() {
  local name="$1"; shift
  N=$((N + 1))
  local log="/tmp/mb-test-${N}.log"
  echo "=== $name"
  "$@" > "$log" 2>&1
  local code=$?
  tail -n 4 "$log"
  if [ $code -ne 0 ] || grep -qE '^FAIL|ERRORS: [1-9]|^ERRORS \[|pageerror' "$log"; then
    RESULTS+=("FAIL  $name（詳細：$log）")
  else
    RESULTS+=("PASS  $name")
  fi
}

run "SQL／RLS 測試" node sql/sql-tests.mjs
run "Edge Function／API 測試" node --experimental-strip-types edge/recover-save.test.mjs
export GAME_URL="http://127.0.0.1:${WEB_PORT}/$(basename "$ROOT")/index.html"
for t in sim play extra v11; do
  run "v1.1 回歸測試 ${t}.py（模組版、本機模式）" python3 e2e/legacy/${t}.py
done
if [ -n "${OLD_GAME_URL:-}" ]; then
  run "新舊版等價測試" python3 e2e/equivalence.py
else
  RESULTS+=("SKIP  新舊版等價測試（未設定 OLD_GAME_URL）")
fi
run "雲端端對端測試" python3 e2e/cloud.py

echo
printf '%s\n' "${RESULTS[@]}"
! printf '%s\n' "${RESULTS[@]}" | grep -q '^FAIL'
