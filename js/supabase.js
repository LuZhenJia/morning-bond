// =====================================================================
//  supabase.js — Supabase 用戶端、匿名身分與錯誤分類
//  前端只使用 Project URL 與 Publishable key（可公開）；偵測到 Secret / service_role key 會拒絕啟動。
// =====================================================================
import { KEYS } from './storage.js';

// supabase-js 只在雲端模式才載入：本機模式完全不執行它（它載入時會測試 localStorage、呼叫亂數），
// 讓沒有設定雲端時的遊戲行為與單檔版逐字相同，也省下 200 多 KB 的載入時間。
const LIB_URL = './vendor/supabase-js-2.119.0.js';
let libPromise = null;
let LIB = null;
export function loadSupabaseLib() {
  if (!libPromise) {
    libPromise = import(LIB_URL)
      .then((m) => { LIB = m; return m; })
      .catch((e) => { libPromise = null; throw new CloudError('network', `無法載入 Supabase 程式庫（${(e && e.message) || e}）`); });
  }
  return libPromise;
}

export class CloudError extends Error {
  // kind：network（網路／暫時性）、server（5xx）、rate（太頻繁）、auth（身分失效）、
  //       validation（資料被拒）、config（後端設定不完整）、denied（權限不足）、unknown
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'CloudError';
    this.kind = kind;
    Object.assign(this, extra);
  }
  get retryable() { return ['network', 'server', 'rate', 'unknown'].includes(this.kind); }
}

const NETWORK_RE = /failed to fetch|fetch failed|networkerror|network request failed|load failed|err_|econn|etimedout|timeout|aborted/i;

function decodeJwtPayload(token) {
  try {
    const part = String(token).split('.')[1];
    return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/')));
  } catch (e) { return null; }
}

// 回傳設定問題（null 代表可以啟用雲端）
export function cloudConfigProblem(cfg) {
  const url = String(cfg.supabaseUrl || '').trim();
  const key = String(cfg.supabasePublishableKey || '').trim();
  if (!url || !key) return 'not-configured';
  if (!/^https:\/\/[^/\s]+$/.test(url.replace(/\/$/, '')) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(url)) return 'bad-url';
  if (/^sb_secret_/.test(key)) return 'secret-key';
  const p = key.split('.').length === 3 ? decodeJwtPayload(key) : null;
  if (p && p.role && p.role !== 'anon') return 'secret-key';
  if (typeof window !== 'undefined' && window.isSecureContext === false) return 'insecure-context';
  if (typeof crypto === 'undefined' || !crypto.subtle || !crypto.randomUUID) return 'insecure-context';
  return null;
}

export const PROBLEM_TEXT = {
  'not-configured': '尚未設定 Supabase（js/config.js），目前是本機模式。',
  'bad-url': 'Supabase Project URL 格式不正確，請檢查 js/config.js。',
  'secret-key': '偵測到 Secret / service_role 金鑰！前端只能放 Publishable key，雲端功能已停用以保護資料。',
  'insecure-context': '雲端存檔需要 https（或 localhost）才能使用，目前是本機模式。',
};

export function classifyPostgrest(result) {
  const err = result.error || {};
  const status = Number(result.status) || 0;
  const msg = String(err.message || err.details || 'request failed');
  if (!status || NETWORK_RE.test(msg)) return new CloudError('network', msg, { status });
  if (/rate_limited/.test(msg) || status === 429) return new CloudError('rate', msg, { status });
  if (status === 401 || /JWT|jwt|PGRST30/.test(String(err.code) + msg)) return new CloudError('auth', msg, { status, code: err.code });
  if (status >= 500) return new CloudError('server', msg, { status, code: err.code });
  if (err.code === 'PGRST202' || err.code === 'PGRST205' || status === 404) return new CloudError('config', msg, { status, code: err.code });
  if (/permission denied|row-level security/.test(msg)) return new CloudError('denied', msg, { status, code: err.code });
  if (/refuse_blank_overwrite|version_downgrade|invalid_state|state_too_large|too_many_saves|immutable_columns|no_player|check constraint/.test(msg)) {
    return new CloudError('validation', msg, { status, code: err.code });
  }
  return new CloudError('unknown', msg, { status, code: err.code });
}

export function classifyAuthError(error) {
  const msg = String((error && error.message) || 'auth failed');
  if (!error) return new CloudError('unknown', msg);
  if ((LIB && LIB.isAuthRetryableFetchError(error)) || NETWORK_RE.test(msg)) return new CloudError('network', msg, { status: error.status || 0 });
  const status = Number(error.status) || 0;
  const code = error.code || '';
  if (status === 429 || /rate limit/i.test(msg)) return new CloudError('rate', msg, { status, code });
  if (/anonymous.*disabled|provider.*disabled|signups not allowed/i.test(msg + code)) return new CloudError('config', '這個 Supabase 專案尚未開啟匿名登入（Anonymous sign-ins）。', { status, code });
  if (/captcha/i.test(msg + code)) return new CloudError('config', '這個 Supabase 專案要求 CAPTCHA，但遊戲目前沒有接 CAPTCHA。', { status, code });
  if (status >= 500) return new CloudError('server', msg, { status, code });
  return new CloudError('auth', msg, { status, code });
}

// ---------------------------------------------------------------------
//  匿名身分
// ---------------------------------------------------------------------
export class CloudAuth {
  // 先載入 supabase-js 再建立用戶端（載入失敗會丟出 network 錯誤，由存檔管理器稍後重試）
  static async create(cfg) {
    const lib = await loadSupabaseLib();
    return new CloudAuth(cfg, lib);
  }

  constructor(cfg, lib) {
    this.cfg = cfg;
    this.lib = lib;
    this.listeners = new Set();
    this.client = lib.createClient(cfg.supabaseUrl.replace(/\/$/, ''), cfg.supabasePublishableKey, {
      auth: {
        persistSession: true,      // Session 存在 localStorage，下次開啟沿用同一個匿名玩家
        autoRefreshToken: true,    // 權杖快過期時自動更新
        detectSessionInUrl: false,
        storageKey: KEYS.auth,
      },
      global: { headers: { 'x-client-info': 'morning-bond/2.0.0' } },
    });
    this.client.auth.onAuthStateChange((event, session) => {
      for (const fn of this.listeners) {
        try { fn(event, session); } catch (e) { console.warn('[auth] listener failed', e); }
      }
    });
  }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  async currentSession() {
    const { data, error } = await this.client.auth.getSession();
    if (error) throw classifyAuthError(error);
    return data.session || null;
  }

  // 沒有 Session 時自動建立匿名玩家；不顯示任何登入介面
  async ensureSession() {
    let session = null;
    try {
      session = await this.currentSession();
    } catch (e) {
      if (e.kind === 'network' || e.kind === 'server' || e.kind === 'rate') throw e;
      session = null; // refresh token 已失效 → 改建新的匿名身分
    }
    if (session && session.user) return { session, created: false };
    const { data, error } = await this.client.auth.signInAnonymously();
    if (error) throw classifyAuthError(error);
    if (!data || !data.session) throw new CloudError('auth', '匿名登入沒有取得 Session');
    return { session: data.session, created: true };
  }

  async refresh() {
    const { data, error } = await this.client.auth.refreshSession();
    if (error) throw classifyAuthError(error);
    return data.session;
  }
}
