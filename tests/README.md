# tests — 測試說明

部署遊戲**不需要**這個資料夾。這裡的測試用來確認：原本的遊戲行為完全不變、雲端存檔不會遺失或覆蓋資料、權限設定正確。

## 需要的工具

| 工具 | 用途 | 測試時的版本 |
|---|---|---|
| Node.js 22 以上 | 模擬器、SQL 與 Edge Function 測試（`--experimental-strip-types` 直接執行 `handler.ts`） | 22.23 |
| PostgreSQL 16 | 真的資料庫，執行 `supabase/schema.sql`、`policies.sql` | 16.15 |
| Python 3 + Playwright（`pip install playwright`） | 瀏覽器端對端測試 | Playwright 1.63 |
| Google Chrome 或 Chromium | 預設 `/usr/bin/google-chrome`，可用環境變數 `CHROME` 指定 | Chrome for Testing 153 |

第一次執行前：`cd tests && npm install`

## 一次跑全部

```bash
bash tests/run-all.sh
# 想同時跑「與 v1.1 單檔版比對」的測試，指定舊版檔案位置：
OLD_GAME_URL="file:///完整路徑/晨光羈絆.html" bash tests/run-all.sh
```

## 各測試套件

| 檔案 | 內容 |
|---|---|
| `sql/sql-tests.mjs` | 直接在 PostgreSQL 以 `anon`／`authenticated`／`service_role` 身分執行：RLS、GRANT、觸發器（驗證、revision、備份、回憶）、所有 RPC、Storage 政策、復原代碼函式、速率與數量限制 |
| `edge/recover-save.test.mjs` | 透過模擬器與真正的 supabase-js：匿名登入、RLS 隔離、Storage 上傳下載與限制、復原代碼（產生、使用、一次性、格式、狀態、撤銷）、CORS、權杖更新與撤銷 |
| `e2e/legacy/*.py` | v1.1 單檔版原本的 4 套回歸測試，改成對模組版（本機模式）執行；只有「卡通頭像來源」一項檢查因為改用圖檔而調整 |
| `e2e/equivalence.py` | 新舊版等價測試：固定亂數種子，同樣的操作在單檔版與模組版各跑一次，比對完整狀態、所有彈出視窗、8 個分頁畫面 HTML、匯出 JSON，以及雙向匯入 |
| `e2e/cloud.py` | 雲端端對端測試（t01～t17），對應 README 的 17 項需求與額外情境 |

## 本機 Supabase 模擬器

- `emulator/pg.sh start|reset|stop`：在 `/tmp/mb-pgdata`、port 54329 建立測試用資料庫（不會動到電腦上其他的資料庫），依序套用 `emulator/supabase-sim.sql`（模擬 Supabase 的角色、`auth`、`storage` schema）、`../supabase/schema.sql`、`../supabase/policies.sql`。
- `node --experimental-strip-types emulator/server.mjs`：在 `http://127.0.0.1:54321` 模擬 Supabase 的 HTTP API。每個請求都以 JWT 裡的角色與 claims 在 PostgreSQL 執行，權限完全由資料庫的 GRANT 與 RLS 決定（與 PostgREST 相同的做法）。`/functions/v1/recover-save` 直接執行 `supabase/functions/recover-save/handler.ts`。
- 測試控制端點 `/__emu/*`：重設資料、注入錯誤（`error`、`drop`、`drop-after`、`error-after`、`delay`）、調整權杖有效時間、撤銷 refresh token、查詢資料庫。**只用於測試，絕對不要部署。**

模擬器與真正的 Supabase 不完全相同（例如錯誤訊息格式、CORS 細節、Storage 的回應內容），所以部署到真正的 Supabase 之後，仍請照 README 第 9 節的情境實際操作確認一次。

## 單獨執行

```bash
bash tests/emulator/pg.sh reset
(cd tests && node sql/sql-tests.mjs)
(cd tests && node --experimental-strip-types emulator/server.mjs &)
(cd tests && node --experimental-strip-types edge/recover-save.test.mjs)
python3 tests/e2e/cloud.py            # 全部
python3 tests/e2e/cloud.py t07 t10    # 只跑名稱包含 t07、t10 的測試

# 回歸與等價測試需要用 http 提供專案（以 /Morning-Bond/ 子路徑模擬 GitHub Pages）
python3 -m http.server 8080 --bind 127.0.0.1 --directory "$(dirname "$PWD")" &
GAME_URL=http://127.0.0.1:8080/Morning-Bond/index.html python3 tests/e2e/legacy/v11.py
OLD_GAME_URL="file:///完整路徑/晨光羈絆.html" python3 tests/e2e/equivalence.py
```
