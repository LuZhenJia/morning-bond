# 部署紀錄（2026-11-11）

## 網址

| 項目 | 網址 |
|---|---|
| 遊戲（GitHub Pages） | <https://luzhenjia.github.io/morning-bond/> |
| 原始碼（GitHub，public） | <https://github.com/LuZhenJia/morning-bond> |
| 部署紀錄（GitHub Actions） | <https://github.com/LuZhenJia/morning-bond/actions> |
| Supabase 管理後台 | <https://supabase.com/dashboard/project/qflkjbqcygvqmvsqdras>（只有專案擁有者能登入） |

## 部署內容

### GitHub Pages
- Pages 來源：**GitHub Actions**（`.github/workflows/deploy.yml`），推送到 `main` 就會自動重新部署。
- 只發布遊戲需要的檔案：`index.html`、`.nojekyll`、`css/`、`js/`、`assets/`；`tests/`、`supabase/`、`tools/`、`js/config.example.js` 不會出現在網站上。
- 部署前會掃描網站檔案，發現疑似 Supabase Secret key（`sb_secret_…`）就停止部署。

### Supabase（專案 `morning-bond`，Northeast Asia (Tokyo)，Free 方案）
- **資料庫**：執行 `supabase/schema.sql`、`supabase/policies.sql`。8 張資料表全部啟用 RLS；`anon`（未登入）沒有任何資料表或函式權限；`authenticated`（含匿名玩家）只能透過 RLS 存取自己玩家的資料；復原代碼相關資料表只有 Edge Function（service role）能操作。
- **Auth**：允許匿名登入（Allow anonymous sign-ins）；Site URL `https://luzhenjia.github.io/morning-bond/`；Redirect URL `https://luzhenjia.github.io/morning-bond/**`；匿名登入速率限制為每個 IP 每小時 30 次（Supabase 預設值）。
- **Storage**：`player-photos` 私有 bucket，單檔 1 MB，只收 JPEG／PNG／WebP，每位玩家只能存取自己的資料夾。
- **Edge Function**：`recover-save`（`index.ts`＋`handler.ts`）。已關閉「Verify JWT with legacy secret」——函式本身會用 `auth.getUser()` 驗證玩家身分，不需要也不接受 API key。
- **Edge Function Secrets**：`RECOVERY_CODE_PEPPER`（在瀏覽器內隨機產生後直接存進 Supabase，沒有出現在任何檔案、對話或 Git 紀錄）、`ALLOWED_ORIGINS = https://luzhenjia.github.io`。

### 前端設定（`js/config.js`）
只有 **Project URL**（`https://qflkjbqcygvqmvsqdras.supabase.co`）與 **Publishable key**（`sb_publishable_…`）。這兩個值本來就是公開的，資料安全由 RLS 保護。Repository 與網站都**沒有** Secret key、service_role key、資料庫密碼或任何 Token。

## 線上實測結果

2026-11-11 23:43～23:53（台灣時間），在 Claude 的內建瀏覽器（Chromium 系）開啟正式網址，使用**測試專用的存檔欄位** `?slot=e2e`，不會碰到正式存檔（`main`）。

| # | 測試 | 結果 | 說明 |
|---|---|---|---|
| A | 第一次開啟網站 | 成功 | 所有檔案 HTTP 200、主控台沒有錯誤；自動建立匿名身分（`/auth/v1/signup`）與玩家資料（`ensure_player`）；按「開始修行」後建立雲端存檔。 |
| B | 重新整理後還原 | 成功 | 重新整理後身分與玩家不變、進度雜湊完全相同、沒有多餘寫入、沒有衝突視窗；把這個欄位的本機存檔刪掉再重新整理，也能從雲端完整還原。 |
| C | 修改資料後雲端更新 | 成功 | 在「設定」改主角名字並儲存 → 約 2.5 秒後自動上傳，版本 4 → 5、`updated_at` 更新；在 SQL Editor 直接查資料庫確認內容一致。 |
| D | 跨裝置（復原代碼） | 成功（模擬） | 產生復原代碼（Edge Function 正常執行）→ 用**另一個匿名身分**（模擬第二台裝置）輸入代碼 → 接回同一位玩家、讀到相同存檔；第二台寫入後，第一台自動採用新進度；錯誤代碼被拒（`invalid_code`）、用過的代碼不能再用（`code_used`）、用舊版本號寫入被拒（`revision_conflict`，不會覆蓋較新的雲端資料）。 |
| D' | 用實體的第二台裝置（例如手機）接回 | 尚未驗證 | 需要你在另一台裝置上操作一次（見下方「手動事項」）。 |
| E1 | 未登入（只有 Publishable key） | 成功 | 讀取 `game_saves`、`players`、`recovery_codes` 與呼叫 `load_game_save`、`ensure_player` 都回傳 401（permission denied）；列不出任何照片。部署時的權限檢查也確認 `anon` 沒有任何資料表或函式權限。 |
| E2 | 其他玩家讀寫你的資料 | 成功 | 另一位（有自己存檔的）玩家：讀不到你的存檔、玩家資料、裝置連結、雲端備份與回憶；改寫、新增、刪除你的存檔或玩家資料都無效（直接寫資料表或透過 RPC 都一樣）；讀不到復原代碼表。攻擊後你的存檔版本與內容完全不變。 |
| E3 | Storage 照片權限 | 成功 | 自己的資料夾可上傳／列出／下載／刪除；其他玩家下載 404、列出 0 筆、上傳 403、刪除無效；公開網址無法存取（私有 bucket）；非圖片 415、超過 1 MB 413、檔名或子資料夾不符 403。 |
| E4 | Edge Function 安全性 | 成功 | 沒有登入權杖、偽造權杖、把 Publishable key 當權杖都回傳 401；GET 回傳 405；從其他網域呼叫被 CORS 擋下（只允許 `https://luzhenjia.github.io`）。 |
| F | 刪除雲端存檔（遊戲內功能） | 成功 | 需要輸入「刪除」才會執行；刪除後雲端存檔消失、停用同步，本機進度仍在；雲端備份列表可正常顯示。 |
| G | 遊戲內「上傳照片」介面（線上） | 尚未驗證 | 照片的 Storage 權限已在 E3 實測；遊戲介面上傳流程只在本機模擬器測過。 |
| H | 真正的斷網與恢復（線上） | 尚未驗證 | 只在本機模擬器測過（README 第 9 節）。 |
| I | Safari／Firefox／手機瀏覽器 | 尚未驗證 | 只測過 Chromium 系瀏覽器。 |

### 測試資料清理
- 測試用的雲端存檔用遊戲內「刪除雲端存檔」功能刪除；兩位測試玩家用「刪除自己的玩家資料」權限刪除（連帶刪除存檔、備份、回憶、裝置連結與復原代碼）；測試照片已刪除。
- 清理後資料庫：玩家 0、存檔 0、備份 0、回憶 0、照片 0。
- Supabase Auth 裡留下 3 個測試用的匿名身分（沒有任何資料）。另有 1 個 23:43:09 建立的匿名身分不是測試建立的（可能是你或其他人打開網站時產生的），同樣沒有資料，沒有動它。這些身分可以留著；若想清掉，可在 Authentication → Users 刪除，或之後用 `select public.mb_cleanup_stale_anonymous(90);` 清理長期沒用的匿名身分。

## 需要你手動處理的事項

1. **把舊版（電腦裡的單檔 HTML）存檔搬過來**：舊版存在 `file://` 的瀏覽器儲存區，新網站讀不到，只能手動搬一次——打開舊版 →「設定」→「匯出存檔」→ 打開新網站 →「匯入存檔 JSON」。詳見 README 第 5 節。舊的 HTML 與 JSON 請留著當備份。
2. **在你自己的瀏覽器開一次網站確認**：左下角應顯示「已同步」。
3. **（建議）產生復原代碼並另外保存**：遊戲左下角「雲端存檔」→「產生復原代碼」。換手機或瀏覽器資料被清掉時，需要它才能接回雲端存檔。
4. **（選擇性）用手機實測跨裝置**：在手機打開網站 →「雲端存檔」→「輸入復原代碼」。
5. **資料庫密碼**：建立 Supabase 專案時是自動產生的，沒有保存在任何地方；平常用不到，真的需要直接連資料庫時，到 Project Settings → Database 重設即可。

## 注意事項

- **Free 方案會在約 7 天沒有活動後自動暫停專案**（Supabase 會先寄信通知）。暫停期間遊戲仍可在本機遊玩，雲端同步會顯示失敗；到 Supabase 後台按 **Resume project** 恢復後會自動補傳。
- 更新遊戲：修改檔案 → push 到 `main` → GitHub Actions 自動部署。GitHub Pages 有快取，更新後可按 Ctrl+Shift+R 強制重新整理。
- Supabase 建議匿名登入搭配 CAPTCHA 防濫用；本專案尚未整合 CAPTCHA，**不要直接在 Supabase 開啟 CAPTCHA**，否則匿名登入會失敗。
