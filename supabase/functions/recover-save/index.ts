// =====================================================================
//  Supabase Edge Function 入口：recover-save
//  部署：supabase functions deploy recover-save --no-verify-jwt
//    （本函式會自行用 auth.getUser() 驗證使用者權杖；新版 API key / JWT 簽章金鑰
//      不支援平台內建的 verify_jwt，因此關閉它並在程式內驗證，參見 Supabase 文件）
//  必要的 Secrets（supabase secrets set ...）：
//    RECOVERY_CODE_PEPPER   至少 32 字元的隨機字串（只放在伺服器，用來計算 HMAC）
//  選用的 Secrets：
//    RECOVERY_CODE_TTL_HOURS  代碼有效時數（預設 168 = 7 天，上限 720）
//    ALLOWED_ORIGINS          允許的網站來源，逗號分隔，例如 https://你的帳號.github.io
//  平台自動提供：SUPABASE_URL、SUPABASE_SECRET_KEYS（或舊版 SUPABASE_SERVICE_ROLE_KEY）
// =====================================================================
import { createClient } from 'npm:@supabase/supabase-js@2.119.0';
import { handleRequest } from './handler.ts';

function secretKey(): string {
  const keys = Deno.env.get('SUPABASE_SECRET_KEYS');
  if (keys) {
    try {
      const parsed = JSON.parse(keys) as Record<string, string>;
      if (parsed.default) return parsed.default;
      const first = Object.values(parsed)[0];
      if (first) return first;
    } catch (_e) { /* 改用舊版金鑰 */ }
  }
  const legacy = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  throw new Error('Missing SUPABASE_SECRET_KEYS / SUPABASE_SERVICE_ROLE_KEY');
}

const admin = createClient(Deno.env.get('SUPABASE_URL') ?? '', secretKey(), {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

Deno.serve((req: Request) => handleRequest(req, {
  admin,
  pepper: Deno.env.get('RECOVERY_CODE_PEPPER') ?? '',
  ttlHours: Number(Deno.env.get('RECOVERY_CODE_TTL_HOURS') ?? '168'),
  allowedOrigins: (Deno.env.get('ALLOWED_ORIGINS') ?? '*').split(',').map((s) => s.trim()).filter(Boolean),
}));
