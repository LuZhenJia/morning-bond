// =====================================================================
//  storage.js — 本機儲存工具、存檔雜湊、照片快取與 Supabase Storage 照片上傳／下載
// =====================================================================

export const SLOT = (() => {
  const s = new URLSearchParams(location.search).get('slot');
  return s && /^[A-Za-z0-9_-]{1,32}$/.test(s) ? s : 'main';
})();

const NS = 'morning-bond';
export const KEYS = {
  meta: `${NS}:cloud-meta:${SLOT}`,
  photos: `${NS}:photo-cache:${SLOT}`,
  legacyBackup: `${NS}:legacy-backup:${SLOT}`,
  backupPrefix: `${NS}:backup:${SLOT}:`,
  clientId: `${NS}:client-id`,
  auth: `${NS}:auth`,
};

export function readJSON(key, fallback = null) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}

export function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (e) {
    console.warn('[storage] 無法寫入', key, e && e.name);
    return false;
  }
}

export function readRaw(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

export function writeRaw(key, value) {
  try { localStorage.setItem(key, value); return true; } catch (e) { console.warn('[storage] 無法寫入', key, e && e.name); return false; }
}

export function removeKey(key) {
  try { localStorage.removeItem(key); } catch (e) { /* 忽略 */ }
}

export function getClientId() {
  let id = readRaw(KEYS.clientId);
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) {
    id = crypto.randomUUID();
    writeRaw(KEYS.clientId, id);
  }
  return id;
}

// ---------------------------------------------------------------------
//  穩定的 JSON 序列化（物件鍵排序）＋ SHA-256：
//  PostgreSQL 的 jsonb 會重新排列鍵的順序，所以比對本機與雲端存檔時一律用這個做雜湊。
// ---------------------------------------------------------------------
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    const t = JSON.stringify(value);
    return t === undefined ? 'null' : t;
  }
  if (Array.isArray(value)) {
    return '[' + value.map((v) => (v === undefined || typeof v === 'function' ? 'null' : stableStringify(v))).join(',') + ']';
  }
  const keys = Object.keys(value).filter((k) => value[k] !== undefined && typeof value[k] !== 'function').sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export async function sha256Hex(input) {
  const data = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export const stateChecksum = (state) => sha256Hex(stableStringify(state));

// ---------------------------------------------------------------------
//  本機備份（衝突、匯入、重新開始、改用雲端版本之前各留一份；最多 3 份）
// ---------------------------------------------------------------------
export function saveLocalBackup(reason, state) {
  const key = `${KEYS.backupPrefix}${Date.now()}`;
  const ok = writeJSON(key, { reason, at: new Date().toISOString(), state });
  const keys = listLocalBackups().map((b) => b.key);
  for (const k of keys.slice(3)) removeKey(k);
  return ok ? key : null;
}

export function listLocalBackups() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(KEYS.backupPrefix)) out.push({ key: k, t: Number(k.slice(KEYS.backupPrefix.length)) || 0 });
    }
  } catch (e) { /* 忽略 */ }
  return out.sort((a, b) => b.t - a.t);
}

// ---------------------------------------------------------------------
//  照片：本機快取（data URL）
// ---------------------------------------------------------------------
export class PhotoCache {
  constructor(key) { this.key = key; this.mem = readJSON(key, {}) || {}; }
  get(who) { return this.mem[who] || null; }
  set(who, entry) {
    this.mem[who] = { sha: entry.sha, dataUrl: entry.dataUrl, at: Date.now() };
    if (!writeJSON(this.key, this.mem)) console.warn('[photo] 本機照片快取已滿，這張照片只保留在記憶體中');
  }
  remove(who) { delete this.mem[who]; writeJSON(this.key, this.mem); }
}

const PHOTO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
export const PHOTO_MAX_BYTES = 1024 * 1024;

export function dataUrlInfo(dataUrl) {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime: m[1], ext: PHOTO_EXT[m[1]], bytes };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(fr.error || new Error('read failed'));
    fr.readAsDataURL(blob);
  });
}

// ---------------------------------------------------------------------
//  Supabase Storage（私有 bucket；路徑 <player_id>/<who>-<sha16>.<ext>）
// ---------------------------------------------------------------------
export class StorageFailure extends Error {
  constructor(kind, message) { super(message); this.kind = kind; }
}
function storageKind(error) {
  const status = Number(error && (error.status || error.statusCode)) || 0;
  if (!status || /fetch|network|load failed/i.test(String(error && error.message))) return 'network';
  if (status === 401) return 'auth';
  if (status >= 500) return 'server';
  return 'validation';
}

export async function uploadPhoto(client, bucket, path, info) {
  const { error } = await client.storage.from(bucket).upload(path, info.bytes.buffer, { contentType: info.mime, upsert: true, cacheControl: '31536000' });
  if (error) throw new StorageFailure(storageKind(error), error.message || 'upload failed');
}

export async function downloadPhoto(client, bucket, path) {
  const { data, error } = await client.storage.from(bucket).download(path);
  if (error || !data) throw new StorageFailure(storageKind(error), (error && error.message) || 'download failed');
  return blobToDataUrl(data);
}

export async function removePhotos(client, bucket, paths) {
  if (!paths.length) return [];
  const { data, error } = await client.storage.from(bucket).remove(paths);
  if (error) throw new StorageFailure(storageKind(error), error.message || 'remove failed');
  return data || [];
}
