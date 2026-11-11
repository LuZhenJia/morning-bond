// =====================================================================
//  recover-save：存檔復原代碼（Supabase Edge Function 的處理邏輯）
//  - 不依賴 Deno 專屬 API，只用 Web 標準（Request/Response/crypto.subtle），
//    因此同一份程式可以在 Supabase Edge Runtime（Deno）與本機 Node 測試中執行。
//  - 復原代碼：20 碼 Crockford Base32（100 bits 安全隨機），資料庫只存 HMAC-SHA256 雜湊。
//  - 驗證、加入裝置、一次性使用與速率限制都在資料庫函式內以交易完成（recovery_* 系列）。
//
//  前端呼叫方式：supabase.functions.invoke('recover-save', { body: { action, code?, force? } })
//    action = 'create'  產生新代碼（舊代碼自動作廢），回傳 { code, expires_at }
//    action = 'redeem'  在新裝置輸入代碼，把這個匿名身分連結到原本的玩家
//    action = 'status'  查詢目前是否有有效代碼、已連結幾台裝置
//    action = 'revoke'  作廢目前的代碼
// =====================================================================

export interface RpcResult {
  data: any;
  error: { message?: string } | null;
}

export interface AdminClient {
  auth: { getUser(jwt: string): Promise<{ data: { user: { id: string } | null }; error: unknown }> };
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<RpcResult>;
}

export interface RecoveryDeps {
  admin: AdminClient;
  pepper: string;
  ttlHours: number;
  allowedOrigins: string[];
}

// Crockford Base32（去掉容易混淆的 I、L、O、U）
export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 20;

export function generateCode(): string {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b & 31];
  return out;
}

export function formatCode(code: string): string {
  return (code.match(/.{1,4}/g) || []).join('-');
}

// 使用者輸入的代碼 → 標準化（大小寫、空白、破折號、O→0、I/L→1）；格式不符回傳 null
export function normalizeCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const s = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  if (s.length !== CODE_LENGTH) return null;
  for (const ch of s) if (!CODE_ALPHABET.includes(ch)) return null;
  return s;
}

export async function hmacHex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function corsHeaders(origin: string, allowed: string[]): Record<string, string> {
  const any = allowed.length === 0 || allowed.includes('*');
  const allowOrigin = any ? '*' : (allowed.includes(origin) ? origin : allowed[0]);
  const h: Record<string, string> = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
  if (!any) h['Vary'] = 'Origin';
  return h;
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function clientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for') || '';
  return (xff.split(',')[0] || req.headers.get('cf-connecting-ip') || req.headers.get('x-real-ip') || '').trim();
}

const STATUS: Record<string, number> = {
  rate_limited: 429, has_own_progress: 409, no_player: 409,
  invalid_code: 400, code_used: 400, code_revoked: 400, code_expired: 400, invalid_format: 400,
};

export async function handleRequest(req: Request, deps: RecoveryDeps): Promise<Response> {
  const cors = corsHeaders(req.headers.get('origin') || '', deps.allowedOrigins);
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ ok: false, error: 'method_not_allowed' }, 405, cors);
  if (!deps.pepper || deps.pepper.length < 32) return json({ ok: false, error: 'server_misconfigured' }, 500, cors);

  // 只接受「使用者的存取權杖（JWT）」，不接受 API key
  const m = (req.headers.get('authorization') || '').match(/^Bearer\s+(\S+)$/i);
  const token = m ? m[1] : '';
  if (!token || token.startsWith('sb_') || token.split('.').length !== 3) {
    return json({ ok: false, error: 'not_authenticated' }, 401, cors);
  }
  let userId = '';
  try {
    const { data, error } = await deps.admin.auth.getUser(token);
    if (error || !data || !data.user) return json({ ok: false, error: 'not_authenticated' }, 401, cors);
    userId = data.user.id;
  } catch (_e) {
    return json({ ok: false, error: 'auth_unavailable' }, 503, cors);
  }

  let body: any = null;
  try { body = await req.json(); } catch (_e) { return json({ ok: false, error: 'invalid_json' }, 400, cors); }
  const action = body && typeof body.action === 'string' ? body.action : '';

  const call = async (fn: string, args: Record<string, unknown>) => {
    const r = await deps.admin.rpc(fn, args);
    if (r.error) throw new Error(r.error.message || 'rpc_failed');
    return r.data || {};
  };

  try {
    if (action === 'create') {
      const code = generateCode();
      const hash = await hmacHex(deps.pepper, 'code:' + code);
      const ttl = Number.isFinite(deps.ttlHours) && deps.ttlHours > 0 ? Math.min(Math.floor(deps.ttlHours), 720) : 168;
      const d = await call('recovery_issue', { p_user_id: userId, p_code_hash: hash, p_ttl_hours: ttl });
      if (!d.ok) return json({ ok: false, error: d.error || 'failed' }, STATUS[d.error] || 400, cors);
      return json({ ok: true, code: formatCode(code), expires_at: d.expires_at }, 200, cors);
    }
    if (action === 'redeem') {
      const code = normalizeCode(body.code);
      const ip = clientIp(req);
      const ipHash = ip ? await hmacHex(deps.pepper, 'ip:' + ip) : null;
      // 格式不符也照樣走資料庫，讓失敗次數一起計入速率限制
      const hash = await hmacHex(deps.pepper, code ? 'code:' + code : 'invalid:' + String(body.code || '').slice(0, 64));
      const d = await call('recovery_redeem', { p_user_id: userId, p_code_hash: hash, p_ip_hash: ipHash, p_force: body.force === true });
      if (!d.ok) {
        const err = !code && d.error === 'invalid_code' ? 'invalid_format' : d.error;
        return json({ ok: false, error: err || 'failed' }, STATUS[err] || 400, cors);
      }
      return json({ ok: true, player_id: d.player_id, already_member: !!d.already_member }, 200, cors);
    }
    if (action === 'status') {
      const d = await call('recovery_status', { p_user_id: userId });
      return json({ ok: true, active: !!(d && d.active), expires_at: (d && d.expires_at) || null, devices: (d && d.devices) || 0 }, 200, cors);
    }
    if (action === 'revoke') {
      const d = await call('recovery_revoke', { p_user_id: userId });
      return json({ ok: true, revoked: d.revoked || 0 }, 200, cors);
    }
    return json({ ok: false, error: 'unknown_action' }, 400, cors);
  } catch (_e) {
    return json({ ok: false, error: 'server_error' }, 500, cors);
  }
}
