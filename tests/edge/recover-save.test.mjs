// =====================================================================
//  以真正的 supabase-js（Node）對模擬器做整合測試：
//  匿名登入 → ensure_player → 存檔 RPC → 復原代碼（Edge Function handler.ts）→ 第二個身分加入
//  另外驗證：權杖過期自動更新、撤銷 session、CORS、Storage 政策、handler 單元行為。
//  前置：bash tests/emulator/pg.sh start && node --experimental-strip-types tests/emulator/server.mjs &
//  執行：node --experimental-strip-types tests/edge/recover-save.test.mjs
// =====================================================================
import { createClient } from '@supabase/supabase-js';
import { normalizeCode, formatCode, generateCode, CODE_ALPHABET } from '../../supabase/functions/recover-save/handler.ts';

const URL_ = process.env.EMU_URL || 'http://127.0.0.1:54321';
const KEY = process.env.EMU_PUBLISHABLE_KEY || 'sb_publishable_emulator_000000000000000000';
const results = [];
const check = (name, cond, info = '') => results.push({ name, ok: !!cond, info });
const ctl = async (sub, body = {}) => (await fetch(`${URL_}/__emu/${sub}`, { method: 'POST', body: JSON.stringify(body) })).json();
const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k) }; };
const client = (storage = memStore()) => createClient(URL_, KEY, { auth: { persistSession: true, autoRefreshToken: false, detectSessionInUrl: false, storage, storageKey: 'test-auth' } });
const state = (over = {}) => ({ version: 2, started: true, settledThrough: '2026-11-10', profile: { hero: 'A', photos: {}, photoRefs: {} }, settings: {}, schedule: [], player: { level: 1, exp: 0 }, bonds: {}, items: {}, days: {}, album: {}, ...over });

async function main() {
  await ctl('reset');

  // ---- handler 單元 ----
  const g = generateCode();
  check('handler：產生 20 碼、只含 Crockford 字元', g.length === 20 && [...g].every((c) => CODE_ALPHABET.includes(c)));
  check('handler：格式化成 5 組', formatCode(g).split('-').length === 5);
  check('handler：輸入正規化（小寫、空白、O→0、I/L→1）', normalizeCode('abcd-efgh jkmn pqrs tvwo') === 'ABCDEFGHJKMNPQRSTVW0' && normalizeCode('1111-iiii-llll-0000-oooo') === '11111111111100000000');
  check('handler：長度或字元不符回傳 null', normalizeCode('ABC') === null && normalizeCode('ABCDEFGHJKMNPQRSTVWU') === null && normalizeCode(123) === null);

  // ---- 匿名登入 ----
  const a = client();
  let r = await a.auth.signInAnonymously();
  check('A：匿名登入成功、is_anonymous', r.data && r.data.session && r.data.user && r.data.user.is_anonymous === true, r.error && r.error.message);
  const ua = r.data.user.id;
  r = await a.rpc('ensure_player', { p_device_label: 'node A' });
  check('A：ensure_player', r.data && r.data.player_id && r.data.created === true && r.data.is_anonymous === true, r.error);
  const pa = r.data.player_id;
  r = await a.rpc('create_game_save', { p_slot: 'main', p_state: state(), p_checksum: null, p_client_id: 'node-a', p_reason: 'create', p_op_id: crypto.randomUUID() });
  check('A：create_game_save', r.data && r.data.ok && r.data.revision === 1, r.error || r.data);
  const saveA = r.data.id;

  // ---- anon（未登入）----
  const anon = createClient(URL_, KEY, { auth: { persistSession: false } });
  r = await anon.rpc('get_save_head', { p_slot: 'main' });
  check('未登入呼叫 RPC → 被拒（401）', r.error && (r.status === 401 || /permission denied/.test(r.error.message)), r.status);
  r = await anon.from('game_saves').select('id');
  check('未登入讀 game_saves → 被拒', r.error && /permission denied/.test(r.error.message), r.error);

  // ---- 另一個匿名身分 B ----
  const b = client();
  await b.auth.signInAnonymously();
  r = await b.rpc('ensure_player', {});
  const pb = r.data.player_id;
  check('B：不同的玩家', pb && pb !== pa);
  r = await b.from('game_saves').select('id, player_id').eq('id', saveA);
  check('B：REST 讀不到 A 的存檔', Array.isArray(r.data) && r.data.length === 0, r.error);
  r = await b.from('game_saves').update({ state: state({ player: { level: 99 } }) }).eq('id', saveA).select('id');
  check('B：REST 改不到 A 的存檔', Array.isArray(r.data) && r.data.length === 0, r.error);
  r = await b.rpc('load_game_save', { p_slot: 'main' });
  check('B：load_game_save → null', r.data === null && !r.error);

  // ---- Storage ----
  const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  r = await a.storage.from('player-photos').upload(`${pa}/hero-0123456789abcdef.jpg`, bytes.buffer, { contentType: 'image/jpeg', upsert: true });
  check('Storage：A 上傳到自己的資料夾', !r.error, r.error && r.error.message);
  r = await a.storage.from('player-photos').upload(`${pa}/hero-0123456789abcdef.jpg`, bytes.buffer, { contentType: 'image/jpeg', upsert: true });
  check('Storage：同路徑覆蓋（upsert）', !r.error, r.error && r.error.message);
  r = await b.storage.from('player-photos').upload(`${pa}/dad-0123456789abcdef.jpg`, bytes.buffer, { contentType: 'image/jpeg', upsert: true });
  check('Storage：B 不能上傳到 A 的資料夾', r.error, r.error && r.error.message);
  r = await a.storage.from('player-photos').upload(`${pa}/hero-1123456789abcdef.gif`, bytes.buffer, { contentType: 'image/gif', upsert: true });
  check('Storage：不允許的檔案類型', r.error, r.error && r.error.message);
  r = await a.storage.from('player-photos').upload(`${pa}/hero-2123456789abcdef.jpg`, new Uint8Array(1048577).buffer, { contentType: 'image/jpeg', upsert: true });
  check('Storage：超過 1MB 被拒', r.error, r.error && r.error.message);
  r = await a.storage.from('player-photos').download(`${pa}/hero-0123456789abcdef.jpg`);
  const got = r.data ? new Uint8Array(await r.data.arrayBuffer()) : null;
  check('Storage：A 下載自己的照片（內容相同）', got && got.length === bytes.length && got.every((x, i) => x === bytes[i]), r.error && r.error.message);
  r = await b.storage.from('player-photos').download(`${pa}/hero-0123456789abcdef.jpg`);
  check('Storage：B 下載不到 A 的照片', r.error && !r.data, r.error && r.error.message);
  r = await b.storage.from('player-photos').remove([`${pa}/hero-0123456789abcdef.jpg`]);
  check('Storage：B 刪不掉 A 的照片', Array.isArray(r.data) && r.data.length === 0, r.error);

  // ---- 復原代碼 ----
  r = await a.functions.invoke('recover-save', { body: { action: 'create' } });
  check('Function：A 產生復原代碼', r.data && r.data.ok && /^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$/.test(r.data.code) && r.data.expires_at, r.error || r.data);
  const code = r.data.code;
  r = await anon.functions.invoke('recover-save', { body: { action: 'create' } });
  check('Function：未登入（只有 publishable key）→ 401', r.error && r.response && r.response.status === 401, r.response && r.response.status);
  const c = client();
  await c.auth.signInAnonymously();
  await c.rpc('ensure_player', {});
  r = await c.functions.invoke('recover-save', { body: { action: 'redeem', code: 'AAAA-BBBB-CCCC-DDDD-EEEE' } });
  const body1 = r.error && r.error.context ? await r.error.context.json() : r.data;
  check('Function：錯誤代碼 → invalid_code', body1 && body1.error === 'invalid_code', body1);
  r = await c.functions.invoke('recover-save', { body: { action: 'redeem', code: 'xyz' } });
  const body2 = r.error && r.error.context ? await r.error.context.json() : r.data;
  check('Function：格式錯誤 → invalid_format', body2 && body2.error === 'invalid_format', body2);
  r = await c.functions.invoke('recover-save', { body: { action: 'redeem', code: code.toLowerCase().replace(/-/g, ' ') } });
  check('Function：C 用代碼加入 A 的玩家（大小寫、空白都可以）', r.data && r.data.ok && r.data.player_id === pa, r.error ? await r.error.context.json() : r.data);
  r = await c.rpc('load_game_save', { p_slot: 'main' });
  check('C：讀到 A 的存檔', r.data && r.data.id === saveA);
  r = await c.functions.invoke('recover-save', { body: { action: 'redeem', code } });
  const body3 = r.error && r.error.context ? await r.error.context.json() : r.data;
  check('Function：代碼只能用一次', body3 && (body3.error === 'code_used' || body3.already_member === true), body3);
  r = await a.functions.invoke('recover-save', { body: { action: 'status' } });
  check('Function：status → 2 台裝置、沒有有效代碼', r.data && r.data.ok && r.data.devices === 2 && r.data.active === false, r.data);

  // ---- CORS preflight（瀏覽器會先送 OPTIONS） ----
  const pre = await fetch(`${URL_}/functions/v1/recover-save`, { method: 'OPTIONS', headers: { Origin: 'https://example.github.io', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, x-client-info, apikey, content-type' } });
  check('Function：CORS preflight 允許必要標頭', pre.ok && /authorization/.test(pre.headers.get('access-control-allow-headers')) && pre.headers.get('access-control-allow-origin'), [pre.status, pre.headers.get('access-control-allow-headers')]);

  // ---- 權杖過期與更新（supabase-js 會在每次請求前自動更新快過期的權杖）----
  await ctl('config', { accessTtl: 2 });
  const d = client();
  await d.auth.signInAnonymously();
  await d.rpc('ensure_player', {});
  const t1 = (await d.auth.getSession()).data.session.access_token;
  await new Promise((res) => setTimeout(res, 2600));
  r = await d.rpc('get_save_head', { p_slot: 'main' });
  const t2 = (await d.auth.getSession()).data.session.access_token;
  check('權杖過期後的 RPC 會自動更新權杖並成功', !r.error && t2 && t2 !== t1, [r.status, r.error && r.error.message]);
  const uid = (await d.auth.getSession()).data.session.user.id;
  await ctl('revoke', { user_id: uid });
  const rs2 = await d.auth.refreshSession();
  check('session 被撤銷後 refresh 失敗（refresh_token_not_found）', rs2.error && /Refresh Token/i.test(rs2.error.message), rs2.error && rs2.error.message);
  await new Promise((res) => setTimeout(res, 2600));
  const sess = await d.auth.getSession();
  check('撤銷且權杖過期後，本機 session 被清除（SIGNED_OUT）', !sess.data.session, sess.data && !!sess.data.session);
  await ctl('config', { accessTtl: 3600 });
}

main()
  .catch((e) => { console.error(e); results.push({ name: 'crashed', ok: false, info: String(e && e.stack || e) }); })
  .finally(() => {
    const pass = results.filter((x) => x.ok).length;
    for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'} ${x.name}${x.ok ? '' : '  -> ' + JSON.stringify(x.info)}`);
    console.log(`\nEdge/API tests: ${pass}/${results.length} passed`);
    process.exitCode = pass === results.length ? 0 : 1;
  });
