# 晨光羈絆：學園修行物語 — Morning-Bond（雲端存檔版 v2.0）

把原本的單檔 HTML（v1.1）重構成可以直接放上 **GitHub Pages** 的 ES Modules 專案，並加上 **Supabase 雲端存檔**（匿名身分、自動同步、雲端備份、照片存 Storage、舊存檔遷移、復原代碼）。

- **遊戲內容完全沒有改**：劇情、角色、對話、等級與成長公式、好感度、道具、任務、成就、課表、出勤、每日結算、照片、匯出入、版本遷移，全部沿用 v1.1 的程式碼。
  等價測試以相同亂數種子、相同操作同時跑單檔版與新版，**完整狀態 S、每一個彈出視窗、8 個分頁的畫面 HTML、匯出的 JSON 逐字相同**（見「測試」）。
- **沒有填 `js/config.js` 時就是本機模式**：行為與單檔版相同，資料只存在瀏覽器。
- 前端只放 **Project URL** 與 **Publishable key**；放了 Secret / service_role key 會被偵測並自動停用雲端功能。

> **線上版本**：<https://luzhenjia.github.io/morning-bond/>（GitHub Actions 自動部署；雲端存檔使用 Supabase 專案 `morning-bond`）。
> 部署設定、線上實測結果與需要手動處理的事項見 [`DEPLOYMENT.md`](DEPLOYMENT.md)。

---

## 目錄

1. [專案結構](#1-專案結構)
2. [Supabase 設定步驟](#2-supabase-設定步驟)
3. [前端設定：js/config.js](#3-前端設定jsconfigjs)
4. [GitHub Pages 部署步驟](#4-github-pages-部署步驟)
5. [從舊版（單檔 HTML）搬家](#5-從舊版單檔-html搬家)
6. [雲端存檔怎麼運作](#6-雲端存檔怎麼運作)
7. [安全性說明（含 RLS 的限制）](#7-安全性說明含-rls-的限制)
8. [防濫用設計](#8-防濫用設計)
9. [測試清單與結果](#9-測試清單與結果)
10. [本機預覽與執行測試](#10-本機預覽與執行測試)
11. [尚未完成／尚未驗證的項目](#11-尚未完成尚未驗證的項目)
12. [維護](#12-維護)

---

## 1. 專案結構

```
Morning-Bond/
├── index.html                  頁面骨架（與單檔版相同）＋雲端狀態膠囊與雲端對話框的容器
├── .nojekyll                   讓 GitHub Pages 原樣提供所有檔案
├── .gitignore
├── css/
│   ├── style.css               原本的樣式（與 v1.1 逐位元組相同）
│   └── cloud.css               只給雲端元件用的新樣式（狀態膠囊、雲端對話框）
├── js/
│   ├── main.js                 啟動順序：存檔管理器 → 舊存檔備份 → 分頁鎖 → 遊戲 → 連接雲端
│   ├── config.js               ★ 唯一需要填的檔案：Project URL、Publishable key
│   ├── game.js                 遊戲本體（v1.1 原始程式；只加了 HOOKS 掛勾與對外介面）
│   ├── supabase.js             載入 supabase-js、匿名身分、金鑰檢查、錯誤分類
│   ├── cloud-save.js           雲端資料層：呼叫資料庫 RPC 與 recover-save Edge Function
│   ├── storage.js              localStorage 工具、checksum、本機備份、照片快取、Storage 上傳下載
│   ├── save-manager.js         存檔管理器：自動同步、遷移、衝突、照片、復原代碼、多分頁
│   ├── cloud-ui.js             雲端狀態提示與對話框
│   └── vendor/
│       └── supabase-js-2.119.0.js   打包好的 supabase-js（MIT），不需要 CDN 或建置工具
├── assets/
│   ├── images/toon/            全家福卡通頭像（原本內嵌在 HTML 裡的圖片，改成獨立檔案）
│   └── audio/README.md         遊戲用瀏覽器語音合成，沒有音訊檔（說明）
├── supabase/
│   ├── schema.sql              資料表、索引、外鍵、觸發器、資料驗證、RPC
│   ├── policies.sql            RLS、GRANT、Storage bucket 與 Storage 政策
│   └── functions/recover-save/
│       ├── index.ts            Edge Function 進入點（Deno）
│       └── handler.ts          復原代碼邏輯（與執行環境無關，測試也直接用它）
├── tools/vendor/               重新打包 supabase-js 的工具（部署不需要）
└── tests/                      測試（部署不需要）
```

`game.js` 與 v1.1 的差異只有：
- `save()` 之後呼叫 `HOOKS.afterSave`，重要事件（開始、結算、重新開始、匯入、新學期、照片）呼叫 `emit()`；
- 卡通頭像改成 `assets/images/toon/` 的相對路徑（`new URL(..., import.meta.url)`，相容 GitHub Pages 子路徑）；
- 雲端照片的路徑欄位 `profile.photoRefs`（只有雲端模式上傳照片後才會出現）；
- 匯出時由存檔管理器把雲端照片補回 data URL；說明文字在雲端模式時換成雲端版；
- 同一個瀏覽器開了第二個分頁時，暫停的分頁不寫入存檔（`HOOKS.allowSave`）；
- 最後加上 `export`（`init`、`getState`、`replaceState` …）給其他模組使用。

沒有設定雲端時，所有 HOOKS 都是空的。

---

## 2. Supabase 設定步驟

> 以下以 2026 年 11 月的 Supabase Dashboard 為準；選單名稱若有更動，以官方文件為主。

1. **建立專案**：<https://supabase.com/dashboard> → New project。
2. **開啟匿名登入**：Authentication → Sign In / Providers → 開啟 **Allow anonymous sign-ins** → Save。
3. **限制匿名登入頻率**：Authentication → Rate Limits → 「Anonymous sign-ins」預設每個 IP 每小時 30 次，可以視情況調低。
   - 官方建議匿名登入搭配 CAPTCHA（Turnstile／hCaptcha）。**本版前端還沒有整合 CAPTCHA，開啟 CAPTCHA 後匿名登入會失敗**，見「尚未完成」。
4. **執行 SQL**：SQL Editor → New query
   1. 貼上 `supabase/schema.sql` 全部內容 → Run
   2. 再貼上 `supabase/policies.sql` 全部內容 → Run

   順序不能顛倒；兩個檔案都可以重複執行（升級時直接重跑即可，不會刪資料）。
   - 2026 年起 Supabase 的 `public` 資料表**不再自動開放給 Data API**（新專案自 5/30、既有專案自 10/30 起），必須明確 `GRANT`。`policies.sql` 已經包含所有需要的 `GRANT`（資料表與函式），而且只開放給 `authenticated`（匿名玩家登入後的角色），`anon` 什麼都拿不到。
   - 請確認 Settings → Data API 的 Exposed schemas 包含 `public`（預設就有）。
5. **確認 Storage**：Storage 應該出現私有 bucket **`player-photos`**（每張 1 MB 以內、只收 JPEG／PNG／WebP；由 `policies.sql` 建立）。
6. **部署復原代碼的 Edge Function `recover-save`**（換裝置／找回存檔用；不部署的話其他雲端功能照常，只有按「復原代碼」時會提示「請確認已部署 recover-save、ALLOWED_ORIGINS 包含這個網站」）：
   1. 安裝 Supabase CLI（<https://supabase.com/docs/guides/cli>；macOS 可用 Homebrew、Windows 可用 Scoop，或用 `npx supabase`）。
   2. 在專案資料夾（有 `supabase/` 的那一層）執行：
      ```bash
      supabase login
      supabase link --project-ref <你的 project ref>        # 若提示找不到 config.toml，先執行 supabase init
      supabase secrets set RECOVERY_CODE_PEPPER=<至少 32 字元的隨機字串，例如 openssl rand -hex 32 的結果>
      supabase secrets set ALLOWED_ORIGINS=https://<你的 GitHub 帳號>.github.io
      supabase secrets set RECOVERY_CODE_TTL_HOURS=168        # 代碼有效時數，可省略（預設 168 = 7 天）
      supabase functions deploy recover-save --no-verify-jwt
      ```
   3. 為什麼要 `--no-verify-jwt`：平台內建的 JWT 檢查只認得舊版（JWT 格式）金鑰；新的 Publishable／Secret key 不是 JWT。這個函式**自己驗證**呼叫者：只接受使用者的存取權杖（Bearer JWT），並用 `auth.getUser()` 向 Supabase 確認，API key 不能當作身分。也可以改在 `supabase/config.toml` 加上：
      ```toml
      [functions.recover-save]
      verify_jwt = false
      ```
   - **不想裝 CLI**：也可以全部在 Dashboard 完成（本專案的正式部署就是這樣做的）——Edge Functions → Secrets 新增上面兩個（或三個）Secret；Edge Functions → Deploy a new function → Via Editor，建立 `index.ts` 與 `handler.ts` 兩個檔案、貼上 `supabase/functions/recover-save/` 裡對應的內容，Function name 填 `recover-save` → Deploy；部署後到函式的 Settings 關閉 **Verify JWT with legacy secret** → Save changes。
   4. 函式需要的 `SUPABASE_URL`、`SUPABASE_SECRET_KEYS`（或舊版 `SUPABASE_SERVICE_ROLE_KEY`）由 Supabase 自動提供給 Edge Function，**不要**放到前端或 GitHub。
   5. `RECOVERY_CODE_PEPPER` 設定後不要再改：改了之後，所有還沒用掉的復原代碼都會失效（伺服器只存代碼的 HMAC 雜湊）。

### 需要設定的值（總表）

| 位置 | 名稱 | 值 | 是否公開 |
|---|---|---|---|
| `js/config.js` | `supabaseUrl` | Project URL，例如 `https://abcd1234.supabase.co` | 公開（會出現在瀏覽器） |
| `js/config.js` | `supabasePublishableKey` | Publishable key（`sb_publishable_…`；舊專案也可用 legacy `anon` key） | 公開 |
| Edge Function secret | `RECOVERY_CODE_PEPPER` | 32 字元以上隨機字串 | **保密** |
| Edge Function secret | `ALLOWED_ORIGINS` | 允許呼叫的網站來源，例如 `https://yourname.github.io`（多個用逗號分隔；只寫來源，不含路徑） | 不敏感 |
| Edge Function secret | `RECOVERY_CODE_TTL_HOURS` | 復原代碼有效時數（1～720，預設 168） | 不敏感 |
| 自動提供 | `SUPABASE_URL`、`SUPABASE_SECRET_KEYS`／`SUPABASE_SERVICE_ROLE_KEY` | 不用設定 | **保密，只在 Edge Function 內** |

---

## 3. 前端設定：js/config.js

```js
export const CONFIG = Object.freeze({
  supabaseUrl: 'https://abcd1234.supabase.co',          // Settings → Data API（或 API）→ Project URL
  supabasePublishableKey: 'sb_publishable_xxxxxxxxxxxx', // Settings → API Keys → Publishable key
  ...
});
```

- **只能填 Publishable key**（或 legacy `anon` key）。填到 `sb_secret_…` 或 `service_role` 的 JWT，遊戲會在主控台報錯並**停用雲端功能**（以本機模式繼續），避免金鑰外洩後被拿來繞過 RLS。
- 非 `https://` 的網址會被拒絕（`http://localhost`、`http://127.0.0.1` 例外，方便本機測試）。
- 兩個欄位留空 = 本機模式。
- 其他選項（通常不用改）：`autosaveDebounceMs` 2500（連續操作停止 2.5 秒後上傳）、`autosaveMaxWaitMs` 15000（連續操作時最久 15 秒一定上傳一次）、`syncIntervalMs` 45000（每 45 秒背景同步／檢查其他裝置）、`bootGateTimeoutMs` 8000（新裝置開啟時最多等雲端 8 秒）。

---

## 4. GitHub Pages 部署步驟

1. 在 GitHub 建立 repository（例如 `Morning-Bond`）。免費帳號的 GitHub Pages 需要 **public** repository。
2. 把 `Morning-Bond/` 資料夾**裡面**的所有檔案放到 repository 的根目錄（`index.html` 要在最上層），推到 `main` branch：
   ```bash
   cd Morning-Bond
   git init
   git add .
   git commit -m "Morning-Bond v2.0"
   git branch -M main
   git remote add origin https://github.com/<你的帳號>/Morning-Bond.git
   git push -u origin main
   ```
   用網頁上傳也可以，但要確認隱藏檔 `.nojekyll` 也有上傳。`tests/`、`tools/` 不會被遊戲載入，要不要上傳都可以。
3. Settings → Pages → Build and deployment → Source 選 **GitHub Actions**。本專案附的 `.github/workflows/deploy.yml` 會在每次推送到 `main` 時自動部署，而且只發布遊戲需要的檔案（`index.html`、`.nojekyll`、`css/`、`js/`、`assets/`），部署前會掃描是否誤放 Secret key。
   （不想用 Actions 的話，也可以改選 **Deploy from a branch** → Branch **main**、資料夾 **/ (root)**，但這樣 `tests/`、`supabase/` 等檔案也會一起公開在網站上。）
4. 等 1～2 分鐘，網址是 `https://<你的帳號>.github.io/Morning-Bond/`。所有路徑都是相對路徑，放在子路徑下可以正常運作。
5. 回到第 2 節第 6 步，把 `ALLOWED_ORIGINS` 設成 `https://<你的帳號>.github.io`。
6. 之後更新：推送新的 commit，Pages 會自動重新部署。GitHub Pages 會快取幾分鐘，更新後若畫面怪怪的，請按 Ctrl+Shift+R（Mac：Cmd+Shift+R）強制重新整理。

> ES Modules 不能用「直接雙擊 index.html」（`file://`）開啟，一定要透過 http(s)。GitHub Pages 本身就是 https；本機預覽方法見第 10 節。

---

## 5. 從舊版（單檔 HTML）搬家

瀏覽器的 localStorage 是**依網站來源分開**的，所以分兩種情況：

**A. 舊版放在同一個網址來源（例如同一個 GitHub Pages 網站）**——第一次打開新版會自動遷移：
1. 先把舊存檔原封不動另存一份（`morning-bond:legacy-backup:main`），**舊的存檔不會被刪除**；
2. 用原本的 `migrate()` 讀取（v1 存檔會先升級成 v2：移除體育課、探索永續改整學期、補上妹妹課表與「兩張課表」劇情）；
3. 上傳完整狀態；**確認雲端寫入成功後**才把遷移標記為完成；失敗會保留資料並自動重試；
4. 舊存檔裡的照片會上傳到 Storage，上傳成功後存檔才改存路徑；備份裡的原始照片一直都在；
5. 雲端已經有存檔時，不會用空白存檔覆蓋；兩邊進度不同時會請你選擇，而且兩份都會保留。

**B. 舊版是電腦裡的 `晨光羈絆.html`（用 `file://` 開啟）**——新網站讀不到那個瀏覽器儲存區，請手動搬一次：
1. 用原本的方式打開舊版 → 「設定」→「匯出存檔」，會下載 `晨光羈絆存檔-日期.json`；
2. 打開新版網站 → 歡迎畫面的「匯入存檔 JSON」（或「設定」→ 匯入、左下角「雲端存檔」面板 → 匯入）；
3. 匯入後會自動上傳到雲端（照片也在 JSON 裡，一起搬過去）。舊的 HTML 與 JSON 建議留著當備份。

---

## 6. 雲端存檔怎麼運作

### 資料表

| 資料表 | 內容 |
|---|---|
| `players` | 邏輯上的「玩家」（一份雲端進度的擁有者）；寫入次數計數（防濫用） |
| `player_members` | 哪些匿名身分（裝置／瀏覽器）屬於這位玩家。換裝置時用復原代碼把新的匿名身分加入同一位玩家，兩台裝置就會互相同步 |
| `game_saves` | **完整的遊戲狀態 S（JSONB，一個欄位都不拆）**、revision、checksum、衍生欄位（版本、是否開始、結算日、等級、大小）、最後寫入的裝置與操作編號 |
| `save_snapshots` | 雲端備份：匯入、還原、重新開始、新學期、衝突、遷移、每次結算前，或距上次備份超過 6 小時，自動保存上一版（每份存檔保留 40 份） |
| `memories` | 對話及回憶：從存檔自動整理出的紀念冊劇情、徽章、收藏、妹妹的訊息、日誌、結局（只增不改；讀檔時不需要它，存檔本身仍完整） |
| `recovery_codes` | 復原代碼（只存 HMAC 雜湊）、到期時間、使用紀錄 |
| `recovery_attempts`、`membership_changes` | 復原嘗試紀錄（限制猜測）、裝置加入紀錄（稽核） |

S 的所有欄位（`profile`、`settings`、`player`、`bonds`、`items`、`grants`、`streak`、`counters`、`schedule`、`sisSchedule`、`days`、`weekly`、`monthly`、`holidayEv`、`midEv`、`sibWeekly`、`syncDays`、`tasks`、`shares`、`album`、`achievements`、`collection`、`recentEvents`、`queue`、`log`、`ending`、`history`、`flags`、`version`、`started`、`settledThrough` …）整份存進 `game_saves.state`，所以不會因為拆欄位而漏資料；未來遊戲新增欄位也不用改資料庫。

### 存檔流程

- **本機優先**：每次存檔先照原本方式寫入 localStorage（離線也能玩），再排程上傳。
- **自動上傳**：連續操作 debounce 2.5 秒；最久 15 秒一定上傳；開始遊戲、每日結算、重新開始、匯入、新學期、照片這些重要事件 0.2～0.3 秒內上傳；每 45 秒背景同步一次（檢查其他裝置的新進度）。
- **切到背景（visibilitychange → hidden）、關閉分頁（pagehide）立即補存**；不靠 `beforeunload`。
- **同一時間只會有一個寫入請求**，後來的變更等前一個完成後合併送出。
- **revision 比對**：每次寫入都帶「我是以第幾版為基準」，雲端已經被別的裝置更新就會被拒絕（不會互相覆蓋）。
- **操作編號（op_id）**：伺服器已寫入但回應遺失時，重送不會重複套用；送出前先把這次寫入記在 localStorage，重新整理後也認得「那一版是自己寫的」，不會誤判成衝突。
- **離線**：狀態顯示「離線模式・待同步」，待同步標記也存在 localStorage；恢復連線、重新開啟頁面時自動補傳；伺服器錯誤以 2、5、15、30、60 秒間隔重試。
- **衝突**：這台裝置沒有未同步的變更 → 自動採用雲端較新版；兩邊都改了 → 顯示兩份進度的比較，讓你選擇，並可先下載兩份 JSON；被取代的那一份一定留著（本機備份＋雲端備份）。
- **防止空白覆蓋**：本機存檔遺失或被清空時會從雲端讀回；伺服器也拒絕用「尚未開始」的存檔覆蓋已開始的存檔（明確的「重新開始」除外，而且重新開始前會先備份）。
- **版本保護**：雲端存檔來自較新版本的遊戲時，這台裝置停止上傳並提示更新，不會用舊格式蓋掉。
- **同一個瀏覽器開兩個分頁**：只有一個分頁負責存檔（Web Locks），另一個顯示「遊戲已在另一個分頁開啟」，可以按「在這個分頁繼續」接手；暫停的分頁不會把舊畫面寫回存檔。
- **刪除雲端存檔**（雲端存檔面板 → 進階）：刪除雲端的存檔、備份與回憶，並停用**這台裝置**的自動同步；本機進度保留，之後可以按「重新開啟雲端同步」。其他用復原代碼連結的裝置不受這個設定影響，下次同步時會用它們自己的本機進度重新建立雲端存檔（不會因此遺失進度）。

### 狀態提示（左下角）

正在連接雲端 → 雲端同步中 → 已同步（顯示時間）／離線模式（待同步）／同步失敗（自動重試）／存檔衝突／已在其他分頁。點一下打開「雲端存檔」面板：立即同步、匯出／匯入 JSON、產生／輸入復原代碼、查看與還原雲端備份、刪除雲端存檔（本機進度保留）、最後成功同步時間、連結裝置數、雲端回憶數量。

### 照片

- 上傳的照片先照原本方式縮成 256×307 的 JPEG（data URL），**上傳到 Storage 成功後**存檔才改存路徑 `player-photos/<玩家編號>/<角色>-<SHA-256 前 16 碼>.jpg`，並在本機留一份快取；上傳失敗就繼續以 data URL 留在存檔裡（不會遺失），下次同步再試。
- 換到沒有快取的裝置時，自動從 Storage 下載。
- **匯出 JSON 時把照片補回 data URL**，格式與單檔版完全相同，可以匯入舊版。
- 換掉或移除的舊照片，只有在目前存檔與**所有雲端備份都不再使用時**才從 Storage 刪除（還原備份時照片不會不見）。

### 復原代碼（Save Recovery）

- 20 碼、約 100 bits 安全隨機（Crockford Base32，不分大小寫，O／0、I／L／1 視為相同），格式 `XXXX-XXXX-XXXX-XXXX-XXXX`；**不是玩家 UUID**。
- 伺服器只存 `HMAC-SHA256(pepper, 代碼)`；有效期限（預設 7 天）、**只能用一次**、產生新代碼時舊的自動作廢、每位玩家每天最多產生 10 組。
- 驗證只在 Edge Function（service role）裡進行；前端無法讀取 `recovery_codes`，也呼叫不到相關函式。
- 猜錯限制：每個身分每小時 5 次、每個 IP 每小時 20 次。
- 輸入代碼的裝置如果在雲端已有自己的進度，會先請你確認；接回後若本機進度和雲端不同，會顯示衝突選擇（建議使用雲端），本機進度先留備份，原本那份雲端存檔也不會被刪除。

---

## 7. 安全性說明（含 RLS 的限制）

- 前端只有 Project URL 與 Publishable key（本來就是公開的）。Secret key 只存在 Edge Function 的環境變數。
- **RLS（Row Level Security）**：所有資料表都啟用 RLS；每個政策都以「目前登入的匿名身分屬於哪位玩家」判斷，玩家只能讀寫自己的存檔、備份、回憶與照片。`anon`（沒有登入）拿不到任何資料；復原代碼表前端完全不可讀。
- **伺服器端資料驗證**：存檔必須是物件、有必要欄位、版本號合理、大小 ≤ 3 MB；不可改存檔的擁有者與欄位名稱；不可用空白存檔覆蓋已開始的存檔；不可用舊版本格式覆蓋新版本；每位玩家最多 5 個存檔欄位；寫入頻率限制。
- **Storage 政策**：只能存取 `player-photos/<自己的玩家編號>/` 底下、檔名符合 `角色-16位雜湊.jpg|png|webp` 的檔案；單層資料夾、每位玩家最多 24 張、單檔 1 MB、只收圖片。

### ⚠️ RLS 的限制：玩家仍然可以修改「自己的」遊戲數值

RLS 只能保證**資料所有權**（你不能碰別人的資料），**不能保證你寫進自己存檔的數值是合法的**。匿名玩家本來就擁有寫入自己存檔的權限，懂技術的人可以用瀏覽器開發者工具或自己發送 API 請求，把自己的等級、經驗、好感度改成任意值；伺服器目前只檢查格式、大小與上述規則，不會重新計算遊戲規則。對單人養成遊戲來說影響有限（只影響自己），但如果之後要做排行榜、獎勵或多人比較，就需要伺服器端驗證。

### 建議做法：用 Edge Functions 驗證重要遊戲事件（本版尚未實作）

1. **只讓伺服器寫入重要數值**：把 `game_saves` 的直接寫入權限（`update_game_save` 等）改為只給 service role；前端改呼叫 Edge Function（例如 `submit-day`），只送「玩家的輸入」——當天每堂課的回報、睡眠／起床、互動選擇——而不是送算好的數值。
2. **伺服器重算**：Edge Function 載入與前端相同的遊戲規則（`game.js` 的 `computeDay`／`settleDay` 是純計算，可以抽成共用模組），用伺服器上的存檔與伺服器產生的亂數種子重新計算經驗、好感度、道具與成就，再寫入資料庫並回傳結果。
3. **合理性檢查**：日期只能依序前進、不能是未來日期、每天可得經驗與好感度有上限、技能點不能超過等級可得數量；異常寫入記錄到稽核表。
4. **存檔簽章**：伺服器回傳的狀態附上 HMAC 簽章，下次寫入時驗證，避免客戶端改過的狀態被接受。
5. 排行榜等公開資料只從伺服器計算的欄位產生。

---

## 8. 防濫用設計

| 項目 | 做法 |
|---|---|
| 匿名帳號大量建立 | Supabase 內建：匿名登入每 IP 每小時 30 次（Authentication → Rate Limits 可調）；建議之後加 CAPTCHA（見尚未完成） |
| 存檔寫入洗流量 | 每位玩家 10 分鐘最多 300 次寫入（超過回傳 `rate_limited`，前端稍後重試）；前端本身 debounce 合併 |
| 資料膨脹 | 存檔 ≤ 3 MB、每位玩家 ≤ 5 個存檔欄位、備份每份存檔 40 份、回憶每份存檔 ≤ 20000 筆、照片每人 ≤ 24 張且單張 ≤ 1 MB |
| 猜復原代碼 | 100 bits 隨機、只存雜湊、每身分每小時 5 次錯誤、每 IP 每小時 20 次錯誤、有效期限、一次性 |
| 復原代碼濫發 | 每位玩家每天最多 10 組，新代碼產生時舊的作廢 |
| 長期沒用的匿名帳號 | `mb_cleanup_stale_anonymous(天數)`：刪除超過 N 天沒有使用、且沒有已開始存檔的匿名帳號（只有資料庫管理者能執行；可在 SQL Editor 手動執行，或用 pg_cron 排程，例如 `select public.mb_cleanup_stale_anonymous(90);`） |

---

## 9. 測試清單與結果

測試環境：Linux、Chromium（Playwright）、PostgreSQL 16、Node.js 22。最後一次完整執行（`bash tests/run-all.sh`，含與 v1.1 單檔版的比對）：2026-11-11，全部通過。
**雲端相關測試使用「本機 Supabase 模擬器」**：資料庫是真的 PostgreSQL，直接執行本專案的 `schema.sql`、`policies.sql`（RLS、GRANT、觸發器、RPC 都是真的），HTTP 層（Auth／PostgREST／Storage／Functions）由 `tests/emulator/server.mjs` 模擬；前端用的是真正的 supabase-js 2.119.0；Edge Function 的邏輯（`handler.ts`）直接在模擬器裡執行。
本節是本機模擬器的結果；**部署到真正的 Supabase 專案與 GitHub Pages 之後的線上實測結果見 [`DEPLOYMENT.md`](DEPLOYMENT.md)**。

### 需求的 17 項測試

| # | 需求 | 對應測試 | 結果 |
|---|---|---|---|
| 1 | 新玩家第一次進入 | `cloud.py` t01 | 通過（16/16 項檢查） |
| 2 | 匿名身分建立 | `cloud.py` t01、`edge` 測試 | 通過（16/16 項檢查） |
| 3 | 初始存檔建立 | `cloud.py` t01 | 通過（16/16 項檢查） |
| 4 | 雲端讀取 | `cloud.py` t02、t10、t11 | 通過（7/7 項檢查） |
| 5 | 角色升級存檔 | `cloud.py` t03 | 通過（13/13 項檢查） |
| 6 | 好感度變化存檔 | `cloud.py` t03 | 通過（13/13 項檢查） |
| 7 | 道具與貨幣存檔 | `cloud.py` t03 | 通過（13/13 項檢查） |
| 8 | 任務與成就存檔 | `cloud.py` t03 | 通過（13/13 項檢查） |
| 9 | 對話及回憶存檔 | `cloud.py` t03、`sql-tests` | 通過（13/13 項檢查） |
| 10 | 角色外觀與照片存檔 | `cloud.py` t04、`sql-tests`（Storage 政策） | 通過（16/16 項檢查） |
| 11 | 關閉瀏覽器後重新開啟 | `cloud.py` t05 | 通過（6/6 項檢查） |
| 12 | 網路中斷及恢復 | `cloud.py` t06 | 通過（23/23 項檢查） |
| 13 | 舊版 localStorage 遷移 | `cloud.py` t07 | 通過（26/26 項檢查） |
| 14 | JSON 匯入及匯出 | `cloud.py` t08、`equivalence.py` | 通過（9/9 項檢查） |
| 15 | 不同瀏覽器的匿名身分隔離 | `cloud.py` t09 | 通過（18/18 項檢查） |
| 16 | RLS 權限測試 | `cloud.py` t09、`sql-tests`、`edge` 測試 | 通過（18/18 項檢查） |
| 17 | 存檔版本衝突測試 | `cloud.py` t10、`sql-tests` | 通過（12/12 項檢查） |

### 全部測試套件

| 測試套件 | 內容 | 結果 |
|---|---|---|
| `tests/sql/sql-tests.mjs` | 直接在 PostgreSQL 以 anon／authenticated／service_role 身分驗證 RLS、GRANT、觸發器、RPC、Storage 政策、復原代碼、速率與數量限制 | 通過（83/83 項檢查） |
| `tests/edge/recover-save.test.mjs` | 透過模擬器與真正的 supabase-js：匿名登入、RLS 隔離、Storage、復原代碼、CORS、權杖更新與撤銷 | 通過（33/33 項檢查） |
| `tests/e2e/legacy/`（v1.1 原有回歸測試，對模組版執行） | `sim.py` 4 種玩法跑完整學期；`play.py` 以滑鼠玩完整學期；`extra.py` 補救、勳章、設定、照片、匯出入、手機版；`v11.py` 卡通頭像、兄妹分頁、同步早八、舊存檔升級 | 通過（sim 4 種玩法無錯誤、play 整學期無錯誤、extra 27/27、v11 41/41） |
| `tests/e2e/equivalence.py` | 與 v1.1 單檔版逐字比對（狀態、彈窗、8 個分頁畫面、匯出 JSON、雙向匯入） | 通過（26/26 項檢查） |
| `tests/e2e/cloud.py` | 雲端端對端測試 t01～t17（真的 Chromium） | 通過（200/200 項檢查） |

雲端端對端測試中，需求清單以外的情境：t11 復原代碼 通過（16/16 項檢查）、t12 多分頁 通過（5/5 項檢查）、t13 Session 遺失 通過（7/7 項檢查）、t14 備份還原與刪除 通過（9/9 項檢查）、t15 較新版本保護 通過（3/3 項檢查）、t16 金鑰安全 通過（8/8 項檢查）、t17 debounce／定時同步 通過（6/6 項檢查）。

### 測試涵蓋的重點情境

- 新裝置：匿名身分自動建立、沒有登入畫面、未開始前不上傳空白存檔、開始後建立存檔、雲端內容與本機 S 逐欄位相同、所有請求只帶 Publishable key。
- 進度：連續玩 8 天後，等級、技能、好感度、道具、經驗、技能點、成就、任務、每日紀錄、紀念冊、妹妹訊息、日誌、收藏全部與雲端一致；回憶表每一筆都有。
- 照片：上傳到玩家專屬路徑、雲端只存路徑、清掉快取後從 Storage 下載顯示、匯出含照片且可匯入 v1.1、換照片時被備份引用的舊照片保留、備份輪替後才刪除、上傳失敗時以 data URL 保留並自動補傳。
- 重新開啟：關閉整個瀏覽器再開，身分、進度相同；權杖過期自動更新。
- 網路：離線遊玩與恢復、503 自動重試、伺服器已寫入但回報失敗（以同一操作編號重送、不重複套用）、連線中斷、送出後立即重新整理（不會誤判衝突）、寫入請求不重疊、visibilitychange／pagehide 立即補存、關閉前沒送出的進度下次補傳、開機連不上雲端仍可遊玩。
- 遷移：成功、失敗重試、部分成功（兩種）、上傳中關閉頁面、重複開啟不重複遷移、v1 存檔先升級再上傳、照片搬家、舊存檔不刪除、空白存檔不覆蓋雲端（前端與伺服器兩層）。
- JSON：檔名與格式相同、v1.1 匯出 → 雲端版匯入、雲端版匯出 → v1.1 匯入內容相同、匯入前雲端與本機都有備份、格式錯誤不匯入。
- 隔離與 RLS：透過真正的 supabase-js 嘗試讀／改／刪／新增別人的存檔、讀別人的備份與回憶、讀復原代碼表、呼叫 service role 函式、下載／上傳／刪除別人的照片、未登入讀取，全部被擋。
- 衝突：自動採用他裝置進度、兩邊都改時顯示選擇（保留這台／使用雲端）、兩份都留備份、舊版本號寫入被拒絕。
- 其他：復原代碼（格式、只存雜湊、不是 UUID、錯誤代碼、大小寫空格、一次性、過期、裝置已有進度時確認）、多分頁鎖與接手、Session 遺失與 refresh token 失效（建立新身分但不遺失進度，可用復原代碼接回）、重新開始前備份與從備份還原、刪除雲端存檔後停用同步與重新開啟、較新版本保護、Secret key 防呆、debounce 合併、定時同步、最後成功時間。
- 原遊戲：v1.1 的 4 套回歸測試在模組版照跑；等價測試（4 種玩法整學期模擬＋19 天實際操作）結果與單檔版逐字相同。

---

## 10. 本機預覽與執行測試

**只想在電腦上玩／預覽**（任何有 Python 的電腦）：

```bash
cd Morning-Bond
python3 -m http.server 8080
# 瀏覽器打開 http://localhost:8080/
```

**執行測試**（需要 Node.js 22 以上、Python 3、PostgreSQL 16、Google Chrome 或 Chromium）：見 [`tests/README.md`](tests/README.md)。

---

## 11. 尚未完成／尚未驗證的項目

- **線上實測（2026-11-11）已完成的部分**：真正的 Supabase 專案＋GitHub Pages 上的匿名登入、存檔建立／更新／重新整理還原、復原代碼（Edge Function 在 Supabase 上執行）、RLS、Storage 權限、CORS、刪除雲端存檔，詳見 [`DEPLOYMENT.md`](DEPLOYMENT.md)。
- **線上尚未實測**：遊戲內「上傳照片」介面（Storage 權限已用 API 實測）、真正的斷網與恢復、用實體的第二台裝置（手機）接回存檔（線上是用第二個匿名身分模擬另一台裝置）。
- **只測試 Chromium 系瀏覽器**；Safari、Firefox、手機瀏覽器沒有自動化測試（多分頁鎖使用 Web Locks，不支援的瀏覽器會退回「不鎖定」）。
- **CAPTCHA 尚未整合**：Supabase 若開啟 CAPTCHA，匿名登入會失敗。
- **伺服器端遊戲規則驗證尚未實作**：只有第 7 節的提案。
- **裝置管理介面尚未實作**：雲端面板只顯示連結了幾台裝置，還不能從介面移除某一台裝置。
- 遺失 Session 又沒有復原代碼時，舊的雲端存檔仍在資料庫裡，但玩家自己無法再接回（需要資料庫管理者協助）；本機進度不受影響，會上傳到新的雲端存檔。
- 舊版用 `file://` 開啟的存檔無法自動遷移（瀏覽器限制），需要手動匯出／匯入（第 5 節）。

---

## 12. 維護

- **更新 supabase-js**：`cd tools/vendor && npm install && npm run build`（先修改 `package.json` 的版本）→ 把 `js/supabase.js` 的 `LIB_URL` 改成新檔名 → 刪除舊檔 → 跑一次測試。
- **修改資料庫**：直接修改 `schema.sql`／`policies.sql` 後重新執行（兩個檔案都可以重複執行）。
- **清理舊匿名帳號**：`select public.mb_cleanup_stale_anonymous(90);`（SQL Editor，管理者身分）。
- **Supabase Free 方案會在約 7 天沒有活動後自動暫停專案**：暫停期間遊戲照常在本機遊玩、進度先存在瀏覽器；到 Supabase 後台按 **Resume project** 恢復後，會自動補傳。
- **除錯**：瀏覽器主控台輸入 `__cloud` 可看同步狀態（`__cloud.status`、`__cloud.meta`）；`__cg.state` 是遊戲狀態。
