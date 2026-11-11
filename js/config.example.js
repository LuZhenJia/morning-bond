// =====================================================================
//  config.example.js — 設定範本（遊戲實際讀取的是 config.js；這個檔案不會被載入，也不會發布到網站）
//  * supabaseUrl：Supabase Dashboard → Project Settings → Data API → Project URL
//  * supabasePublishableKey：Project Settings → API Keys → Publishable key（sb_publishable_ 開頭）
//    這兩個值本來就是公開的（會出現在瀏覽器裡），資料安全由資料庫的 RLS 保護。
//  ⚠️ 絕對不要填 Secret key（sb_secret_…）或 service_role key；遊戲偵測到會自動停用雲端功能。
//  兩個欄位留空 → 遊戲以「本機模式」執行（與單檔版相同，只存在瀏覽器）。
// =====================================================================
export const CONFIG = Object.freeze({
  supabaseUrl: '',
  supabasePublishableKey: '',

  // 以下通常不需要修改
  photoBucket: 'player-photos',      // policies.sql 建立的私有 bucket
  recoveryFunction: 'recover-save',  // Edge Function 名稱
  autosaveDebounceMs: 2500,          // 連續操作停止多久後上傳
  autosaveMaxWaitMs: 15000,          // 連續操作時，最久多久一定上傳一次
  syncIntervalMs: 45000,             // 背景同步／檢查其他裝置進度的間隔（30～60 秒）
  bootGateTimeoutMs: 8000,           // 新裝置開啟時，最多等雲端多久
});
