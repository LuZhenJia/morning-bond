// =====================================================================
//  SQL / RLS 測試：直接在 PostgreSQL 以 anon / authenticated / service_role 身分執行，
//  驗證 schema.sql + policies.sql 的權限、觸發器與 RPC 行為。
//  用法：bash tests/emulator/pg.sh reset && node tests/sql/sql-tests.mjs
// =====================================================================
import pg from 'pg';
import crypto from 'node:crypto';

const pool = new pg.Pool({ host: '/tmp', port: Number(process.env.PG_PORT || 54329), user: 'postgres', database: process.env.PG_DB || 'mb', max: 4 });
const results = [];
const check = (name, cond, info = '') => { results.push({ name, ok: !!cond, info }); };

async function asRole(role, uid, sql, params = []) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${role}`);
    const claims = uid ? { sub: uid, role, aud: 'authenticated', is_anonymous: true } : { role };
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
    const r = await c.query(sql, params);
    await c.query('commit');
    return { rows: r.rows, rowCount: r.rowCount };
  } catch (e) {
    await c.query('rollback').catch(() => {});
    return { error: e };
  } finally { c.release(); }
}
const asUser = (uid, sql, params) => asRole('authenticated', uid, sql, params);
const asService = (sql, params) => asRole('service_role', null, sql, params);
const asAnon = (sql, params) => asRole('anon', null, sql, params);
const su = (sql, params) => pool.query(sql, params);
const rpc1 = (r) => (r.rows && r.rows[0] ? Object.values(r.rows[0])[0] : null);

function state(over = {}) {
  return {
    version: 2, started: true, createdAt: '2026-11-11', settledThrough: '2026-11-10',
    profile: { hero: '振嘉', names: {}, photos: {}, photoRefs: {} }, settings: { semStart: '2026-09-14' },
    schedule: [{ id: 's1', name: '普化' }], sisSchedule: [], player: { level: 1, exp: 0 },
    bonds: { mom: { aff: 20, lv: 0 } }, items: { supply: 0 }, days: {}, album: { prologue: '2026-11-11' },
    achievements: {}, collection: {}, shares: [], log: [{ d: '2026-11-11', t: '踏上修行之路' }], history: [], ending: null,
    ...over,
  };
}
async function newUser() {
  const id = crypto.randomUUID();
  await su("insert into auth.users (id, aud, role, is_anonymous, created_at) values ($1, 'authenticated', 'authenticated', true, now())", [id]);
  return id;
}
const sha = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

async function main() {
  await su('truncate public.players, public.recovery_attempts, public.membership_changes cascade');
  await su("delete from storage.objects where bucket_id = 'player-photos'");
  await su('delete from auth.users');
  const A = await newUser(), B = await newUser(), C = await newUser();

  // ---- anon 完全不能碰遊戲資料 ----
  let r = await asAnon('select * from public.game_saves');
  check('anon 不能讀 game_saves', r.error && /permission denied/.test(r.error.message), r.error && r.error.message);
  r = await asAnon("select public.ensure_player('x')");
  check('anon 不能呼叫 ensure_player', r.error && /permission denied/.test(r.error.message), r.error && r.error.message);
  r = await asAnon("select public.get_save_head('main')");
  check('anon 不能呼叫 get_save_head', r.error && /permission denied/.test(r.error.message));

  // ---- 建立玩家 ----
  r = await asUser(A, "select public.ensure_player('Chrome A')");
  const pa = rpc1(r);
  check('A：第一次 ensure_player 建立玩家', pa && pa.created === true && pa.player_id, pa);
  r = await asUser(A, "select public.ensure_player('Chrome A')");
  check('A：第二次 ensure_player 回傳同一位玩家', rpc1(r).player_id === pa.player_id && rpc1(r).created === false);
  const pb = rpc1(await asUser(B, "select public.ensure_player('Firefox B')"));
  check('B：建立另一位玩家', pb.player_id && pb.player_id !== pa.player_id);

  // ---- 建立存檔 ----
  const s1 = state();
  const op1 = crypto.randomUUID();
  r = await asUser(A, 'select public.create_game_save($1, $2, $3, $4, $5, $6)', ['main', s1, sha(s1), 'client-a', 'migration', op1]);
  const c1 = rpc1(r);
  check('A：create_game_save 成功、revision=1', c1 && c1.ok && c1.revision === 1, c1 || r.error?.message);
  const saveA = c1.id;
  r = await su('select started, settled_through, player_level, state_version, size_bytes from public.game_saves where id = $1', [saveA]);
  check('衍生欄位：started / settled_through / player_level / state_version', r.rows[0].started === true && r.rows[0].settled_through === '2026-11-10' && r.rows[0].player_level === 1 && r.rows[0].state_version === 2 && r.rows[0].size_bytes > 0, r.rows[0]);
  r = await asUser(A, 'select public.create_game_save($1, $2, $3, $4, $5, $6)', ['main', state({ started: false }), null, 'client-a', 'create', crypto.randomUUID()]);
  check('A：同一個 slot 再建立 → save_exists，不覆蓋', rpc1(r).ok === false && rpc1(r).error === 'save_exists' && rpc1(r).started === true, rpc1(r));
  r = await asUser(A, 'select public.create_game_save($1, $2, $3, $4, $5, $6)', ['main', s1, sha(s1), 'client-a', 'migration', op1]);
  check('A：同一個 op_id 重送 → 視為成功（回應遺失的補救）', rpc1(r).ok === true && rpc1(r).duplicate === true);

  // ---- 讀取 ----
  r = await asUser(A, "select public.load_game_save('main')");
  check('A：load_game_save 讀回完整 state', rpc1(r) && rpc1(r).state.profile.hero === '振嘉' && rpc1(r).revision === 1);
  r = await asUser(B, "select public.load_game_save('main')");
  check('B：讀不到 A 的存檔（RLS）', rpc1(r) === null);
  r = await asUser(B, 'select id from public.game_saves where id = $1', [saveA]);
  check('B：直接查詢 A 的存檔 → 0 筆', r.rows && r.rows.length === 0);

  // ---- B 的攻擊嘗試 ----
  r = await asUser(B, 'select public.update_game_save($1, $2, 1, null, $3, $4, $5)', [saveA, state({ player: { level: 99 } }), 'evil', 'autosave', crypto.randomUUID()]);
  check('B：update_game_save(A 的存檔) → not_found', rpc1(r) && rpc1(r).error === 'not_found', rpc1(r));
  r = await asUser(B, 'update public.game_saves set state = $2 where id = $1', [saveA, state({ player: { level: 99 } })]);
  check('B：直接 UPDATE A 的存檔 → 影響 0 筆', r.rowCount === 0, r.error && r.error.message);
  r = await asUser(B, 'delete from public.game_saves where id = $1', [saveA]);
  check('B：直接 DELETE A 的存檔 → 影響 0 筆', r.rowCount === 0);
  r = await asUser(B, 'insert into public.game_saves (player_id, slot, state) values ($1, $2, $3)', [pa.player_id, 'evil', state()]);
  check('B：以 A 的 player_id 新增存檔 → RLS 拒絕', r.error && /row-level security/.test(r.error.message), r.error && r.error.message);
  r = await asUser(B, 'select public.delete_game_save($1)', [saveA]);
  check('B：delete_game_save(A) → ok=false', rpc1(r) && rpc1(r).ok === false);
  r = await asUser(B, 'select * from public.players');
  check('B：只看得到自己的 players', r.rows.length === 1 && r.rows[0].id === pb.player_id);
  r = await asUser(B, 'delete from public.players where id = $1', [pa.player_id]);
  check('B：不能刪 A 的玩家', r.rowCount === 0);
  r = await asUser(B, 'select * from public.recovery_codes');
  check('authenticated 不能讀 recovery_codes', r.error && /permission denied/.test(r.error.message));
  r = await asUser(B, 'update public.players set write_count = 0');
  check('authenticated 不能 UPDATE players', r.error && /permission denied/.test(r.error.message));
  r = await asUser(B, 'insert into public.player_members (user_id, player_id) values ($1, $2)', [B, pa.player_id]);
  check('authenticated 不能自己加入別人的玩家', r.error && /permission denied/.test(r.error.message));

  // ---- 比對後寫入（revision） ----
  const s2 = state({ player: { level: 2, exp: 120 } });
  const op2 = crypto.randomUUID();
  r = await asUser(A, 'select public.update_game_save($1, $2, 1, $3, $4, $5, $6)', [saveA, s2, sha(s2), 'client-a', 'autosave', op2]);
  check('A：base=1 更新成功 → revision 2', rpc1(r).ok && rpc1(r).revision === 2, rpc1(r));
  r = await asUser(A, 'select public.update_game_save($1, $2, 1, $3, $4, $5, $6)', [saveA, state({ player: { level: 3 } }), null, 'client-b', 'autosave', crypto.randomUUID()]);
  check('A：舊的 base=1 再寫 → revision_conflict（回報雲端 revision 2）', rpc1(r).ok === false && rpc1(r).error === 'revision_conflict' && rpc1(r).revision === 2, rpc1(r));
  r = await asUser(A, 'select public.update_game_save($1, $2, 1, $3, $4, $5, $6)', [saveA, s2, sha(s2), 'client-a', 'autosave', op2]);
  check('A：同一個 op_id 重送 → duplicate 成功', rpc1(r).ok && rpc1(r).duplicate === true && rpc1(r).revision === 2);
  r = await asUser(A, 'update public.game_saves set revision = 999 where id = $1', [saveA]);
  r = await su('select revision from public.game_saves where id = $1', [saveA]);
  check('直接改 revision 會被觸發器改成 +1（不能任意設定）', Number(r.rows[0].revision) === 3, r.rows[0]);

  // ---- 防止空白覆蓋、版本降級、格式驗證、不可變欄位 ----
  r = await asUser(A, 'select public.update_game_save($1, $2, 3, null, $3, $4, $5)', [saveA, state({ started: false }), 'client-a', 'autosave', crypto.randomUUID()]);
  check('已開始的存檔不能被空白存檔覆蓋', r.error && /refuse_blank_overwrite/.test(r.error.message), r.error && r.error.message);
  r = await asUser(A, 'select public.update_game_save($1, $2, 3, null, $3, $4, $5)', [saveA, state({ version: 1 }), 'client-a', 'autosave', crypto.randomUUID()]);
  check('不能用舊版本格式覆蓋', r.error && /version_downgrade/.test(r.error.message));
  r = await asUser(A, 'select public.update_game_save($1, $2, 3, null, $3, $4, $5)', [saveA, { version: 2, started: true }, 'client-a', 'autosave', crypto.randomUUID()]);
  check('缺少必要欄位的 state 會被拒絕', r.error && /invalid_state/.test(r.error.message));
  r = await asUser(A, 'select public.update_game_save($1, $2, 3, null, $3, $4, $5)', [saveA, JSON.stringify([1, 2, 3]), 'client-a', 'autosave', crypto.randomUUID()]);
  check('非物件的 state 會被拒絕', r.error && /invalid_state/.test(r.error.message));
  const big = state({ log: Array.from({ length: 4000 }, (_, i) => ({ d: '2026-11-11', t: 'x'.repeat(800) + i })) });
  r = await asUser(A, 'select public.update_game_save($1, $2, 3, null, $3, $4, $5)', [saveA, big, 'client-a', 'autosave', crypto.randomUUID()]);
  check('超過 3MB 的 state 會被拒絕', r.error && /state_too_large/.test(r.error.message), r.error && r.error.message);
  r = await asUser(A, "update public.game_saves set slot = 'other' where id = $1", [saveA]);
  check('slot 不可修改', r.error && /immutable_columns/.test(r.error.message));
  r = await asUser(A, 'update public.game_saves set player_id = $2 where id = $1', [saveA, pb.player_id]);
  check('player_id 不可改成別人的', r.error && /(row-level security|immutable_columns)/.test(r.error.message), r.error && r.error.message);

  // ---- 備份與還原 ----
  const s3 = state({ player: { level: 4, exp: 999 }, settledThrough: '2026-11-12' });
  r = await asUser(A, 'select public.update_game_save($1, $2, 3, $3, $4, $5, $6)', [saveA, s3, sha(s3), 'client-a', 'import', crypto.randomUUID()]);
  check('A：匯入 → revision 4', rpc1(r).ok && rpc1(r).revision === 4, rpc1(r));
  r = await asUser(A, 'select public.list_save_snapshots($1)', [saveA]);
  const snaps = rpc1(r);
  check('匯入前的版本有自動備份', Array.isArray(snaps) && snaps.length >= 1 && snaps.some((x) => x.reason === 'import'), snaps);
  const snapLv2 = snaps.find((x) => x.player_level === 2);
  check('備份含 revision 3 的等級 2 版本', !!snapLv2, snaps.map((x) => [x.revision, x.player_level, x.reason]));
  r = await asUser(B, 'select public.list_save_snapshots($1)', [saveA]);
  check('B 看不到 A 的備份', Array.isArray(rpc1(r)) && rpc1(r).length === 0);
  r = await asUser(B, 'select public.restore_game_save($1, $2, 4, $3, $4)', [saveA, snapLv2.id, 'evil', crypto.randomUUID()]);
  check('B 不能還原 A 的備份', rpc1(r).ok === false, rpc1(r));
  r = await asUser(A, 'select public.restore_game_save($1, $2, 4, $3, $4)', [saveA, snapLv2.id, 'client-a', crypto.randomUUID()]);
  check('A：從備份還原 → revision 5、等級 2', rpc1(r).ok && rpc1(r).revision === 5 && rpc1(r).state.player.level === 2, rpc1(r) && { ok: rpc1(r).ok, rev: rpc1(r).revision });
  r = await asUser(A, 'select public.list_save_snapshots($1)', [saveA]);
  check('還原前的版本也被備份（等級 4）', rpc1(r).some((x) => x.player_level === 4 && x.reason === 'restore'));
  r = await asUser(A, 'insert into public.save_snapshots (save_id, player_id, revision, state, state_version, reason) values ($1, $2, 1, $3, 2, $4)', [saveA, pa.player_id, state(), 'fake']);
  check('前端不能自己新增備份', r.error && /permission denied/.test(r.error.message));
  // 備份保留上限 40
  let rev = 5;
  for (let i = 0; i < 45; i++) {
    const st = state({ player: { level: 2, exp: 1000 + i } });
    const x = rpc1(await asUser(A, 'select public.update_game_save($1, $2, $3, null, $4, $5, $6)', [saveA, st, rev, 'client-a', 'import', crypto.randomUUID()]));
    if (!x || !x.ok) { check('連續匯入 45 次', false, x); break; }
    rev = x.revision;
  }
  r = await su('select count(*)::int as n from public.save_snapshots where save_id = $1', [saveA]);
  check('備份最多保留 40 份', r.rows[0].n === 40, r.rows[0]);

  // ---- 對話與回憶 ----
  const s4 = state({
    player: { level: 3, exp: 300 },
    album: { prologue: '2026-11-11', sisPlan: '2026-11-11', sync: '2026-11-12' },
    achievements: { first: '2026-11-11' }, collection: { plan: '2026-11-11' },
    shares: [{ d: '2026-11-12', t: '哥，你們化材會學到梅納反應嗎？' }],
    log: [{ d: '2026-11-12', t: '結算 11/12：全勤' }, { d: '2026-11-11', t: '踏上修行之路' }],
    ending: { type: 'steady', date: '2027-01-17', rate: 0.8 },
  });
  r = await asUser(A, 'select public.update_game_save($1, $2, $3, null, $4, $5, $6)', [saveA, s4, rev, 'client-a', 'autosave', crypto.randomUUID()]);
  rev = rpc1(r).revision;
  r = await asUser(A, "select public.list_memories('main', null, 100)");
  const mem = rpc1(r);
  check('回憶：劇情 3、徽章 1、收藏 1、訊息 1、日誌 ≥2、結局 1', mem.counts.story === 3 && mem.counts.achievement === 1 && mem.counts.collection === 1 && mem.counts.share === 1 && mem.counts.log >= 2 && mem.counts.ending === 1, mem.counts);
  r = await asUser(A, 'select public.update_game_save($1, $2, $3, null, $4, $5, $6)', [saveA, { ...s4, items: { supply: 1 } }, rev, 'client-a', 'autosave', crypto.randomUUID()]);
  rev = rpc1(r).revision;
  r = await asUser(A, "select public.list_memories('main', null, 100)");
  check('回憶不會重複新增', JSON.stringify(rpc1(r).counts) === JSON.stringify(mem.counts), rpc1(r).counts);
  r = await asUser(B, "select public.list_memories('main', null, 100)");
  check('B 看不到 A 的回憶', JSON.stringify(rpc1(r).counts) === '{}');
  r = await asUser(A, "update public.memories set content = '{}'::jsonb");
  check('回憶不能被修改', r.error && /permission denied/.test(r.error.message));

  // ---- 沒有操作編號的直接修改，不可沿用上一筆的操作編號 ----
  r = await asUser(A, 'select public.update_game_save($1, $2, $3, null, $4, $5, $6)', [saveA, { ...s4, items: { supply: 2 } }, rev, 'client-a', 'autosave', crypto.randomUUID()]);
  rev = rpc1(r).revision;
  await su("update public.game_saves set state = jsonb_set(state, '{items,supply}', '3') where id = $1", [saveA]);
  r = await su('select last_op_id, last_client_id, revision::int as revision from public.game_saves where id = $1', [saveA]);
  check('直接修改資料表（沒有新的操作編號）→ last_op_id、last_client_id 清空', r.rows[0].last_op_id === null && r.rows[0].last_client_id === null && r.rows[0].revision === rev + 1, r.rows[0]);
  rev = r.rows[0].revision;

  // ---- 照片引用（刪舊照片前的安全檢查） ----
  const refOld = { path: `${pa.player_id}/mom-aaaaaaaaaaaaaaaa.jpg`, sha: 'a'.repeat(64) };
  const refNew = { path: `${pa.player_id}/mom-bbbbbbbbbbbbbbbb.jpg`, sha: 'b'.repeat(64) };
  const withOld = { ...s4, profile: { ...s4.profile, photos: {}, photoRefs: { mom: refOld } } };
  r = await asUser(A, 'select public.update_game_save($1, $2, $3, null, $4, $5, $6)', [saveA, withOld, rev, 'client-a', 'import', crypto.randomUUID()]);
  rev = rpc1(r).revision;
  const withNew = { ...s4, profile: { ...s4.profile, photos: {}, photoRefs: { mom: refNew } } };
  r = await asUser(A, 'select public.update_game_save($1, $2, $3, null, $4, $5, $6)', [saveA, withNew, rev, 'client-a', 'import', crypto.randomUUID()]);
  rev = rpc1(r).revision;
  r = await asUser(A, 'select public.list_photo_paths_in_use()');
  const used = rpc1(r) || [];
  check('照片引用：目前存檔的新照片在清單中', used.includes(refNew.path), used);
  check('照片引用：被備份引用的舊照片也在清單中（不能刪）', used.includes(refOld.path), used);
  r = await asUser(B, 'select public.list_photo_paths_in_use()');
  check('照片引用：B 看不到 A 的照片路徑', Array.isArray(rpc1(r)) && !rpc1(r).includes(refNew.path) && !rpc1(r).includes(refOld.path), rpc1(r));
  r = await asAnon('select public.list_photo_paths_in_use()');
  check('照片引用：anon 不能呼叫', r.error && /permission denied/.test(r.error.message));

  // ---- 速率與數量限制 ----
  await su('update public.players set write_count = 300, write_window_start = now() where id = $1', [pa.player_id]);
  r = await asUser(A, 'select public.update_game_save($1, $2, $3, null, $4, $5, $6)', [saveA, s4, rev, 'client-a', 'autosave', crypto.randomUUID()]);
  check('10 分鐘內超過 300 次寫入 → rate_limited', r.error && /rate_limited/.test(r.error.message), r.error && r.error.message);
  await su('update public.players set write_count = 0 where id = $1', [pa.player_id]);
  r = await asUser(A, 'select public.create_game_save($1, $2)', ['bad slot!', state()]);
  check('slot 名稱格式驗證', r.error && /check constraint/.test(r.error.message), r.error && r.error.message);
  for (const slot of ['s2', 's3', 's4', 's5']) await asUser(A, 'select public.create_game_save($1, $2)', [slot, state()]);
  r = await asUser(A, 'select public.create_game_save($1, $2)', ['s6', state()]);
  check('每位玩家最多 5 個存檔欄位', r.error && /too_many_saves/.test(r.error.message), r.error && r.error.message);

  // ---- Storage 照片政策 ----
  const photoName = `${pa.player_id}/hero-0123456789abcdef.jpg`;
  r = await asUser(A, "insert into storage.objects (bucket_id, name, owner) values ('player-photos', $1, $2)", [photoName, A]);
  check('A 可以上傳到自己的資料夾', !r.error, r.error && r.error.message);
  r = await asUser(A, "insert into storage.objects (bucket_id, name) values ('player-photos', $1)", [`${pa.player_id}/evil.exe`]);
  check('檔名格式不符 → 拒絕', r.error && /row-level security/.test(r.error.message));
  r = await asUser(A, "insert into storage.objects (bucket_id, name) values ('player-photos', $1)", [`${pb.player_id}/hero-0123456789abcdef.jpg`]);
  check('上傳到別人的資料夾 → 拒絕', r.error && /row-level security/.test(r.error.message));
  r = await asUser(A, "insert into storage.objects (bucket_id, name) values ('player-photos', $1)", [`${pa.player_id}/x/hero-0123456789abcdef.jpg`]);
  check('多層資料夾 → 拒絕', r.error && /row-level security/.test(r.error.message));
  r = await asUser(B, "select name from storage.objects where bucket_id = 'player-photos'");
  check('B 看不到 A 的照片', r.rows.length === 0);
  r = await asUser(B, "delete from storage.objects where name = $1", [photoName]);
  check('B 不能刪 A 的照片', r.rowCount === 0);
  for (let i = 1; i < 24; i++) await su("insert into storage.objects (bucket_id, name) values ('player-photos', $1)", [`${pa.player_id}/mom-${String(i).padStart(16, '0')}.jpg`]);
  r = await asUser(A, "insert into storage.objects (bucket_id, name) values ('player-photos', $1)", [`${pa.player_id}/sis-ffffffffffffffff.jpg`]);
  check('每位玩家最多 24 張照片', r.error && /row-level security/.test(r.error.message));
  r = await su("select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'player-photos'");
  check('player-photos bucket：私有、1MB、限 JPEG/PNG/WebP', r.rows[0].public === false && Number(r.rows[0].file_size_limit) === 1048576 && r.rows[0].allowed_mime_types.length === 3);

  // ---- 復原代碼（service role 專用） ----
  const code = 'ABCDEFGHJKMNPQRSTVWX';
  const hmac = (s) => crypto.createHmac('sha256', 'pepper').update(s).digest('hex');
  r = await asUser(A, 'select public.recovery_issue($1, $2, 168)', [A, hmac(code)]);
  check('authenticated 不能直接產生復原代碼', r.error && /permission denied/.test(r.error.message));
  r = await asService('select public.recovery_issue($1, $2, 168)', [A, hmac(code)]);
  check('service role：產生復原代碼', rpc1(r).ok && rpc1(r).player_id === pa.player_id, rpc1(r) || r.error?.message);
  r = await su('select code_hash from public.recovery_codes where player_id = $1', [pa.player_id]);
  check('資料庫只存雜湊，不存明碼', r.rows.every((x) => x.code_hash !== code && /^[0-9a-f]{64}$/.test(x.code_hash)));
  r = await asService('select public.recovery_redeem($1, $2, $3, false)', [C, hmac('WRONGCODE0000000000X'), 'ip1']);
  check('錯誤代碼 → invalid_code', rpc1(r).ok === false && rpc1(r).error === 'invalid_code');
  // C 自己也有進度 → 需要確認
  rpc1(await asUser(C, "select public.ensure_player('Safari C')"));
  await asUser(C, 'select public.create_game_save($1, $2)', ['main', state({ profile: { hero: 'C' } })]);
  r = await asService('select public.recovery_redeem($1, $2, $3, false)', [C, hmac(code), 'ip1']);
  check('自己也有雲端進度時 → has_own_progress（不消耗代碼）', rpc1(r).error === 'has_own_progress', rpc1(r));
  r = await asService('select public.recovery_redeem($1, $2, $3, true)', [C, hmac(code), 'ip1']);
  check('確認後（force）→ 成功連結到 A 的玩家', rpc1(r).ok && rpc1(r).player_id === pa.player_id, rpc1(r));
  r = await asUser(C, "select public.load_game_save('main')");
  check('C 現在讀得到 A 的存檔（同一位玩家）', rpc1(r) && rpc1(r).id === saveA);
  r = await asUser(C, 'select public.list_player_devices()');
  check('裝置清單：2 台、其中一台是自己', rpc1(r).length === 2 && rpc1(r).filter((x) => x.is_current).length === 1, rpc1(r));
  r = await su('select count(*)::int as n from public.membership_changes where user_id = $1', [C]);
  check('身分連結異動有紀錄', r.rows[0].n === 1);
  r = await asService('select public.recovery_redeem($1, $2, $3, false)', [B, hmac(code), 'ip2']);
  check('同一組代碼不能重複使用 → code_used', rpc1(r).error === 'code_used', rpc1(r));
  const code2 = 'ZZZZZZZZZZZZZZZZZZZZ';
  await asService('select public.recovery_issue($1, $2, 168)', [A, hmac(code2)]);
  await su("update public.recovery_codes set expires_at = now() - interval '1 minute' where code_hash = $1", [hmac(code2)]);
  r = await asService('select public.recovery_redeem($1, $2, $3, false)', [B, hmac(code2), 'ip2']);
  check('過期代碼 → code_expired', rpc1(r).error === 'code_expired', rpc1(r));
  const D = await newUser();
  for (let i = 0; i < 5; i++) await asService('select public.recovery_redeem($1, $2, $3, false)', [D, hmac('BAD' + i), 'ip9']);
  const code3 = 'YYYYYYYYYYYYYYYYYYYY';
  await asService('select public.recovery_issue($1, $2, 168)', [A, hmac(code3)]);
  r = await asService('select public.recovery_redeem($1, $2, $3, false)', [D, hmac(code3), 'ip10']);
  check('同一身分 1 小時內失敗 5 次 → rate_limited（即使代碼正確）', rpc1(r).error === 'rate_limited', rpc1(r));
  r = await asService('select public.recovery_status($1)', [A]);
  check('recovery_status：有有效代碼、2 台裝置', rpc1(r).active === true && rpc1(r).devices === 2, rpc1(r));
  r = await asService('select public.recovery_revoke($1)', [A]);
  r = await asService('select public.recovery_status($1)', [A]);
  check('recovery_revoke 之後沒有有效代碼', rpc1(r).active === false);
  r = await asService('select public.mb_cleanup_stale_anonymous(90)');
  check('維護函式不開放給 service role 從 API 呼叫', r.error && /permission denied/.test(r.error.message));

  // ---- 刪除 ----
  r = await asUser(A, "select public.delete_game_save(id) from public.game_saves where slot = 's5'");
  check('A：刪除自己的一個存檔', rpc1(r) && rpc1(r).ok === true);
  r = await asUser(B, 'select public.delete_game_save($1)', [saveA]);
  check('B 仍然刪不掉 A 的存檔', rpc1(r).ok === false);
  await su('delete from auth.users where id = $1', [B]);
  r = await su('select count(*)::int as n from public.player_members where user_id = $1', [B]);
  check('刪除 auth 使用者 → 裝置連結一併刪除', r.rows[0].n === 0);
  r = await asUser(A, 'delete from public.players where id = $1', [pa.player_id]);
  check('A 刪除自己的玩家（全部雲端資料）', r.rowCount === 1);
  r = await su('select count(*)::int as n from public.game_saves where player_id = $1', [pa.player_id]);
  const r2 = await su('select count(*)::int as n from public.memories where player_id = $1', [pa.player_id]);
  check('存檔、回憶連帶刪除', r.rows[0].n === 0 && r2.rows[0].n === 0);
}

main()
  .catch((e) => { console.error(e); results.push({ name: 'test runner crashed', ok: false, info: String(e) }); })
  .finally(async () => {
    await pool.end();
    const pass = results.filter((x) => x.ok).length;
    for (const x of results) console.log(`${x.ok ? 'PASS' : 'FAIL'} ${x.name}${x.ok ? '' : '  -> ' + JSON.stringify(x.info)}`);
    console.log(`\nSQL tests: ${pass}/${results.length} passed`);
    process.exitCode = pass === results.length ? 0 : 1;
  });
