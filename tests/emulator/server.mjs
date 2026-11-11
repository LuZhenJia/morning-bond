// =====================================================================
//  Supabase 本機模擬器（只用於測試，不要部署）
//  以真正的 PostgreSQL 執行 schema.sql / policies.sql，並模擬前端會呼叫的 HTTP API：
//    /auth/v1      匿名登入、refresh token 輪替、取得使用者（HS256 JWT）
//    /rest/v1      PostgREST 子集：RPC（具名參數）與資料表 GET/POST/PATCH/DELETE（eq 篩選）
//                  每個請求都以 JWT 內的角色（anon / authenticated / service_role）＋ claims 執行，
//                  權限完全交給 PostgreSQL 的 GRANT 與 RLS 判斷（與 PostgREST 相同的做法）
//    /storage/v1   上傳／下載／刪除，同樣以使用者身分寫入 storage.objects，讓 Storage RLS 決定
//    /functions/v1/recover-save   直接執行 supabase/functions/recover-save/handler.ts
//    /__emu/*      測試控制：重設、注入錯誤（error / drop / drop-after / error-after / delay）、撤銷 session、查詢資料庫
//  啟動：node --experimental-strip-types tests/emulator/server.mjs
// =====================================================================
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { createClient } from '@supabase/supabase-js';
import { signJWT, verifyJWT } from './jwt.mjs';
import { handleRequest as recoverSave } from '../../supabase/functions/recover-save/handler.ts';

const CFG = {
  port: Number(process.env.EMU_PORT || 54321),
  pgPort: Number(process.env.PG_PORT || 54329),
  db: process.env.PG_DB || 'mb',
  jwtSecret: process.env.EMU_JWT_SECRET || 'emulator-jwt-secret-at-least-32-characters-long',
  publishableKey: process.env.EMU_PUBLISHABLE_KEY || 'sb_publishable_emulator_000000000000000000',
  secretKey: process.env.EMU_SECRET_KEY || 'sb_secret_emulator_00000000000000000000000',
  accessTtl: Number(process.env.EMU_ACCESS_TTL || 3600),
  storageDir: process.env.EMU_STORAGE_DIR || '/tmp/mb-emu-storage',
  pepper: process.env.RECOVERY_CODE_PEPPER || 'emulator-pepper-0123456789abcdef0123456789abcdef',
  ttlHours: Number(process.env.RECOVERY_CODE_TTL_HOURS || 168),
  allowedOrigins: (process.env.ALLOWED_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
  anonEnabled: true,
  anonRateLimit: Number(process.env.EMU_ANON_RATE || 1000),
};
const BASE = `http://127.0.0.1:${CFG.port}`;
const pool = new pg.Pool({ host: '/tmp', port: CFG.pgPort, user: 'postgres', database: CFG.db, max: 12 });
const ROLES = new Set(['anon', 'authenticated', 'service_role']);
const TABLES = new Set(['players', 'player_members', 'game_saves', 'save_snapshots', 'memories', 'recovery_codes', 'recovery_attempts', 'membership_changes']);

let failRules = [];
const anonHits = new Map();
const reqLog = [];

// ---------------------------------------------------------------------
//  小工具
// ---------------------------------------------------------------------
function cors(extra = {}) {
  return { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Content-Type', ...extra };
}
function send(res, status, body, headers = {}) {
  if (res.writableEnded) return;
  if (res.__dropAfter) { res.socket && res.socket.destroy(); return; }
  if (res.__errorAfter) {
    // 已經處理（寫入資料庫），但回傳錯誤：模擬「伺服器其實成功、用戶端以為失敗」
    const st = res.__errorAfter;
    res.__errorAfter = 0;
    res.writeHead(st, cors({ 'Content-Type': 'application/json; charset=utf-8' }));
    res.end(JSON.stringify({ message: 'injected failure after commit', code: 'EMU_INJECTED' }));
    return;
  }
  if (status === 204) { res.writeHead(204, cors(headers)); res.end(); return; }
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, cors({ 'Content-Type': 'application/json; charset=utf-8', ...headers }));
  res.end(text);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const parseJSON = (buf) => { if (!buf || !buf.length) return {}; try { return JSON.parse(buf.toString('utf8')); } catch (e) { return null; } };
const bearer = (req) => { const m = String(req.headers.authorization || '').match(/^Bearer\s+(\S+)$/i); return m ? m[1] : ''; };
const keyOK = (req) => req.headers.apikey === CFG.publishableKey || req.headers.apikey === CFG.secretKey;

function pgStatus(e, role) {
  const c = e.code || '';
  if (c === '42501') return role === 'anon' ? 401 : 403;
  if (c === '23505' || c === '23503') return 409;
  if (c.startsWith('22') || c.startsWith('23') || c.startsWith('P0') || c === '54000' || c === '42883') return 400;
  return 500;
}
function sendPgError(res, e, role) {
  send(res, pgStatus(e, role), { code: e.code || 'XX000', message: e.message, details: e.detail || null, hint: e.hint || null });
}

// 以 JWT 判斷 PostgREST 角色
function restAuth(req) {
  if (!keyOK(req)) return { error: [401, { message: 'Invalid API key', hint: 'Double check your Supabase `anon` or `service_role` API key.' }] };
  const token = bearer(req);
  if (!token || token === CFG.publishableKey) return req.headers.apikey === CFG.secretKey ? { role: 'service_role', claims: { role: 'service_role' } } : { role: 'anon', claims: { role: 'anon' } };
  if (token === CFG.secretKey) return { role: 'service_role', claims: { role: 'service_role' } };
  const v = verifyJWT(token, CFG.jwtSecret);
  if (!v.ok) {
    return { error: [401, v.error === 'expired'
      ? { code: 'PGRST303', message: 'JWT expired', details: null, hint: null }
      : { code: 'PGRST301', message: 'JWSError JWSInvalidSignature', details: null, hint: null }] };
  }
  const role = v.payload.role;
  if (!ROLES.has(role)) return { error: [401, { code: 'PGRST301', message: 'invalid role' }] };
  return { role, claims: v.payload };
}

async function withRole(role, claims, fn) {
  if (!ROLES.has(role)) throw new Error('bad role');
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${role}`);
    await c.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true), set_config('request.jwt.claim.role', $3, true)",
      [JSON.stringify(claims || {}), (claims && claims.sub) || '', role]);
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally { c.release(); }
}

// ---------------------------------------------------------------------
//  Auth
// ---------------------------------------------------------------------
function userJson(u) {
  return {
    id: u.id, aud: 'authenticated', role: 'authenticated', email: '', phone: '',
    app_metadata: { provider: 'anonymous', providers: ['anonymous'] }, user_metadata: {}, identities: [],
    created_at: new Date(u.created_at).toISOString(), updated_at: new Date(u.updated_at || u.created_at).toISOString(),
    last_sign_in_at: u.last_sign_in_at ? new Date(u.last_sign_in_at).toISOString() : null, is_anonymous: !!u.is_anonymous,
  };
}
async function issueSession(userId, sessionId = crypto.randomUUID()) {
  const u = (await pool.query('select * from auth.users where id = $1', [userId])).rows[0];
  const now = Math.floor(Date.now() / 1000);
  const exp = now + CFG.accessTtl;
  const access_token = signJWT({
    aud: 'authenticated', exp, iat: now, iss: `${BASE}/auth/v1`, sub: userId, email: '', phone: '',
    app_metadata: { provider: 'anonymous', providers: ['anonymous'] }, user_metadata: {}, role: 'authenticated',
    aal: 'aal1', amr: [{ method: 'anonymous', timestamp: now }], session_id: sessionId, is_anonymous: true,
  }, CFG.jwtSecret);
  const refresh_token = crypto.randomBytes(18).toString('base64url');
  await pool.query('insert into auth.emu_refresh_tokens (token, user_id, session_id) values ($1, $2, $3)', [refresh_token, userId, sessionId]);
  return { access_token, token_type: 'bearer', expires_in: CFG.accessTtl, expires_at: exp, refresh_token, user: userJson(u) };
}
const authErr = (res, status, error_code, msg) => send(res, status, { code: status, error_code, msg, error: error_code, error_description: msg });

async function handleAuth(req, res, sub, url, buf) {
  if (!keyOK(req)) return send(res, 401, { message: 'Invalid API key' });
  const body = parseJSON(buf) || {};
  if (sub === 'signup' && req.method === 'POST') {
    if (body.email || body.phone || body.password) return authErr(res, 422, 'email_provider_disabled', 'Email signups are disabled');
    if (!CFG.anonEnabled) return authErr(res, 422, 'anonymous_provider_disabled', 'Anonymous sign-ins are disabled');
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '');
    const hits = (anonHits.get(ip) || []).filter((t) => t > Date.now() - 3600_000);
    if (hits.length >= CFG.anonRateLimit) return authErr(res, 429, 'over_request_rate_limit', 'Request rate limit reached');
    hits.push(Date.now()); anonHits.set(ip, hits);
    const id = crypto.randomUUID();
    await pool.query("insert into auth.users (id, aud, role, is_anonymous, created_at, updated_at, last_sign_in_at) values ($1, 'authenticated', 'authenticated', true, now(), now(), now())", [id]);
    return send(res, 200, await issueSession(id));
  }
  if (sub === 'token' && req.method === 'POST') {
    if (url.searchParams.get('grant_type') !== 'refresh_token') return authErr(res, 400, 'unsupported_grant_type', 'unsupported grant type');
    const row = (await pool.query('select * from auth.emu_refresh_tokens where token = $1', [body.refresh_token || ''])).rows[0];
    if (!row || row.revoked) return authErr(res, 400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found');
    await pool.query('update auth.emu_refresh_tokens set revoked = true where token = $1', [row.token]);
    await pool.query('update auth.users set last_sign_in_at = now() where id = $1', [row.user_id]);
    return send(res, 200, await issueSession(row.user_id, row.session_id));
  }
  if (sub === 'user' && req.method === 'GET') {
    const v = verifyJWT(bearer(req), CFG.jwtSecret);
    if (!v.ok) return authErr(res, 403, 'bad_jwt', `invalid JWT: ${v.error}`);
    const u = (await pool.query('select * from auth.users where id = $1', [v.payload.sub])).rows[0];
    if (!u) return authErr(res, 403, 'user_not_found', 'User from sub claim in JWT does not exist');
    const live = (await pool.query('select 1 from auth.emu_refresh_tokens where session_id = $1 and not revoked limit 1', [v.payload.session_id])).rows.length;
    if (!live) return authErr(res, 403, 'session_not_found', 'Session from session_id claim in JWT does not exist');
    return send(res, 200, userJson(u));
  }
  if (sub === 'logout' && req.method === 'POST') {
    const v = verifyJWT(bearer(req), CFG.jwtSecret);
    if (v.ok) await pool.query('update auth.emu_refresh_tokens set revoked = true where session_id = $1', [v.payload.session_id]);
    return send(res, 204);
  }
  return send(res, 404, { message: 'not found' });
}

// ---------------------------------------------------------------------
//  REST（PostgREST 子集）
// ---------------------------------------------------------------------
const fnCache = new Map();
async function fnInfo(name) {
  if (fnCache.has(name)) return fnCache.get(name);
  const r = await pool.query(`select p.proargnames, p.pronargs, array(select format_type(t, null) from unnest(p.proargtypes) t) as types
                                from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                               where n.nspname = 'public' and p.proname = $1`, [name]);
  const info = r.rows.length ? { names: (r.rows[0].proargnames || []).slice(0, r.rows[0].pronargs), types: r.rows[0].types } : null;
  fnCache.set(name, info);
  return info;
}

async function handleRpc(req, res, name, buf) {
  const auth = restAuth(req);
  if (auth.error) return send(res, ...auth.error);
  const body = parseJSON(buf);
  if (body === null || Array.isArray(body)) return send(res, 400, { code: 'PGRST102', message: 'Invalid body' });
  const info = /^[a-z_][a-z0-9_]*$/.test(name) ? await fnInfo(name) : null;
  if (!info) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${name} in the schema cache` });
  const args = [], vals = [];
  for (const [k, v] of Object.entries(body)) {
    const i = info.names.indexOf(k);
    if (i < 0) return send(res, 404, { code: 'PGRST202', message: `Could not find the function public.${name}(${Object.keys(body).join(', ')}) in the schema cache` });
    const t = info.types[i];
    vals.push(v === null || v === undefined ? null : (t === 'jsonb' || t === 'json') ? JSON.stringify(v) : v);
    args.push(`${k} => $${vals.length}::${t}`);
  }
  try {
    const r = await withRole(auth.role, auth.claims, (c) => c.query(`select public.${name}(${args.join(', ')}) as result`, vals));
    return send(res, 200, r.rows[0] ? r.rows[0].result : null);
  } catch (e) { return sendPgError(res, e, auth.role); }
}

async function handleTable(req, res, table, url, buf) {
  const auth = restAuth(req);
  if (auth.error) return send(res, ...auth.error);
  if (!TABLES.has(table)) return send(res, 404, { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` });
  const sel = url.searchParams.get('select') || '*';
  if (!/^[a-z_*,]+$/.test(sel)) return send(res, 400, { message: 'bad select' });
  const where = [], vals = [];
  for (const [k, v] of url.searchParams) {
    if (['select', 'order', 'limit', 'columns', 'on_conflict'].includes(k)) continue;
    if (!/^[a-z_]+$/.test(k)) return send(res, 400, { message: 'bad column' });
    const m = String(v).match(/^(eq|neq|is)\.(.*)$/);
    if (!m) return send(res, 400, { message: 'unsupported filter' });
    if (m[1] === 'is') { where.push(`${k} is ${m[2] === 'null' ? 'null' : 'not null'}`); continue; }
    vals.push(m[2]);
    where.push(`${k}::text ${m[1] === 'eq' ? '=' : '<>'} $${vals.length}`);
  }
  const w = where.length ? ` where ${where.join(' and ')}` : '';
  const body = parseJSON(buf);
  let sql;
  if (req.method === 'GET') sql = `select ${sel} from public.${table}${w}`;
  else if (req.method === 'DELETE') sql = `delete from public.${table}${w} returning ${sel}`;
  else if (req.method === 'PATCH') {
    if (!body || typeof body !== 'object') return send(res, 400, { message: 'bad body' });
    const sets = Object.entries(body).map(([k, v]) => { vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v); return `${k} = $${vals.length}`; });
    sql = `update public.${table} set ${sets.join(', ')}${w} returning ${sel}`;
  } else if (req.method === 'POST') {
    const rows = Array.isArray(body) ? body : [body];
    const cols = Object.keys(rows[0] || {});
    if (!cols.length || !cols.every((c) => /^[a-z_]+$/.test(c))) return send(res, 400, { message: 'bad body' });
    const tuples = rows.map((r) => `(${cols.map((c) => { const v = r[c]; vals.push(typeof v === 'object' && v !== null ? JSON.stringify(v) : v); return `$${vals.length}`; }).join(', ')})`);
    sql = `insert into public.${table} (${cols.join(', ')}) values ${tuples.join(', ')} returning ${sel}`;
  } else return send(res, 405, { message: 'method not allowed' });
  try {
    const r = await withRole(auth.role, auth.claims, (c) => c.query(sql, vals));
    return send(res, req.method === 'POST' ? 201 : 200, r.rows);
  } catch (e) { return sendPgError(res, e, auth.role); }
}

// ---------------------------------------------------------------------
//  Storage
// ---------------------------------------------------------------------
const stErr = (res, status, error, message) => send(res, status, { statusCode: String(status), error, message });
function objFile(bucket, name) {
  const p = path.resolve(CFG.storageDir, bucket, name);
  if (!p.startsWith(path.resolve(CFG.storageDir) + path.sep)) throw new Error('bad path');
  return p;
}

async function handleStorage(req, res, rest, buf) {
  const auth = restAuth(req);
  if (auth.error) return stErr(res, 400, 'Unauthorized', 'Invalid JWT');
  const parts = rest.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] !== 'object') return stErr(res, 404, 'not_found', 'route not found');
  let i = 1;
  if (parts[i] === 'authenticated') i++;
  const bucket = parts[i];
  const name = parts.slice(i + 1).join('/');
  const bucketRow = (await pool.query('select * from storage.buckets where id = $1', [bucket])).rows[0];
  if (!bucketRow) return stErr(res, 404, 'Bucket not found', 'Bucket not found');

  if ((req.method === 'POST' || req.method === 'PUT') && name) {
    const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
    if (/multipart\/form-data/.test(mime)) return stErr(res, 400, 'unsupported', 'emulator only supports raw uploads');
    if (bucketRow.allowed_mime_types && bucketRow.allowed_mime_types.length && !bucketRow.allowed_mime_types.includes(mime)) {
      return stErr(res, 415, 'invalid_mime_type', `mime type ${mime} is not supported`);
    }
    if (bucketRow.file_size_limit && buf.length > Number(bucketRow.file_size_limit)) {
      return stErr(res, 413, 'Payload too large', 'The object exceeded the maximum allowed size');
    }
    const upsert = req.method === 'PUT' || String(req.headers['x-upsert']) === 'true';
    const meta = { mimetype: mime, size: buf.length, cacheControl: String(req.headers['cache-control'] || '') };
    const owner = auth.claims && auth.claims.sub ? auth.claims.sub : null;
    try {
      const r = await withRole(auth.role, auth.claims, (c) => c.query(upsert
        ? `insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values ($1, $2, $3, $4, $5)
           on conflict (bucket_id, name) do update set metadata = excluded.metadata, updated_at = now(), owner = excluded.owner, owner_id = excluded.owner_id returning id`
        : 'insert into storage.objects (bucket_id, name, owner, owner_id, metadata) values ($1, $2, $3, $4, $5) returning id',
        [bucket, name, owner, owner, JSON.stringify(meta)]));
      const file = objFile(bucket, name);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, buf);
      return send(res, 200, { Key: `${bucket}/${name}`, Id: r.rows[0].id });
    } catch (e) {
      if (e.code === '23505') return stErr(res, 409, 'Duplicate', 'The resource already exists');
      if (e.code === '42501') return stErr(res, 403, 'Unauthorized', 'new row violates row-level security policy');
      return stErr(res, 400, 'error', e.message);
    }
  }
  if (req.method === 'GET' && name) {
    try {
      const r = await withRole(auth.role, auth.claims, (c) => c.query('select id, metadata from storage.objects where bucket_id = $1 and name = $2', [bucket, name]));
      if (!r.rows.length) return stErr(res, 404, 'not_found', 'Object not found');
      const data = await fsp.readFile(objFile(bucket, name));
      res.writeHead(200, cors({ 'Content-Type': (r.rows[0].metadata && r.rows[0].metadata.mimetype) || 'application/octet-stream', 'Content-Length': data.length }));
      return res.end(data);
    } catch (e) { return stErr(res, 400, 'error', e.message); }
  }
  if (req.method === 'DELETE' && !name) {
    const body = parseJSON(buf) || {};
    const prefixes = Array.isArray(body.prefixes) ? body.prefixes.map(String) : [];
    try {
      const r = await withRole(auth.role, auth.claims, (c) => c.query('delete from storage.objects where bucket_id = $1 and name = any($2) returning id, name, bucket_id, metadata', [bucket, prefixes]));
      for (const row of r.rows) await fsp.rm(objFile(bucket, row.name), { force: true });
      return send(res, 200, r.rows);
    } catch (e) { return stErr(res, 400, 'error', e.message); }
  }
  return stErr(res, 404, 'not_found', 'route not found');
}

// ---------------------------------------------------------------------
//  Edge Function
// ---------------------------------------------------------------------
const adminClient = createClient(BASE, CFG.secretKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
async function handleFunction(req, res, name, buf) {
  if (name !== 'recover-save') return send(res, 404, { message: 'Function not found' });
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
  if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', String(req.socket.remoteAddress || ''));
  const request = new Request(`${BASE}/functions/v1/${name}`, { method: req.method, headers, body: ['GET', 'HEAD', 'OPTIONS'].includes(req.method) ? undefined : buf });
  const response = await recoverSave(request, { admin: adminClient, pepper: CFG.pepper, ttlHours: CFG.ttlHours, allowedOrigins: CFG.allowedOrigins });
  if (res.__dropAfter) { res.socket && res.socket.destroy(); return; }
  const out = Buffer.from(await response.arrayBuffer());
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
  res.end(out);
}

// ---------------------------------------------------------------------
//  測試控制
// ---------------------------------------------------------------------
async function handleControl(req, res, sub, buf) {
  const body = parseJSON(buf) || {};
  if (sub === 'reset') {
    await pool.query('truncate public.players, public.recovery_attempts, public.membership_changes cascade');
    await pool.query("delete from storage.objects where bucket_id = 'player-photos'");
    await pool.query('delete from auth.users');
    await fsp.rm(CFG.storageDir, { recursive: true, force: true });
    failRules = []; anonHits.clear(); reqLog.length = 0;
    CFG.anonEnabled = true; CFG.accessTtl = Number(process.env.EMU_ACCESS_TTL || 3600);
    return send(res, 200, { ok: true });
  }
  if (sub === 'fail') { failRules.push({ re: new RegExp(body.match), method: body.method || null, mode: body.mode || 'error', status: body.status || 503, times: body.times == null ? 1 : body.times, delayMs: body.delayMs || 0 }); return send(res, 200, { ok: true, rules: failRules.length }); }
  if (sub === 'clear-fail') { failRules = []; return send(res, 200, { ok: true }); }
  if (sub === 'config') { if (body.accessTtl != null) CFG.accessTtl = Number(body.accessTtl); if (body.anonEnabled != null) CFG.anonEnabled = !!body.anonEnabled; if (body.anonRateLimit != null) CFG.anonRateLimit = Number(body.anonRateLimit); return send(res, 200, { ok: true, accessTtl: CFG.accessTtl }); }
  if (sub === 'revoke') { const r = await pool.query('update auth.emu_refresh_tokens set revoked = true where user_id = $1', [body.user_id]); return send(res, 200, { ok: true, revoked: r.rowCount }); }
  if (sub === 'sql') { try { const r = await pool.query(body.sql, body.params || []); return send(res, 200, { rows: r.rows, rowCount: r.rowCount }); } catch (e) { return send(res, 400, { error: e.message }); } }
  if (sub === 'log') return send(res, 200, reqLog.slice(-300));
  if (sub === 'clear-log') { reqLog.length = 0; return send(res, 200, { ok: true }); }
  return send(res, 404, { message: 'unknown control' });
}

// ---------------------------------------------------------------------
//  路由
// ---------------------------------------------------------------------
async function route(req, res) {
  const url = new URL(req.url, BASE);
  const p = url.pathname;
  if (p.startsWith('/__emu/')) return handleControl(req, res, p.slice(7), await readBody(req));
  const entry = { t: Date.now(), end: 0, method: req.method, path: p, status: 0 };
  reqLog.push(entry);
  if (reqLog.length > 2000) reqLog.splice(0, 1000);
  res.on('finish', () => { entry.status = res.statusCode; entry.end = Date.now(); });
  res.on('close', () => { if (!entry.end) entry.end = Date.now(); });

  if (req.method === 'OPTIONS' && !p.startsWith('/functions/v1/')) {
    res.writeHead(200, cors({
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || '*',
      'Access-Control-Max-Age': '86400',
    }));
    return res.end();
  }
  // 注入錯誤（模擬網路中斷、伺服器錯誤、回應遺失、延遲）
  const rule = failRules.find((r) => r.times !== 0 && r.re.test(p) && (!r.method || r.method === req.method) && req.method !== 'OPTIONS');
  if (rule) {
    if (rule.times > 0) rule.times--;
    entry.injected = rule.mode;
    if (rule.mode === 'drop') { req.socket.destroy(); return; }
    if (rule.mode === 'error') return send(res, rule.status, { message: 'injected failure', code: 'EMU_INJECTED' });
    if (rule.mode === 'delay') await new Promise((r) => setTimeout(r, rule.delayMs));
    if (rule.mode === 'drop-after') res.__dropAfter = true;
    if (rule.mode === 'error-after') res.__errorAfter = rule.status;
  }
  const buf = await readBody(req);
  if (p.startsWith('/auth/v1/')) return handleAuth(req, res, p.slice(9), url, buf);
  if (p.startsWith('/rest/v1/rpc/')) return handleRpc(req, res, p.slice(13), buf);
  if (p.startsWith('/rest/v1/')) return handleTable(req, res, p.slice(9), url, buf);
  if (p.startsWith('/storage/v1/')) return handleStorage(req, res, p.slice(12), buf);
  if (p.startsWith('/functions/v1/')) return handleFunction(req, res, p.slice(14), buf);
  return send(res, 404, { message: 'not found' });
}

fs.mkdirSync(CFG.storageDir, { recursive: true });
http.createServer((req, res) => {
  route(req, res).catch((e) => { console.error('[emu]', e); try { send(res, 500, { message: String(e && e.message || e) }); } catch (_) { /* ignore */ } });
}).listen(CFG.port, '127.0.0.1', () => {
  console.log(`[emu] Supabase emulator on ${BASE}  (publishable key: ${CFG.publishableKey})`);
});
