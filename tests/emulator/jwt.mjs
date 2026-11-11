// 本機模擬器用的 HS256 JWT（只用於 tests/）
import crypto from 'node:crypto';

const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const fromB64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export function signJWT(payload, secret) {
  const header = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

// 回傳 { ok, payload, error }；error = 'malformed' | 'bad_signature' | 'expired'
export function verifyJWT(token, secret, now = Math.floor(Date.now() / 1000)) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, error: 'malformed' };
  const expect = b64u(crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest());
  const a = Buffer.from(expect), b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, error: 'bad_signature' };
  let payload;
  try { payload = JSON.parse(fromB64u(parts[1]).toString('utf8')); } catch (e) { return { ok: false, error: 'malformed' }; }
  if (typeof payload.exp === 'number' && payload.exp <= now) return { ok: false, error: 'expired', payload };
  return { ok: true, payload };
}
