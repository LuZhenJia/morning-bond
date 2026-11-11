"""
雲端存檔端對端測試（真的瀏覽器 Chromium + 本機 Supabase 模擬器 + 真的 PostgreSQL）

對應 README「測試清單」的 17 項需求，另外加上復原代碼、多分頁、Session 遺失、備份還原、
刪除雲端存檔、較新版本保護、金鑰安全、debounce／定時同步與請求不重疊等情境。

執行前：
  bash tests/emulator/pg.sh start
  (cd tests && node --experimental-strip-types emulator/server.mjs &)
執行：
  python3 tests/e2e/cloud.py              # 全部
  python3 tests/e2e/cloud.py t07 t11      # 只跑名稱包含 t07、t11 的測試
可選環境變數：OLD_GAME_URL（v1.1 單檔版，用來測 JSON 與舊版的相容性）、CHROME、EMU_URL、SITE_PORT

測試網站：把專案複製到暫存資料夾，config.js 改成指向模擬器；為了讓測試跑得快，
「快速版」把 debounce／定時同步縮短（400ms／4 秒），另有「慢速版」（debounce 20 秒）專門測
visibilitychange／pagehide 立即補存，以及「Secret key 版」測試金鑰防呆。
"""
import functools
import http.server
import json
import os
import pathlib
import re
import shutil
import struct
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.request
import zlib

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parents[2]
EMU = os.environ.get('EMU_URL', 'http://127.0.0.1:54321')
PUBLISHABLE = os.environ.get('EMU_PUBLISHABLE_KEY', 'sb_publishable_emulator_000000000000000000')
SITE_PORT = int(os.environ.get('SITE_PORT', '8090'))
CHROME = os.environ.get('CHROME', '/usr/bin/google-chrome')
OLD_GAME = os.environ.get('OLD_GAME_URL', '')
SITE = pathlib.Path(tempfile.mkdtemp(prefix='mb-cloud-site-'))
BASE = f'http://127.0.0.1:{SITE_PORT}'
GAME = f'{BASE}/Morning-Bond/index.html'
GAME_SLOW = f'{BASE}/Morning-Bond-slow/index.html'
GAME_LOCAL = f'{BASE}/Morning-Bond-local/index.html'
GAME_SECRET = f'{BASE}/Morning-Bond-secret/index.html'
SAVE_KEY = 'chenguang-bond-save-v1'
TMP = pathlib.Path(tempfile.mkdtemp(prefix='mb-cloud-tmp-'))

RESULTS, ERRS, CUR = [], [], ['']
PW = {}


# ---------------------------------------------------------------------
#  測試網站與模擬器
# ---------------------------------------------------------------------
def build_site():
    def cfg(url, key, debounce, max_wait, interval):
        return f"""export const CONFIG = Object.freeze({{
  supabaseUrl: '{url}',
  supabasePublishableKey: '{key}',
  photoBucket: 'player-photos',
  recoveryFunction: 'recover-save',
  autosaveDebounceMs: {debounce},
  autosaveMaxWaitMs: {max_wait},
  syncIntervalMs: {interval},
  bootGateTimeoutMs: 8000,
}});
"""
    variants = {
        'Morning-Bond': cfg(EMU, PUBLISHABLE, 400, 2500, 4000),
        'Morning-Bond-slow': cfg(EMU, PUBLISHABLE, 20000, 60000, 45000),
        'Morning-Bond-local': cfg('', '', 2500, 15000, 45000),
        'Morning-Bond-secret': cfg(EMU, 'sb_secret_emulator_00000000000000000000000', 400, 2500, 4000),
    }
    for name, conf in variants.items():
        dst = SITE / name
        shutil.copytree(ROOT, dst, ignore=shutil.ignore_patterns('tests', '.git', 'node_modules', '*.zip'))
        (dst / 'js' / 'config.js').write_text(conf, encoding='utf-8')


def serve_site():
    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def end_headers(self):
            self.send_header('Cache-Control', 'no-store')
            super().end_headers()
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', SITE_PORT), functools.partial(Quiet, directory=str(SITE)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def emu(sub, body=None):
    req = urllib.request.Request(f'{EMU}/__emu/{sub}', data=json.dumps(body or {}).encode(), method='POST', headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            t = r.read().decode()
    except urllib.error.HTTPError as e:
        t = e.read().decode()
    return json.loads(t) if t else None


def sql(q, *params):
    r = emu('sql', {'sql': q, 'params': list(params)})
    if r is None or 'error' in r:
        raise RuntimeError(f'SQL error: {r and r.get("error")} :: {q}')
    return r['rows']


def emu_log():
    return emu('log') or []


def fail(match, mode='error', times=1, status=503, method=None, delay_ms=0):
    emu('fail', {'match': match, 'mode': mode, 'times': times, 'status': status, 'method': method, 'delayMs': delay_ms})


def calls(log, name, since=0):
    return [e for e in log if e['path'].endswith(name) and e['t'] >= since and not e.get('injected') and e['method'] != 'OPTIONS']


# ---------------------------------------------------------------------
#  紀錄
# ---------------------------------------------------------------------
def check(name, cond, info=''):
    RESULTS.append((CUR[0], name, bool(cond), '' if cond else str(info)[:700]))
    return bool(cond)


def first_diff(a, b, path='S'):
    if type(a) is not type(b):
        return f'{path}: {type(a).__name__} != {type(b).__name__}'
    if isinstance(a, dict):
        for k in sorted(set(a) | set(b)):
            if k not in a or k not in b:
                return f'{path}.{k}: 只存在於一邊'
            d = first_diff(a[k], b[k], f'{path}.{k}')
            if d:
                return d
        return None
    if isinstance(a, list):
        if len(a) != len(b):
            return f'{path}: 長度 {len(a)} != {len(b)}'
        for i, (x, y) in enumerate(zip(a, b)):
            d = first_diff(x, y, f'{path}[{i}]')
            if d:
                return d
        return None
    return None if a == b else f'{path}: {str(a)[:60]} != {str(b)[:60]}'


IGNORED_CONSOLE = re.compile(r'Failed to load resource|net::ERR_|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION|injected failure')


def new_page(ctx, label=''):
    pg = ctx.new_page()
    tag = f'[{CUR[0][:24]}{label}]'
    pg.on('pageerror', lambda e: ERRS.append(f'{tag} pageerror: {e}'))
    pg.on('console', lambda m: ERRS.append(f'{tag} console.{m.type}: {m.text}') if m.type == 'error' and not IGNORED_CONSOLE.search(m.text) else None)
    return pg


def new_ctx(**kw):
    return PW['browser'].new_context(viewport={'width': 1200, 'height': 900}, accept_downloads=True, **kw)


def open_game(ctx, date='2026-11-11', time_='09:30', url=GAME, label='', page=None):
    pg = page or new_page(ctx, label)
    pg.goto(f'{url}?date={date}&time={time_}')
    pg.wait_for_function('() => !!window.__cloud && !!window.__cg', timeout=20000)
    return pg


def wait_ready(pg, timeout=20000):
    pg.wait_for_function('() => window.__cloud.ready === true', timeout=timeout)


def wait_synced(pg, timeout=25000):
    pg.wait_for_function("() => { const m = window.__cloud; return m && m.status === 'synced' && !m.meta.dirty && !m.inFlight; }", timeout=timeout)


def wait_status(pg, status, timeout=25000):
    pg.wait_for_function(f"() => window.__cloud && window.__cloud.status === {json.dumps(status)}", timeout=timeout)


def mstate(pg):
    return pg.evaluate('() => JSON.parse(JSON.stringify(window.__cg.state))')


def meta(pg):
    return pg.evaluate('() => JSON.parse(JSON.stringify(window.__cloud.meta))')


def pill(pg):
    return pg.inner_text('#cloud-pill')


def cloud_save(player_id, slot='main'):
    rows = sql('select id::text as id, revision::int as revision, state, state_version, checksum, started, settled_through, player_level, last_reason, last_op_id::text as last_op_id, size_bytes::int as size_bytes from public.game_saves where player_id = $1 and slot = $2', player_id, slot)
    return rows[0] if rows else None


def dismiss(pg, limit=60):
    for _ in range(limit):
        if not pg.is_visible('#modal'):
            return
        for sel in ('#modal [data-act="storynext"]', '#modal [data-act^="evpick:"]', '#modal [data-act="close"]', '#modal [data-act^="skipok"]'):
            if pg.query_selector(sel):
                pg.click(sel)
                break
        else:
            pg.click('#modal .btn')
        pg.wait_for_timeout(70)
    raise RuntimeError('modal did not close')


def gate_closed(pg, timeout=20000):
    pg.wait_for_function("() => { const m = document.getElementById('cloud-modal'); return m.hidden || !m.querySelector('.cl-gate'); }", timeout=timeout)


def start_game(pg):
    wait_ready(pg)
    gate_closed(pg)
    pg.click('[data-act="start"]')
    pg.wait_for_timeout(150)
    dismiss(pg)


def play_today(pg, outcome='perfect', skills=True):
    """在目前頁面（不重新載入）玩完當天：睡眠 → 起床 → 出門 → 每堂回報 → 晚上互動 → 複習 → 結算。"""
    dismiss(pg)
    if pg.is_visible('#cloud-modal'):
        raise RuntimeError('雲端視窗擋住畫面：' + pg.inner_text('#cloud-modal')[:200].replace('\n', ' ') + ' | status=' + str(pg.evaluate('() => [window.__cloud.status, window.__cloud.detail]')))
    if pg.query_selector('[data-act="tab:today"]'):
        pg.click('[data-act="tab:today"]')
    if pg.query_selector('[data-act="sleep:ok"]'):
        pg.click('[data-act="sleep:ok"]')
        dismiss(pg)
        if not pg.evaluate('() => !!window.__cg.state.days[window.__cg.playDate()].wake'):
            pg.click('[data-act="wake:ok"]')
        if pg.query_selector('[data-act="supply"]'):
            pg.click('[data-act="supply"]')
        pg.click('[data-act="begin"]')
        dismiss(pg)
    for _ in range(20):
        btns = pg.query_selector_all('[data-act^="rep:"][data-act$=":perfect"]')
        if not btns:
            break
        sid = btns[0].get_attribute('data-act').split(':')[1]
        pg.click(f'[data-act="rep:{sid}:{outcome}"]')
        pg.wait_for_timeout(900)
        dismiss(pg)
    if pg.query_selector('[data-act="candy"]'):
        pg.click('[data-act="candy"]')
    if pg.query_selector('[data-act="toEvening"]'):
        pg.click('[data-act="toEvening"]')
    who = pg.query_selector_all('[data-act^="iwho:"]')
    if who:
        who[0].click()
        pg.click('[data-act^="inter:"]')
        dismiss(pg)
    if pg.query_selector('[data-act="review"]'):
        pg.click('[data-act="review"]')
    pg.click('[data-act="settle"]')
    pg.wait_for_timeout(150)
    dismiss(pg)
    st = mstate(pg)
    if skills and st['player']['level'] >= 2 and st['player']['sp'] > 0:
        pg.click('[data-act="tab:skills"]')
        b = pg.query_selector('[data-act^="learn:"]')
        if b:
            b.click()
            pg.wait_for_timeout(60)
            dismiss(pg)
        pg.click('[data-act="tab:today"]')


def play_day(pg, date, url=GAME, outcome='perfect'):
    open_game(None, date, '21:30', url=url, page=pg)
    wait_ready(pg)
    play_today(pg, outcome)


def png(path, color=(200, 120, 80), w=64, h=80):
    raw = b''.join(b'\x00' + bytes(color) * w for _ in range(h))

    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    pathlib.Path(path).write_bytes(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))
    return str(path)


def upload_photo(pg, who, path):
    pg.click('[data-act="tab:settings"]')
    pg.set_input_files(f'input[data-photo="{who}"]', path)
    pg.wait_for_function(f"() => {{ const p = window.__cg.state.profile; return !!((p.photos && p.photos.{who}) || (p.photoRefs && p.photoRefs.{who})); }}", timeout=10000)


def export_json(pg, selector='[data-act="export"]'):
    if selector == '[data-act="export"]':
        pg.click('[data-act="tab:settings"]')
    with pg.expect_download() as dl:
        pg.click(selector)
    return json.loads(pathlib.Path(dl.value.path()).read_text(encoding='utf-8')), dl.value.suggested_filename


def import_json(pg, data):
    f = TMP / f'import-{time.time_ns()}.json'
    f.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    if pg.query_selector('[data-act="tab:settings"]'):
        pg.click('[data-act="tab:settings"]')
    pg.evaluate("() => { if (!document.getElementById('imp-t')) { const i = document.createElement('input'); i.type = 'file'; i.dataset.import = '1'; i.id = 'imp-t'; document.body.appendChild(i); } }")
    pg.set_input_files('#imp-t', str(f))
    pg.wait_for_timeout(600)
    dismiss(pg)


def recovery_code(pg):
    return pg.evaluate('async () => (await window.__cloud.createRecoveryCode()).code')


def local_backups(pg):
    return pg.evaluate("() => Object.keys(localStorage).filter(k => k.startsWith('morning-bond:backup:')).map(k => JSON.parse(localStorage.getItem(k)))")


TESTS = []


def test(fn):
    TESTS.append(fn)
    return fn


# =====================================================================
#  1–3 新玩家、匿名身分、初始存檔
# =====================================================================
@test
def t01_new_player():
    """t01 新玩家第一次進入／匿名身分建立／初始存檔建立"""
    ctx = new_ctx()
    reqs = []
    ctx.on('request', lambda r: reqs.append(r) if r.url.startswith(EMU) else None)
    fail(r'^/auth/v1/signup', 'delay', times=1, delay_ms=1500)
    pg = open_game(ctx)
    pg.wait_for_function("() => /正在連接雲端/.test(document.getElementById('cloud-pill').textContent)", timeout=5000)
    check('新裝置先顯示「正在連接雲端」，並暫時擋住開始按鈕直到確認雲端有沒有存檔', '正在連接雲端' in pill(pg) and pg.is_visible('#cloud-modal .cl-gate'), pill(pg))
    wait_ready(pg)
    m = meta(pg)
    check('自動建立匿名身分（畫面上沒有註冊／登入／密碼欄位）', bool(m['userId']) and pg.query_selector('input[type=password]') is None and pg.query_selector('input[type=email]') is None, m)
    users = sql('select id::text, is_anonymous from auth.users')
    check('Supabase auth.users 只有 1 位匿名使用者，且就是這個瀏覽器', len(users) == 1 and users[0]['is_anonymous'] is True and users[0]['id'] == m['userId'], users)
    pl = sql('select pm.player_id::text as pid from public.player_members pm where pm.user_id = $1', m['userId'])
    check('建立玩家資料（players + player_members）', len(pl) == 1 and pl[0]['pid'] == m['playerId'], pl)
    check('還沒開始遊戲時不會上傳空白存檔', len(sql('select 1 from public.game_saves')) == 0)
    check('Session 自動保存在 localStorage（下次開啟沿用）', pg.evaluate("() => !!localStorage.getItem('morning-bond:auth')"))
    check('畫面右下角顯示雲端狀態（已同步）', '已同步' in pill(pg), pill(pg))
    gate_closed(pg)
    check('歡迎畫面多了「輸入復原代碼／匯入 JSON」的雲端提示', pg.query_selector('.cl-welcome [data-cloud="redeem"]') is not None)
    start_game(pg)
    wait_synced(pg)
    row = cloud_save(m['playerId'])
    st = mstate(pg)
    check('開始遊戲後自動建立雲端存檔（revision 1 起算）', row is not None and row['started'] is True and row['revision'] >= 1, row and {k: row[k] for k in ('revision', 'started', 'last_reason')})
    check('雲端存檔內容 = 本機完整狀態 S（逐欄位相同）', row and row['state'] == st, row and first_diff(row['state'], st))
    check('S 的全部頂層欄位都在雲端', row and set(st.keys()) <= set(row['state'].keys()), sorted(set(st.keys()) - set(row['state'].keys())) if row else '')
    check('雲端 checksum 與本機記錄一致', row and row['checksum'] == meta(pg)['syncedHash'])
    check('雲端存檔的衍生欄位正確（版本、等級、是否開始）', row and row['state_version'] == st['version'] and row['player_level'] == st['player']['level'])
    bad = [r.url for r in reqs if r.method != 'OPTIONS' and r.headers.get('apikey') not in (PUBLISHABLE,)]
    check('所有雲端請求都只帶 Publishable key', not bad, bad[:3])
    check('沒有任何請求帶 Secret / service_role 金鑰', not any('sb_secret' in json.dumps(r.headers) for r in reqs))
    check('狀態膠囊顯示「已同步」與時間', re.search(r'已同步 \d{2}:\d{2}', pill(pg)) is not None, pill(pg))
    ctx.close()


# =====================================================================
#  4 雲端讀取
# =====================================================================
@test
def t02_cloud_read():
    """t02 雲端讀取（其他裝置的新進度、本機存檔遺失、loadSave）"""
    ctx = new_ctx()
    pg = open_game(ctx)
    start_game(pg)
    play_today(pg)
    wait_synced(pg)
    m = meta(pg)
    row = cloud_save(m['playerId'])
    # 雲端被另一台裝置更新（以 SQL 模擬）→ 這台沒有未同步變更 → 自動讀取
    sql("update public.game_saves set state = jsonb_set(state, '{profile,hero}', '\"雲端改的名字\"'), last_reason = 'autosave', last_client_id = 'other-device' where id = $1", row['id'])
    pg.evaluate('() => window.__cloud.syncSave()')
    pg.wait_for_function("() => window.__cg.state.profile.hero === '雲端改的名字'", timeout=15000)
    check('偵測到雲端較新的版本並自動讀取（本機沒有未同步變更）', mstate(pg)['profile']['hero'] == '雲端改的名字')
    check('讀取後畫面也更新', '雲端改的名字' in pg.inner_text('#top'), pg.inner_text('#top')[:80])
    wait_synced(pg)
    row2 = cloud_save(m['playerId'])
    check('讀取後與雲端版本對齊（revision 相同）', meta(pg)['revision'] == row2['revision'], (meta(pg)['revision'], row2['revision']))
    # 本機遊戲存檔遺失（只剩身分與連結資料）→ 重新開啟要從雲端讀回，不可以變成新遊戲
    pg.evaluate(f"() => localStorage.removeItem('{SAVE_KEY}')")
    open_game(None, '2026-11-11', '21:30', page=pg)
    wait_ready(pg)
    pg.wait_for_function('() => window.__cg.state.started === true', timeout=15000)
    st = mstate(pg)
    check('本機存檔遺失 → 自動從雲端讀回完整進度', st == cloud_save(m['playerId'])['state'], first_diff(st, cloud_save(m['playerId'])['state']))
    check('讀回的是已開始的進度（沒有回到歡迎畫面）', pg.query_selector('[data-act="start"]') is None)
    # loadSave()：手動以雲端取代本機（本機會先備份）
    pg.evaluate("() => { window.__cg.state.profile.hero = '本機暫時的名字'; window.__cg.render(); }")
    r = pg.evaluate('async () => { await window.__cloud.flushNow(); return window.__cloud.loadSave(); }')
    check('loadSave() 讀取雲端存檔成功', r and r.get('ok') is True, r)
    check('loadSave() 之後本機 = 雲端', mstate(pg) == cloud_save(m['playerId'])['state'])
    ctx.close()


# =====================================================================
#  5–9 遊戲進度存檔
# =====================================================================
@test
def t03_progress_saved():
    """t03 角色升級、好感度、道具與貨幣、任務與成就、對話及回憶存檔"""
    ctx = new_ctx()
    pg = open_game(ctx)
    start_game(pg)
    base = mstate(pg)
    for d in range(11, 19):
        play_day(pg, f'2026-11-{d:02d}')
    wait_synced(pg)
    st = mstate(pg)
    m = meta(pg)
    row = cloud_save(m['playerId'])
    cs = row['state']
    check('8 天的進度全部同步：雲端 = 本機完整狀態', cs == st, first_diff(cs, st))
    check('角色升級存檔（等級 ≥ 2，雲端等級欄位一致）', st['player']['level'] >= 2 and cs['player'] == st['player'] and row['player_level'] == st['player']['level'], st['player'])
    check('技能點與已學技能存檔', cs['player']['skills'] == st['player']['skills'] and len(st['player']['skills']) >= 1, st['player']['skills'])
    check('好感度變化存檔（媽媽／爸爸／妹妹）', cs['bonds'] == st['bonds'] and st['bonds'] != base['bonds'], {k: v.get('aff') for k, v in st['bonds'].items()})
    check('道具與貨幣存檔（items、經驗值、技能點）', cs['items'] == st['items'] and cs['player']['exp'] == st['player']['exp'] and cs['player']['sp'] == st['player']['sp'], st['items'])
    check('任務、挑戰與成就存檔', cs['achievements'] == st['achievements'] and len(st['achievements']) >= 1 and cs['tasks'] == st['tasks'] and cs['weekly'] == st['weekly'] and cs['counters'] == st['counters'] and cs['streak'] == st['streak'], list(st['achievements']))
    check('每日紀錄與結算存檔', cs['days'] == st['days'] and cs['settledThrough'] == st['settledThrough'] == '2026-11-18', st.get('settledThrough'))
    check('對話與回憶存檔（紀念冊、妹妹訊息、日誌、收藏）', cs['album'] == st['album'] and cs['shares'] == st['shares'] and cs['log'] == st['log'] and cs['collection'] == st['collection'] and len(st['album']) >= 3, (len(st['album']), len(st['shares'])))
    mem = sql("select kind, memory_key from public.memories where save_id = $1", row['id'])
    by = {}
    for x in mem:
        by.setdefault(x['kind'], set()).add(x['memory_key'])
    check('回憶表：每一張紀念冊劇情都有一筆紀錄', set(st['album']) <= by.get('story', set()), set(st['album']) - by.get('story', set()))
    check('回憶表：每一枚徽章都有一筆紀錄', set(st['achievements']) <= by.get('achievement', set()))
    check('回憶表：收藏、妹妹訊息、日誌都有紀錄', set(st['collection']) <= by.get('collection', set()) and len(by.get('share', ())) >= len({(s['d'], s['t']) for s in st['shares']}) and len(by.get('log', ())) >= 1, {k: len(v) for k, v in by.items()})
    pg.click('#cloud-pill')
    pg.wait_for_function("() => { const el = document.querySelector('[data-cloud-memories]'); return el && /劇情/.test(el.textContent); }", timeout=10000)
    check('雲端存檔面板顯示雲端回憶數量', '劇情' in pg.inner_text('[data-cloud-memories]'), pg.inner_text('[data-cloud-memories]'))
    pg.click('[data-cloud="close"]')
    snaps = sql('select count(*)::int as n from public.save_snapshots where save_id = $1', row['id'])[0]['n']
    check('每日結算前雲端自動備份上一版（save_snapshots）', snaps >= 1, snaps)
    ctx.close()


# =====================================================================
#  10 角色外觀與照片
# =====================================================================
@test
def t04_photos():
    """t04 角色外觀與照片存檔（Storage、快取、匯出、舊照片保護）"""
    ctx = new_ctx()
    pg = open_game(ctx)
    start_game(pg)
    wait_synced(pg)
    m = meta(pg)
    upload_photo(pg, 'mom', png(TMP / 'mom1.png', (200, 120, 80)))
    pg.wait_for_function("() => { const p = window.__cg.state.profile; return p.photoRefs && p.photoRefs.mom && !(p.photos && p.photos.mom); }", timeout=20000)
    wait_synced(pg)
    st = mstate(pg)
    ref = st['profile']['photoRefs']['mom']
    objs = sql("select name, owner::text, metadata from storage.objects where bucket_id = 'player-photos'")
    check('照片上傳到玩家專屬路徑 player-photos/<玩家編號>/mom-<雜湊>.jpg', len(objs) == 1 and objs[0]['name'] == ref['path'] and re.match(rf"^{m['playerId']}/mom-[0-9a-f]{{16}}\.jpg$", ref['path']), objs)
    check('Storage 物件的擁有者是這位匿名使用者', objs and objs[0]['owner'] == m['userId'])
    row = cloud_save(m['playerId'])
    check('雲端存檔只存照片路徑，不存大型 Base64', 'mom' not in row['state']['profile'].get('photos', {}) and row['state']['profile']['photoRefs']['mom']['path'] == ref['path'] and 'data:image' not in json.dumps(row['state']), row['size_bytes'])
    check('上傳後雲端 = 本機', row['state'] == st, first_diff(row['state'], st))

    def mom_img_ok():
        pg.click('[data-act="tab:bonds"]')
        pg.wait_for_function("() => [...document.querySelectorAll('img')].some(i => i.src.startsWith('data:image/jpeg') && i.complete && i.naturalWidth > 0)", timeout=15000)
        return True
    check('畫面顯示上傳的照片（羈絆頁）', mom_img_ok())
    # 外觀設定
    pg.click('[data-act="tab:settings"]')
    pg.check('input[data-bind="avatarStyle"][value="svg"]')
    pg.wait_for_timeout(200)
    wait_synced(pg)
    check('角色外觀設定（頭像風格）存檔', cloud_save(m['playerId'])['state']['profile']['avatarStyle'] == 'svg')
    pg.click('[data-act="tab:settings"]')
    pg.check('input[data-bind="avatarStyle"][value="toon"]')
    wait_synced(pg)
    # 清掉本機照片快取 → 重新開啟 → 從 Storage 下載
    pg.evaluate("() => localStorage.removeItem('morning-bond:photo-cache:main')")
    open_game(None, '2026-11-11', '21:30', page=pg)
    wait_ready(pg)
    check('本機沒有快取時，自動從 Storage 下載並顯示照片', mom_img_ok())
    # 匯出：照片變回 data URL，格式與單檔版相同
    data, _ = export_json(pg)
    check('匯出 JSON 內含照片（data URL），不含雲端路徑', str(data['profile'].get('photos', {}).get('mom', '')).startswith('data:image/jpeg') and 'photoRefs' not in data['profile'], list(data['profile'].keys()))
    rest_a = {k: v for k, v in data.items() if k != 'profile'}
    rest_b = {k: v for k, v in mstate(pg).items() if k != 'profile'}
    check('匯出 JSON 其他欄位與目前進度完全相同', rest_a == rest_b, first_diff(rest_a, rest_b))
    if OLD_GAME:
        ctx_old = new_ctx()
        po = new_page(ctx_old, ':old')
        po.goto(OLD_GAME + '?date=2026-11-11')
        import_json(po, data)
        old_photo = po.evaluate('() => window.__cg.state.profile.photos.mom || ""')
        check('匯出的 JSON 匯入 v1.1 單檔版，照片仍在', old_photo == data['profile']['photos']['mom'])
        ctx_old.close()
    # 換照片：新照片上傳後，沒被任何存檔／備份引用的舊照片才刪除
    old_path = ref['path']
    upload_photo(pg, 'mom', png(TMP / 'mom2.png', (60, 140, 220)))
    pg.wait_for_function(f"() => {{ const r = window.__cg.state.profile.photoRefs; return r && r.mom && r.mom.path !== {json.dumps(old_path)} && !window.__cg.state.profile.photos.mom; }}", timeout=20000)
    wait_synced(pg)
    new_path = mstate(pg)['profile']['photoRefs']['mom']['path']
    used = sql("select distinct r.value->>'path' as p from public.save_snapshots s, jsonb_each(coalesce(s.state->'profile'->'photoRefs', '{}'::jsonb)) r where s.save_id = $1", row['id'])
    pg.wait_for_timeout(800)
    names = {o['name'] for o in sql("select name from storage.objects where bucket_id = 'player-photos'")}
    if any(u['p'] == old_path for u in used):
        check('舊照片仍被雲端備份引用 → 保留（還原備份時照片不會不見）', old_path in names and new_path in names, names)
    else:
        check('舊照片沒有任何存檔或備份引用 → 已從 Storage 刪除', old_path not in names and new_path in names, names)
    # 結算一天（雲端會備份目前含 new_path 的版本），再換照片 → new_path 必須保留
    play_today(pg)
    wait_synced(pg)
    upload_photo(pg, 'mom', png(TMP / 'mom3.png', (30, 200, 90)))
    pg.wait_for_function(f"() => {{ const r = window.__cg.state.profile.photoRefs; return r && r.mom && r.mom.path !== {json.dumps(new_path)} && !window.__cg.state.profile.photos.mom; }}", timeout=20000)
    wait_synced(pg)
    pg.wait_for_timeout(800)
    names = {o['name'] for o in sql("select name from storage.objects where bucket_id = 'player-photos'")}
    pend = meta(pg)['pendingPhotoDeletes']
    check('被雲端備份引用的舊照片不會被刪除，留在待刪清單', new_path in names and new_path in pend, (names, pend))
    # 備份輪替掉之後才真的刪除
    sql('delete from public.save_snapshots where save_id = $1', row['id'])
    pg.evaluate('() => window.__cloud._processPhotoDeletes({ force: true })')
    pg.wait_for_function(f"() => !window.__cloud.meta.pendingPhotoDeletes.includes({json.dumps(new_path)})", timeout=10000)
    names = {o['name'] for o in sql("select name from storage.objects where bucket_id = 'player-photos'")}
    check('備份不再引用之後，舊照片才從 Storage 刪除', new_path not in names and len(names) >= 1, names)
    # 移除照片
    pg.click('[data-act="tab:settings"]')
    pg.click('[data-act="delphoto:mom"]')
    wait_synced(pg)
    check('移除照片後雲端存檔不再引用照片', 'mom' not in (cloud_save(m['playerId'])['state']['profile'].get('photoRefs') or {}))
    # 上傳失敗（非網路錯誤）→ 照片先留在存檔內（Base64），不會遺失；之後再補上傳
    fail(r'/storage/v1/object/player-photos/', 'error', times=1, status=500, method='POST')
    upload_photo(pg, 'dad', png(TMP / 'dad.png', (90, 90, 160)))
    wait_synced(pg)
    cs = cloud_save(m['playerId'])['state']
    check('照片上傳失敗時以 Base64 保留在存檔（不遺失）', str(cs['profile'].get('photos', {}).get('dad', '')).startswith('data:image/jpeg'))
    pg.click('[data-act="tab:settings"]')
    pg.check('input[data-bind="voice"]') if not pg.is_checked('input[data-bind="voice"]') else pg.uncheck('input[data-bind="voice"]')
    pg.wait_for_function("() => { const r = window.__cg.state.profile.photoRefs; return r && r.dad; }", timeout=20000)
    wait_synced(pg)
    cs = cloud_save(m['playerId'])['state']
    check('下次同步時自動補上傳，存檔改存路徑', 'dad' in (cs['profile'].get('photoRefs') or {}) and 'dad' not in cs['profile'].get('photos', {}))
    ctx.close()


# =====================================================================
#  11 關閉瀏覽器後重新開啟
# =====================================================================
@test
def t05_reopen_browser():
    """t05 關閉瀏覽器後重新開啟（同一個匿名身分、權杖過期自動更新）"""
    emu('config', {'accessTtl': 4})
    udir = tempfile.mkdtemp(prefix='mb-profile-')
    p = PW['p']
    ctx = p.chromium.launch_persistent_context(udir, executable_path=CHROME, args=['--no-sandbox'], viewport={'width': 1200, 'height': 900})
    pg = open_game(ctx, page=ctx.pages[0] if ctx.pages else None)
    start_game(pg)
    play_today(pg)
    wait_synced(pg)
    m1, s1 = meta(pg), mstate(pg)
    ctx.close()
    time.sleep(5)  # 讓 access token 過期
    ctx = p.chromium.launch_persistent_context(udir, executable_path=CHROME, args=['--no-sandbox'], viewport={'width': 1200, 'height': 900})
    pg = open_game(ctx, '2026-11-11', '21:45', page=ctx.pages[0] if ctx.pages else None)
    wait_ready(pg)
    m2 = meta(pg)
    check('重新開啟後恢復同一個匿名身分', m2['userId'] == m1['userId'] and m2['playerId'] == m1['playerId'], (m1['userId'], m2['userId']))
    check('沒有建立新的匿名使用者', len(sql('select 1 from auth.users')) == 1)
    check('重新開啟後進度完整（與關閉前逐欄位相同）', mstate(pg) == s1, first_diff(mstate(pg), s1))
    play_day(pg, '2026-11-12')
    wait_synced(pg)
    log = emu_log()
    check('權杖過期後自動以 refresh token 更新', any('/auth/v1/token' in e['path'] for e in log))
    row = cloud_save(m1['playerId'])
    check('重新開啟後的新進度照常同步到同一份雲端存檔', row['state'] == mstate(pg) and row['settled_through'] == '2026-11-12', first_diff(row['state'], mstate(pg)))
    check('只有一份雲端存檔', len(sql('select 1 from public.game_saves')) == 1)
    ctx.close()
    emu('config', {'accessTtl': 3600})


# =====================================================================
#  12 網路中斷及恢復
# =====================================================================
@test
def t06_offline_recovery():
    """t06 網路中斷及恢復（離線、伺服器錯誤、回應遺失、背景補存、開機連不上）"""
    ctx = new_ctx()
    pg = open_game(ctx)
    start_game(pg)
    wait_synced(pg)
    m = meta(pg)
    rev0 = cloud_save(m['playerId'])['revision']
    ctx.set_offline(True)
    wait_status(pg, 'offline')
    check('斷線時顯示「離線模式」', '離線模式' in pill(pg), pill(pg))
    play_today(pg)
    pg.wait_for_timeout(1200)
    check('離線時仍可遊玩，進度存在本機並標記「待同步」', meta(pg)['dirty'] is True and '待同步' in pill(pg) and pg.evaluate(f"() => JSON.parse(localStorage.getItem('{SAVE_KEY}')).settledThrough") == '2026-11-11', pill(pg))
    check('離線期間雲端沒有被改動', cloud_save(m['playerId'])['revision'] == rev0)
    check('待同步標記也存在 localStorage（關閉頁面也不會遺失）', pg.evaluate("() => JSON.parse(localStorage.getItem('morning-bond:cloud-meta:main')).dirty") is True)
    ctx.set_offline(False)
    wait_synced(pg)
    check('恢復連線後自動補傳', cloud_save(m['playerId'])['state'] == mstate(pg))
    # 伺服器暫時錯誤 → 顯示同步失敗 → 自動重試成功
    fail(r'/rpc/update_game_save$', 'error', times=2, status=503)
    pg.evaluate("() => { window.__cg.state.profile.hero = '測試503'; window.__cg.render(); }")
    wait_status(pg, 'error', 10000)
    check('伺服器錯誤時顯示「同步失敗」', '同步失敗' in pill(pg), pill(pg))
    wait_synced(pg, 30000)
    check('自動重試後成功（進度沒有遺失）', cloud_save(m['playerId'])['state']['profile']['hero'] == '測試503')
    # 回應遺失（伺服器已寫入，瀏覽器沒收到）→ 用同一個 op_id 重送，不會重複寫入
    rev1 = cloud_save(m['playerId'])['revision']
    ops = []
    on_req = lambda r: ops.append(r.post_data_json) if r.url.endswith('/rpc/update_game_save') and r.method == 'POST' else None
    pg.on('request', on_req)
    fail(r'/rpc/update_game_save$', 'error-after', times=1, status=502)
    pg.evaluate("() => { window.__cg.state.profile.hero = '回應遺失'; window.__cg.render(); }")
    wait_synced(pg, 30000)
    pg.remove_listener('request', on_req)
    row = cloud_save(m['playerId'])
    check('伺服器已寫入但回報失敗 → 重送後雲端只前進一個版本（不重複套用）', row['revision'] == rev1 + 1 and row['state']['profile']['hero'] == '回應遺失', (rev1, row['revision']))
    check('重送沿用同一個操作編號與基準版本（idempotency）', len(ops) >= 2 and ops[0]['p_op_id'] == ops[1]['p_op_id'] and ops[0]['p_base_revision'] == ops[1]['p_base_revision'] and row['last_op_id'] == ops[0]['p_op_id'], [(o['p_op_id'][:8], o['p_base_revision']) for o in ops])
    # 伺服器已寫入但回報失敗，而且重試前本機又有新的變更 → 仍認得那一版是自己寫的，不會跳出衝突
    fail(r'/rpc/update_game_save$', 'error-after', times=1, status=502)
    pg.evaluate("() => { window.__cg.state.profile.hero = '回報失敗後又改1'; window.__cg.render(); }")
    pg.wait_for_function("() => window.__cloud.status === 'error'", timeout=10000)
    pg.evaluate("() => { window.__cg.state.profile.hero = '回報失敗後又改2'; window.__cg.render(); }")
    wait_synced(pg, 30000)
    check('回報失敗後本機又改：不會誤判成衝突，最新進度上傳', not pg.is_visible('#cloud-modal') and cloud_save(m['playerId'])['state'] == mstate(pg) and mstate(pg)['profile']['hero'] == '回報失敗後又改2')
    # 連線在伺服器寫入後中斷（瀏覽器可能自動重送同一個請求）→ 伺服器以操作編號辨識，不會重複套用
    rev2 = cloud_save(m['playerId'])['revision']
    t_drop = int(time.time() * 1000)
    fail(r'/rpc/update_game_save$', 'drop-after', times=1)
    pg.evaluate("() => { window.__cg.state.profile.hero = '連線中斷'; window.__cg.render(); }")
    wait_synced(pg, 30000)
    row = cloud_save(m['playerId'])
    got = [e for e in emu_log() if e['path'].endswith('/rpc/update_game_save') and e['t'] >= t_drop]
    check('連線中斷後：伺服器收到重送但只前進一個版本', row['revision'] == rev2 + 1 and row['state']['profile']['hero'] == '連線中斷' and len(got) >= 2, (rev2, row['revision'], len(got)))
    # 伺服器已寫入、但這台裝置沒拿到結果就重新整理，重新整理後又繼續玩 → 不可以誤判成兩台裝置衝突
    fail(r'/rpc/update_game_save$', 'error-after', times=1, status=502)
    pg.evaluate("() => { window.__cg.state.profile.hero = '送出後重新整理'; window.__cg.render(); }")
    pg.wait_for_function("() => window.__cloud.status === 'error' && window.__cloud.meta.recentOps.length > 0", timeout=10000)
    check('（準備）雲端已寫入但這台裝置以為失敗', cloud_save(m['playerId'])['state']['profile']['hero'] == '送出後重新整理')
    open_game(None, '2026-11-11', '21:30', page=pg)
    pg.evaluate("() => { window.__cg.state.profile.hero = '重新整理後又改'; window.__cg.render(); }")
    wait_synced(pg, 30000)
    check('重新整理前送出的寫入被認出是自己的，不會跳出衝突', pg.evaluate('() => window.__cloud.status') == 'synced' and not pg.is_visible('#cloud-modal'))
    check('重新整理後的最新進度正確上傳', cloud_save(m['playerId'])['state'] == mstate(pg) and mstate(pg)['profile']['hero'] == '重新整理後又改')
    # 同一時間只有一個寫入請求（請求延遲時連續操作）
    fail(r'/rpc/update_game_save$', 'delay', times=3, delay_ms=1200)
    pg.evaluate("() => { window.__cg.state.profile.hero = '同步中'; window.__cg.render(); }")
    pg.wait_for_function("() => /雲端同步中/.test(document.getElementById('cloud-pill').textContent)", timeout=8000)
    check('上傳中顯示「雲端同步中」', '雲端同步中' in pill(pg), pill(pg))
    t0 = int(time.time() * 1000)
    for i in range(6):
        pg.evaluate(f"() => {{ window.__cg.state.profile.hero = '連續{i}'; window.__cg.render(); }}")
        pg.wait_for_timeout(450)
    wait_synced(pg, 30000)
    ups = sorted([e for e in emu_log() if e['path'].endswith('/rpc/update_game_save') and e['t'] >= t0], key=lambda e: e['t'])
    overlap = any(b['t'] < a['end'] for a, b in zip(ups, ups[1:]))
    check('寫入請求不會同時進行（沒有互相覆蓋）', ups and not overlap, [(e['t'] - t0, e['end'] - t0) for e in ups])
    check('最後雲端是最新的本機進度', cloud_save(m['playerId'])['state'] == mstate(pg) and mstate(pg)['profile']['hero'] == '連續5')
    ctx.close()

    # visibilitychange／pagehide：不等 debounce，立即補存
    ctx = new_ctx()
    pg = open_game(ctx, url=GAME_SLOW)
    start_game(pg)
    wait_synced(pg)
    m = meta(pg)
    rev = cloud_save(m['playerId'])['revision']
    pg.evaluate("() => { window.__cg.state.profile.hero = '切到背景'; window.__cg.render(); }")
    pg.wait_for_timeout(1500)
    check('（慢速設定）debounce 期間尚未上傳', cloud_save(m['playerId'])['revision'] == rev)
    pg.evaluate("() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); }")
    pg.wait_for_timeout(1500)
    check('切到背景（visibilitychange → hidden）立即補存', cloud_save(m['playerId'])['state']['profile']['hero'] == '切到背景')
    pg.evaluate("() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); window.__cg.state.profile.hero = '關閉分頁'; window.__cg.render(); window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false })); }")
    pg.wait_for_timeout(1500)
    check('pagehide 也會補存', cloud_save(m['playerId'])['state']['profile']['hero'] == '關閉分頁')
    # 關閉前來不及上傳 → 下次開啟自動補傳（不只靠 beforeunload）
    fail(r'/rpc/update_game_save$', 'drop', times=5)
    pg.evaluate("() => { window.__cg.state.profile.hero = '來不及上傳'; window.__cg.render(); }")
    pg.close()
    emu('clear-fail')
    pg = open_game(ctx, '2026-11-11', '21:30', url=GAME_SLOW)
    wait_synced(pg)
    check('關閉前沒上傳成功的進度，下次開啟自動補傳', cloud_save(m['playerId'])['state']['profile']['hero'] == '來不及上傳')
    ctx.close()

    # 開機時連不上雲端 → 不卡住，可先離線遊玩 → 之後自動連上並建立雲端存檔
    fail(r'^/auth/v1/', 'drop', times=4)
    ctx = new_ctx()
    pg = open_game(ctx)
    pg.wait_for_function("() => ['offline', 'error'].includes(window.__cloud.status)", timeout=20000)
    gate_closed(pg)
    check('開機連不上雲端時顯示離線，遊戲照常可以開始', '離線' in pill(pg) or '同步失敗' in pill(pg), pill(pg))
    pg.click('[data-act="start"]')
    pg.wait_for_timeout(150)
    dismiss(pg)
    wait_synced(pg, 60000)
    m = meta(pg)
    check('連線恢復後自動建立匿名身分與雲端存檔', m['userId'] and cloud_save(m['playerId']) is not None and cloud_save(m['playerId'])['state'] == mstate(pg))
    ctx.close()


# =====================================================================
#  13 舊版 localStorage 遷移
# =====================================================================
def make_legacy(ctx, days=3, photo=True):
    """在同一個網域用「本機模式」玩幾天，產生舊版 localStorage 存檔（與單檔版格式相同）。"""
    pg = new_page(ctx, ':legacy')
    pg.goto(f'{GAME_LOCAL}?date=2026-11-11&time=09:30')
    pg.wait_for_function('() => !!window.__cg')
    pg.click('[data-act="start"]')
    pg.wait_for_timeout(150)
    dismiss(pg)
    if photo:
        upload_photo(pg, 'sis', png(TMP / 'sis.png', (240, 180, 200)))
        pg.click('[data-act="tab:today"]')
    for d in range(11, 11 + days):
        pg.goto(f'{GAME_LOCAL}?date=2026-11-{d:02d}&time=21:30')
        pg.wait_for_function('() => !!window.__cg')
        play_today(pg)
    raw = pg.evaluate(f"() => localStorage.getItem('{SAVE_KEY}')")
    st = mstate(pg)
    pg.close()
    return raw, st


@test
def t07_legacy_migration():
    """t07 舊版 localStorage 遷移（成功、失敗重試、部分成功、中斷、重複、版本不一致）"""
    # (a) 正常遷移
    ctx = new_ctx()
    raw, legacy = make_legacy(ctx)
    pg = open_game(ctx, '2026-11-14', '09:00')
    wait_synced(pg, 40000)
    m = meta(pg)
    st = mstate(pg)
    row = cloud_save(m['playerId'])
    check('偵測到舊版存檔並完整上傳（雲端 = 本機）', row is not None and row['state'] == st, row and first_diff(row['state'], st))
    check('遷移沒有重設進度（結算日、等級、羈絆、紀念冊都相同）', st['settledThrough'] == legacy['settledThrough'] == '2026-11-13' and st['player'] == legacy['player'] and st['bonds'] == legacy['bonds'] and st['album'] == legacy['album'])
    check('確認雲端寫入成功後才標記完成', m['migration']['status'] == 'done' and m['migration']['saveId'] == row['id'], m['migration'])
    check('上傳原因記為 migration', row['last_reason'] in ('migration',), row['last_reason'])
    check('舊的 localStorage 存檔沒有被刪除', pg.evaluate(f"() => localStorage.getItem('{SAVE_KEY}') !== null"))
    check('另外保存一份原封不動的舊存檔備份', pg.evaluate("() => localStorage.getItem('morning-bond:legacy-backup:main')") == raw)
    check('舊存檔的照片搬到 Storage，雲端只存路徑', 'sis' in (row['state']['profile'].get('photoRefs') or {}) and len(sql("select 1 from storage.objects")) == 1)
    check('舊存檔備份裡的照片原檔仍在', 'data:image/jpeg' in json.loads(pg.evaluate("() => localStorage.getItem('morning-bond:legacy-backup:main')"))['profile']['photos'].get('sis', ''))
    pg.wait_for_timeout(300)
    n_create = len(calls(emu_log(), '/rpc/create_game_save'))
    # (e) 重複遷移：重新開啟不會再上傳一次
    t0 = int(time.time() * 1000)
    open_game(None, '2026-11-14', '09:05', page=pg)
    wait_synced(pg)
    check('重新開啟不會重複遷移（沒有再建立存檔）', len(calls(emu_log(), '/rpc/create_game_save', t0)) == 0 and n_create == 1 and len(sql('select 1 from public.game_saves')) == 1)
    ctx.close()

    # (b) 上傳失敗 → 保留舊資料、可重試、之後自動完成
    emu('reset')
    ctx = new_ctx()
    raw, legacy = make_legacy(ctx, days=2, photo=False)
    fail(r'/rpc/create_game_save$', 'error', times=2, status=503)
    pg = open_game(ctx, '2026-11-13', '09:00')
    pg.wait_for_function("() => window.__cloud.meta.migration && window.__cloud.meta.migration.attempts >= 1 && window.__cloud.status === 'error'", timeout=20000)
    m = meta(pg)
    check('上傳失敗：遷移狀態維持 pending（未標記完成）', m['migration']['status'] == 'pending', m['migration'])
    check('上傳失敗：舊資料完整保留、遊戲照常可玩', pg.evaluate(f"() => localStorage.getItem('{SAVE_KEY}') !== null") and mstate(pg)['settledThrough'] == legacy['settledThrough'] and pg.query_selector('[data-act="start"]') is None)
    check('上傳失敗時顯示「同步失敗」', '同步失敗' in pill(pg), pill(pg))
    wait_synced(pg, 40000)
    m = meta(pg)
    check('自動重試後遷移完成', m['migration']['status'] == 'done' and cloud_save(m['playerId'])['state'] == mstate(pg), m['migration'])
    check('重試多次也只有一份雲端存檔', len(sql('select 1 from public.game_saves')) == 1)
    ctx.close()

    # (c) 部分成功：伺服器已建立，但回應在路上遺失
    emu('reset')
    ctx = new_ctx()
    raw, legacy = make_legacy(ctx, days=2, photo=False)
    fail(r'/rpc/create_game_save$', 'drop-after', times=1)
    pg = open_game(ctx, '2026-11-13', '09:00')
    wait_synced(pg, 40000)
    m = meta(pg)
    rows = sql('select id::text as id, revision::int as revision from public.game_saves')
    check('部分成功：不會產生第二份存檔，也不會覆蓋', len(rows) == 1 and rows[0]['revision'] == 1, rows)
    check('部分成功：重新比對後標記遷移完成', m['migration']['status'] == 'done' and m['saveId'] == rows[0]['id'], m['migration'])
    check('部分成功：雲端 = 本機', cloud_save(m['playerId'])['state'] == mstate(pg))
    ctx.close()

    # (c2) 部分成功：伺服器已建立，但回報錯誤 → 以同一個操作編號重送
    emu('reset')
    ctx = new_ctx()
    raw, legacy = make_legacy(ctx, days=1, photo=False)
    fail(r'/rpc/create_game_save$', 'error-after', times=1, status=502)
    pg = open_game(ctx, '2026-11-12', '09:00')
    wait_synced(pg, 40000)
    m = meta(pg)
    rows = sql('select id::text as id, revision::int as revision from public.game_saves')
    check('部分成功（伺服器已建立但回報錯誤）：仍只有一份存檔、遷移完成', len(rows) == 1 and m['migration']['status'] == 'done' and cloud_save(m['playerId'])['state'] == mstate(pg), (rows, m['migration']))
    ctx.close()

    # (d) 網路中斷：上傳途中關閉頁面
    emu('reset')
    ctx = new_ctx()
    raw, legacy = make_legacy(ctx, days=2, photo=False)
    fail(r'/rpc/create_game_save$', 'drop', times=1)
    pg = open_game(ctx, '2026-11-13', '09:00')
    pg.wait_for_function("() => window.__cloud.meta.migration && window.__cloud.meta.migration.attempts >= 1", timeout=20000)
    pg.close()
    pg = open_game(ctx, '2026-11-13', '09:10')
    wait_synced(pg, 40000)
    m = meta(pg)
    check('中斷後重新開啟：遷移接著完成', m['migration']['status'] == 'done' and len(sql('select 1 from public.game_saves')) == 1 and cloud_save(m['playerId'])['state'] == mstate(pg), m['migration'])
    check('中斷後重新開啟：進度沒有被重設', mstate(pg)['settledThrough'] == legacy['settledThrough'])
    ctx.close()

    # (g) 資料版本不一致：v1 舊存檔（還有體育課）→ 先跑原本的 migrate() 升級成 v2 再上傳
    emu('reset')
    ctx = new_ctx()
    raw, legacy = make_legacy(ctx, days=2, photo=False)
    v1 = json.loads(raw)
    v1['version'] = 1
    v1['schedule'].append({'id': 's7', 'name': '男生體育', 'day': 4, 'start': '10:10', 'end': '12:00', 'room': '體育館', 'diff': 1, 'guardian': 'dad', 'parity': 'all', 'from': '', 'to': '', 'note': ''})
    v1['album'].pop('sisPlan', None)
    v1['collection'].pop('plan', None)
    pg = new_page(ctx)
    pg.goto(f'{GAME_LOCAL}?date=2026-11-13')
    pg.evaluate(f"(raw) => localStorage.setItem('{SAVE_KEY}', raw)", json.dumps(v1, ensure_ascii=False))
    pg.evaluate("() => { localStorage.removeItem('morning-bond:legacy-backup:main'); }")
    open_game(None, '2026-11-13', '09:00', page=pg)
    wait_synced(pg, 40000)
    m = meta(pg)
    cs = cloud_save(m['playerId'])
    check('v1 舊存檔先升級成 v2 才上傳（版本 2、體育課移除）', cs['state']['version'] == 2 and cs['state_version'] == 2 and not any('體育' in c['name'] for c in cs['state']['schedule']))
    check('升級時保留原本進度', cs['state']['settledThrough'] == legacy['settledThrough'] and cs['state']['player'] == legacy['player'])
    check('升級補上的劇情（兩張課表）也在雲端', 'sisPlan' in cs['state']['album'])
    check('v1 原始資料仍保存在舊存檔備份', json.loads(pg.evaluate("() => localStorage.getItem('morning-bond:legacy-backup:main')"))['version'] == 1)
    ctx.close()

    # (h) 已經有雲端存檔時，空白存檔不會覆蓋雲端
    emu('reset')
    ctx = new_ctx()
    pg = open_game(ctx)
    start_game(pg)
    play_today(pg)
    wait_synced(pg)
    m = meta(pg)
    good = cloud_save(m['playerId'])
    pg.evaluate(f"() => localStorage.setItem('{SAVE_KEY}', JSON.stringify(Object.assign(window.__cg.defaultState(), {{ started: false }})))")
    open_game(None, '2026-11-12', '09:00', page=pg)
    wait_ready(pg)
    pg.wait_for_function('() => window.__cg.state.started === true', timeout=15000)
    wait_synced(pg)
    after = cloud_save(m['playerId'])
    check('本機變成空白存檔時，不會用空白覆蓋雲端，而是讀回雲端進度', after['state']['started'] is True and after['state']['settledThrough'] == good['state']['settledThrough'] and mstate(pg)['settledThrough'] == good['state']['settledThrough'])
    r = pg.evaluate("""async () => { const m = window.__cloud; const blank = window.__cg.defaultState();
        try { await m.api.updateSave(m.meta.saveId, blank, m.meta.revision, { checksum: null, clientId: 'test', reason: 'autosave', opId: crypto.randomUUID() }); return 'accepted'; }
        catch (e) { return e.message; } }""")
    check('伺服器端也拒絕用空白存檔覆蓋已開始的存檔（refuse_blank_overwrite）', 'refuse_blank_overwrite' in str(r), r)
    ctx.close()


# =====================================================================
#  14 JSON 匯入及匯出
# =====================================================================
@test
def t08_json_import_export():
    """t08 JSON 匯入及匯出（與 v1.1 單檔版互通、匯入前自動備份）"""
    ctx = new_ctx()
    pg = open_game(ctx)
    start_game(pg)
    play_today(pg)
    wait_synced(pg)
    m = meta(pg)
    data, fname = export_json(pg)
    st = mstate(pg)
    check('匯出檔名與單檔版相同格式', re.match(r'^晨光羈絆存檔-\d{4}-\d{2}-\d{2}\.json$', fname) is not None, fname)
    check('匯出內容 = 目前完整進度（沒有照片時逐欄位相同）', data == st, first_diff(data, st))
    data2, _ = export_json(pg, '[data-cloud="export"]') if pg.click('#cloud-pill') is None else (None, None)
    check('雲端面板的「匯出存檔 JSON」內容相同', data2 == data)
    pg.click('[data-cloud="close"]') if pg.is_visible('[data-cloud="close"]') else None
    # 匯入另一份進度（單檔版格式）
    ctx2 = new_ctx()
    other = None
    if OLD_GAME:
        po = new_page(ctx2, ':old')
        po.goto(OLD_GAME + '?date=2026-11-11&time=21:30')
        po.click('[data-act="start"]')
        po.wait_for_timeout(150)
        dismiss(po)
        po.evaluate("() => { window.__cg.state.profile.hero = '單檔版玩家'; window.__cg.render(); }")
        play_today(po)
        other, _ = export_json(po)
        src = 'v1.1 單檔版'
    else:
        po = new_page(ctx2, ':local')
        po.goto(f'{GAME_LOCAL}?date=2026-11-11&time=21:30')
        po.click('[data-act="start"]')
        po.wait_for_timeout(150)
        dismiss(po)
        po.evaluate("() => { window.__cg.state.profile.hero = '單檔版玩家'; window.__cg.render(); }")
        play_today(po)
        other, _ = export_json(po)
        src = '本機模式（與單檔版相同格式）'
    ctx2.close()
    rev = cloud_save(m['playerId'])['revision']
    import_json(pg, other)
    pg.wait_for_function("() => window.__cg.state.profile.hero === '單檔版玩家'", timeout=10000)
    wait_synced(pg)
    row = cloud_save(m['playerId'])
    check(f'{src} 匯出的 JSON 可以匯入雲端版', mstate(pg)['profile']['hero'] == '單檔版玩家')
    check('匯入後立即同步到雲端（原因記為 import）', row['state'] == mstate(pg) and row['last_reason'] == 'import' and row['revision'] > rev, row['last_reason'])
    snaps = sql("select state from public.save_snapshots where save_id = $1 and reason = 'import' order by created_at desc", row['id'])
    check('匯入前的雲端進度自動備份（可在雲端備份還原）', any(s['state'] == st for s in snaps), len(snaps))
    check('匯入前的進度也在本機留一份備份', any(b.get('state') == st or b.get('data') == st for b in local_backups(pg)), [list(b.keys()) for b in local_backups(pg)][:2])
    # 格式錯誤的檔案：拒絕、什麼都不改
    rev2 = row['revision']
    import_json(pg, {'hello': 'world'})
    pg.wait_for_timeout(1500)
    check('格式錯誤的 JSON 不會被匯入，雲端也不變', mstate(pg)['profile']['hero'] == '單檔版玩家' and cloud_save(m['playerId'])['revision'] == rev2)
    if OLD_GAME:
        data3, _ = export_json(pg)
        ctx3 = new_ctx()
        po = new_page(ctx3, ':old')
        po.goto(OLD_GAME + '?date=2026-11-11&time=21:45')
        import_json(po, data3)
        check('雲端版匯出的 JSON 匯入 v1.1 單檔版後內容相同', mstate(po) == data3, first_diff(mstate(po), data3))
        ctx3.close()
    ctx.close()


# =====================================================================
#  15 不同瀏覽器的匿名身分隔離、16 RLS
# =====================================================================
@test
def t09_identity_isolation_and_rls():
    """t09 不同瀏覽器的匿名身分隔離＋RLS 權限（透過真正的 supabase-js 用戶端）"""
    ca, cb = new_ctx(), new_ctx()
    pa, pb = open_game(ca, label=':A'), open_game(cb, label=':B')
    start_game(pa)
    pa.evaluate("() => { window.__cg.state.profile.hero = '玩家A'; window.__cg.render(); }")
    upload_photo(pa, 'mom', png(TMP / 'a.png'))
    start_game(pb) if pb.query_selector('[data-act="start"]') else None
    pb.evaluate("() => { window.__cg.state.profile.hero = '玩家B'; window.__cg.render(); }")
    pa.wait_for_function("() => window.__cg.state.profile.photoRefs && window.__cg.state.profile.photoRefs.mom", timeout=20000)
    wait_synced(pa)
    wait_synced(pb)
    ma, mb = meta(pa), meta(pb)
    check('兩個瀏覽器各自建立不同的匿名身分與玩家', ma['userId'] != mb['userId'] and ma['playerId'] != mb['playerId'])
    check('兩份雲端存檔互不影響', cloud_save(ma['playerId'])['state']['profile']['hero'] == '玩家A' and cloud_save(mb['playerId'])['state']['profile']['hero'] == '玩家B')
    a_save = cloud_save(ma['playerId'])
    a_photo = mstate(pa)['profile']['photoRefs']['mom']['path']
    r = pb.evaluate("""async ([aSave, aPlayer, aPhoto]) => {
      const sb = window.__cloud.auth.client, out = {};
      const all = await sb.from('game_saves').select('id, player_id'); out.selectAll = (all.data || []).map(x => x.player_id);
      const one = await sb.from('game_saves').select('id').eq('id', aSave); out.selectA = (one.data || []).length;
      const up = await sb.from('game_saves').update({ slot: 'hack' }).eq('id', aSave).select(); out.updateA = up.error ? 'error' : (up.data || []).length;
      const del = await sb.from('game_saves').delete().eq('id', aSave).select(); out.deleteA = del.error ? 'error' : (del.data || []).length;
      const ins = await sb.from('game_saves').insert({ player_id: aPlayer, slot: 'hack', state: {} }); out.insertA = ins.error ? ins.error.message : 'ok';
      const upd = await sb.rpc('update_game_save', { p_save_id: aSave, p_state: { version: 2, started: true, profile: {}, settings: {}, player: {}, bonds: {}, items: {}, days: {}, schedule: [] }, p_base_revision: 1 }); out.rpcUpdate = upd.data || (upd.error && upd.error.message);
      const lst = await sb.rpc('list_save_snapshots', { p_save_id: aSave }); out.snapshots = lst.data;
      const mem = await sb.from('memories').select('player_id'); out.memories = [...new Set((mem.data || []).map(x => x.player_id))];
      const rc = await sb.from('recovery_codes').select('*'); out.recoveryCodes = rc.error ? 'denied' : (rc.data || []).length;
      const iss = await sb.rpc('recovery_issue', { p_user_id: '00000000-0000-0000-0000-000000000000', p_code_hash: 'a'.repeat(64) }); out.recoveryIssue = iss.error ? 'denied' : 'allowed';
      const dl = await sb.storage.from('player-photos').download(aPhoto); out.download = dl.error ? 'denied' : 'allowed';
      const upl = await sb.storage.from('player-photos').upload(aPlayer + '/mom-0123456789abcdef.jpg', new Blob([new Uint8Array([255, 216, 255])], { type: 'image/jpeg' })); out.uploadA = upl.error ? 'denied' : 'allowed';
      const rm = await sb.storage.from('player-photos').remove([aPhoto]); out.removeA = rm.error ? 'denied' : (rm.data || []).length;
      const anon = window.__cloud.auth.lib.createClient(window.__cloud.cfg.supabaseUrl, window.__cloud.cfg.supabasePublishableKey, { auth: { persistSession: false, autoRefreshToken: false } });
      const an = await anon.from('game_saves').select('*'); out.anonSelect = an.error ? 'denied' : (an.data || []).length;
      const ah = await anon.rpc('get_save_head', { p_slot: 'main' }); out.anonHead = ah.error ? 'denied' : 'allowed';
      const big = await sb.rpc('update_game_save', { p_save_id: window.__cloud.meta.saveId, p_state: 'not an object', p_base_revision: window.__cloud.meta.revision }); out.invalid = big.error ? big.error.message : JSON.stringify(big.data);
      return out; }""", [a_save['id'], ma['playerId'], a_photo])
    check('RLS：B 查詢 game_saves 只看得到自己的', r['selectAll'] == [mb['playerId']], r['selectAll'])
    check('RLS：B 用 A 的存檔編號查不到資料', r['selectA'] == 0, r)
    check('RLS：B 不能修改 A 的存檔', r['updateA'] in (0, 'error'), r['updateA'])
    check('RLS：B 不能刪除 A 的存檔', r['deleteA'] in (0, 'error') and cloud_save(ma['playerId']) is not None, r['deleteA'])
    check('RLS：B 不能替 A 新增存檔', r['insertA'] != 'ok', r['insertA'])
    check('RPC：B 用 update_game_save 改 A 的存檔 → not_found', isinstance(r['rpcUpdate'], dict) and r['rpcUpdate'].get('ok') is False, r['rpcUpdate'])
    check('RPC：B 看不到 A 的雲端備份', r['snapshots'] == [], r['snapshots'])
    check('RLS：回憶表只看得到自己的', r['memories'] in ([], [mb['playerId']]), r['memories'])
    check('復原代碼資料表前端完全無法讀取', r['recoveryCodes'] in ('denied', 0), r['recoveryCodes'])
    check('前端不能呼叫 service role 專用的 recovery_issue', r['recoveryIssue'] == 'denied')
    check('Storage RLS：B 不能下載 A 的照片', r['download'] == 'denied')
    check('Storage RLS：B 不能上傳到 A 的資料夾', r['uploadA'] == 'denied')
    check('Storage RLS：B 不能刪除 A 的照片', r['removeA'] in ('denied', 0) and len(sql('select 1 from storage.objects where name = $1', a_photo)) == 1, r['removeA'])
    check('沒有登入（只有 Publishable key）不能讀任何存檔', r['anonSelect'] in ('denied', 0) and r['anonHead'] == 'denied', (r['anonSelect'], r['anonHead']))
    check('資料驗證：格式錯誤的存檔被伺服器拒絕（invalid_state）', 'invalid_state' in str(r['invalid']), r['invalid'])
    check('A 的存檔完全沒有被 B 動到', cloud_save(ma['playerId'])['revision'] == a_save['revision'] and cloud_save(ma['playerId'])['state'] == a_save['state'])
    ca.close()
    cb.close()


# =====================================================================
#  17 存檔版本衝突
# =====================================================================
@test
def t10_version_conflict():
    """t10 存檔版本衝突（自動採用、兩邊都改 → 玩家選擇、兩份都保留）"""
    ca, cb = new_ctx(), new_ctx()
    pa = open_game(ca, label=':A')
    start_game(pa)
    play_today(pa)
    wait_synced(pa)
    code = recovery_code(pa)
    pb = open_game(cb, '2026-11-11', '21:30', label=':B')
    wait_ready(pb)
    gate_closed(pb)
    pb.evaluate('(c) => window.__cloud.redeemRecoveryCode(c)', code)
    wait_synced(pb)
    check('B 用復原代碼接回同一份存檔', meta(pb)['playerId'] == meta(pa)['playerId'] and mstate(pb) == mstate(pa))
    # (a) A 前進一天，B 沒有改動 → B 自動採用
    play_day(pa, '2026-11-12')
    wait_synced(pa)
    pb.evaluate('() => window.__cloud.syncSave()')
    pb.wait_for_function("() => window.__cg.state.settledThrough === '2026-11-12'", timeout=20000)
    check('B 沒有未同步變更 → 自動採用 A 的較新進度', mstate(pb) == mstate(pa))
    # (b) 兩邊都改：B 離線時修改，A 同時上傳 → B 恢復連線後出現衝突選擇
    cb.set_offline(True)
    wait_status(pb, 'offline')
    pb.evaluate("() => { window.__cg.state.profile.hero = 'B的修改'; window.__cg.render(); }")
    pa.evaluate("() => { window.__cg.state.profile.hero = 'A的修改'; window.__cg.render(); }")
    wait_synced(pa)
    a_state = mstate(pa)
    cb.set_offline(False)
    pb.wait_for_selector('#cloud-modal [data-cloud="keep-local"]', timeout=20000)
    txt = pb.inner_text('#cloud-modal')
    check('兩邊都有修改時不會直接覆蓋，而是顯示衝突選擇', '這台裝置' in txt and '雲端' in txt and pb.evaluate('() => window.__cloud.status') == 'conflict')
    check('衝突時雲端仍是 A 的版本（沒有被覆蓋）', cloud_save(meta(pa)['playerId'])['state']['profile']['hero'] == 'A的修改')
    check('衝突時 B 的版本已先留本機備份', any((b.get('state') or b.get('data') or {}).get('profile', {}).get('hero') == 'B的修改' for b in local_backups(pb)))
    with pb.expect_download() as d1:
        pb.click('[data-cloud="dl-both"]')
    check('衝突時可以先下載兩份 JSON', d1.value.suggested_filename.endswith('.json'))
    pb.click('[data-cloud="keep-local"]')
    wait_synced(pb)
    row = cloud_save(meta(pb)['playerId'])
    check('選「保留這台裝置」→ 雲端改成 B 的版本', row['state']['profile']['hero'] == 'B的修改' and row['last_reason'] == 'conflict-keep-local', row['last_reason'])
    snaps = sql("select state from public.save_snapshots where save_id = $1", row['id'])
    check('被取代的 A 版本自動存進雲端備份', any(s['state'] == a_state for s in snaps), len(snaps))
    pa.evaluate('() => window.__cloud.syncSave()')
    pa.wait_for_function("() => window.__cg.state.profile.hero === 'B的修改'", timeout=20000)
    check('A 之後自動採用 B 選定的版本', mstate(pa) == mstate(pb))
    # (c) 再衝突一次，這次選「使用雲端」
    cb.set_offline(True)
    wait_status(pb, 'offline')
    pb.evaluate("() => { window.__cg.state.profile.hero = 'B第二次'; window.__cg.render(); }")
    pa.evaluate("() => { window.__cg.state.profile.hero = 'A第二次'; window.__cg.render(); }")
    wait_synced(pa)
    cb.set_offline(False)
    pb.wait_for_selector('#cloud-modal [data-cloud="keep-cloud"]', timeout=20000)
    pb.click('[data-cloud="keep-cloud"]')
    pb.wait_for_function("() => window.__cg.state.profile.hero === 'A第二次'", timeout=20000)
    wait_synced(pb)
    check('選「使用雲端」→ B 改用 A 的版本', mstate(pb) == mstate(pa))
    check('B 原本的版本留在本機備份', any((b.get('state') or b.get('data') or {}).get('profile', {}).get('hero') == 'B第二次' for b in local_backups(pb)))
    # (d) 伺服器端：用舊的 revision 寫入會被拒絕
    r = pb.evaluate("""async () => { const m = window.__cloud;
        return m.api.updateSave(m.meta.saveId, window.__cg.state, m.meta.revision - 1, { checksum: null, clientId: 'x', reason: 'autosave', opId: crypto.randomUUID() }); }""")
    check('以舊版本號寫入 → revision_conflict（不會蓋掉較新的進度）', r.get('ok') is False and r.get('error') == 'revision_conflict', r)
    ca.close()
    cb.close()


# =====================================================================
#  復原代碼（介面）
# =====================================================================
@test
def t11_recovery_code_ui():
    """t11 復原代碼：產生、輸入、一次性、錯誤代碼、裝置已有進度時確認"""
    ca = new_ctx()
    pa = open_game(ca, label=':A')
    start_game(pa)
    play_today(pa)
    wait_synced(pa)
    pa.click('#cloud-pill')
    pa.click('[data-cloud="code"]')
    pa.wait_for_selector('[data-cloud-code]')
    code = pa.inner_text('[data-cloud-code]').strip()
    check('產生 20 碼復原代碼（XXXX-XXXX-XXXX-XXXX-XXXX）', re.match(r'^[0-9A-Z]{4}(-[0-9A-Z]{4}){4}$', code) is not None, code)
    rows = sql('select code_hash, expires_at > now() as valid, used_at from public.recovery_codes')
    raw = code.replace('-', '')
    check('伺服器只存雜湊，不存代碼本身', len(rows) == 1 and rows[0]['code_hash'] != raw and raw not in json.dumps(rows) and re.match(r'^[0-9a-f]{64}$', rows[0]['code_hash']), rows)
    check('代碼不是玩家 UUID', raw.lower() not in (meta(pa)['userId'] or '').replace('-', '') and raw.lower() not in (meta(pa)['playerId'] or '').replace('-', ''))
    check('代碼有有效期限', rows[0]['valid'] is True)
    pa.click('[data-cloud="panel"]')
    pa.click('[data-cloud="close"]')
    # 新裝置：歡迎畫面輸入代碼
    cb = new_ctx()
    pb = open_game(cb, '2026-11-11', '21:45', label=':B')
    wait_ready(pb)
    gate_closed(pb)
    pb.click('.cl-welcome [data-cloud="redeem"]')
    pb.fill('#cl-code-input', 'ABCD-EFGH-JKMN-PQRS-TVWX')
    pb.click('[data-cloud="redeem-go"]')
    pb.wait_for_selector('.cl-err:not([hidden])', timeout=10000)
    check('輸入錯誤的代碼 → 顯示「代碼不正確」', '不正確' in pb.inner_text('.cl-err'), pb.inner_text('.cl-err'))
    pb.fill('#cl-code-input', code.lower().replace('-', ' '))
    pb.click('[data-cloud="redeem-go"]')
    pb.wait_for_function('() => window.__cg.state.started === true', timeout=20000)
    wait_synced(pb)
    check('輸入正確代碼（小寫、空格也可以）→ 接回雲端存檔', mstate(pb) == mstate(pa) and meta(pb)['playerId'] == meta(pa)['playerId'])
    check('兩台裝置連結到同一位玩家', len(sql('select 1 from public.player_members where player_id = $1', meta(pa)['playerId'])) == 2)
    check('代碼用過就失效', sql('select used_at is not null as used from public.recovery_codes')[0]['used'] is True)
    cc = new_ctx()
    pc = open_game(cc, label=':C')
    wait_ready(pc)
    gate_closed(pc)
    pc.click('.cl-welcome [data-cloud="redeem"]')
    pc.fill('#cl-code-input', code)
    pc.click('[data-cloud="redeem-go"]')
    pc.wait_for_selector('.cl-err:not([hidden])', timeout=10000)
    check('同一組代碼不能再用第二次', '用過' in pc.inner_text('.cl-err'), pc.inner_text('.cl-err'))
    # 過期
    code2 = recovery_code(pa)
    sql("update public.recovery_codes set expires_at = now() - interval '1 minute' where used_at is null")
    pc.fill('#cl-code-input', code2)
    pc.click('[data-cloud="redeem-go"]')
    pc.wait_for_function("() => /過期/.test((document.querySelector('.cl-err') || {}).textContent || '')", timeout=10000)
    check('過期的代碼不能使用', '過期' in pc.inner_text('.cl-err'))
    pc.click('[data-cloud="close"]')
    cc.close()
    # 已有自己進度的裝置 → 先確認 → 衝突時選雲端 → 本機進度留備份
    cd = new_ctx()
    pd = open_game(cd, label=':D')
    start_game(pd)
    pd.evaluate("() => { window.__cg.state.profile.hero = 'D自己的進度'; window.__cg.render(); }")
    wait_synced(pd)
    d_player = meta(pd)['playerId']
    code3 = recovery_code(pa)
    pd.click('#cloud-pill')
    pd.click('[data-cloud="redeem"]')
    pd.fill('#cl-code-input', code3)
    pd.click('[data-cloud="redeem-go"]')
    pd.wait_for_selector('[data-cloud="redeem-force"]', timeout=15000)
    check('這台裝置已有自己的雲端進度 → 先請玩家確認', '自己的進度' in pd.inner_text('#cloud-modal'))
    pd.click('[data-cloud="redeem-force"]')
    pd.wait_for_selector('#cloud-modal [data-cloud="keep-cloud"]', timeout=20000)
    check('接回後兩邊進度不同 → 顯示衝突選擇（建議使用雲端）', 'primary' in (pd.get_attribute('#cloud-modal [data-cloud="keep-cloud"]', 'class') or ''))
    pd.click('[data-cloud="keep-cloud"]')
    pd.wait_for_function("() => window.__cg.state.profile.hero !== 'D自己的進度'", timeout=20000)
    wait_synced(pd)
    check('D 改用 A 的雲端存檔', mstate(pd) == mstate(pa) and meta(pd)['playerId'] == meta(pa)['playerId'])
    check('D 原本的進度留在本機備份', any((b.get('state') or b.get('data') or {}).get('profile', {}).get('hero') == 'D自己的進度' for b in local_backups(pd)))
    check('D 原本的雲端存檔沒有被刪除（仍在原玩家底下）', cloud_save(d_player) is not None and cloud_save(d_player)['state']['profile']['hero'] == 'D自己的進度')
    # Edge Function 還沒部署時：清楚告知，不會出現看不懂的錯誤
    pa.evaluate("() => { window.__origCfg = window.__cloud._apiObj.cfg; window.__cloud._apiObj.cfg = { ...window.__origCfg, recoveryFunction: 'not-deployed-fn' }; }")
    pa.click('#cloud-pill')
    pa.click('[data-cloud="code"]')
    pa.wait_for_function("() => /recover-save/.test(document.getElementById('toasts').textContent)", timeout=15000)
    check('復原代碼的 Edge Function 尚未部署（或來源不允許）→ 顯示部署／ALLOWED_ORIGINS 的說明，而不是網路錯誤', 'recover-save' in pa.inner_text('#toasts') and pa.evaluate('() => window.__cloud.status') == 'synced', pa.inner_text('#toasts'))
    pa.evaluate("() => { window.__cloud._apiObj.cfg = window.__origCfg; }")
    pa.click('[data-cloud="close"]')
    ERRS[:] = [e for e in ERRS if 'not-deployed-fn' not in e]  # 這個測試故意呼叫不存在的函式，瀏覽器的 CORS 錯誤訊息是預期中的
    for c in (ca, cb, cd):
        c.close()


# =====================================================================
#  多分頁、Session 遺失
# =====================================================================
@test
def t12_multi_tab():
    """t12 同一個瀏覽器開兩個分頁：只有一個能寫入、接手不遺失進度"""
    ctx = new_ctx()
    t1 = open_game(ctx, label=':tab1')
    start_game(t1)
    play_today(t1)
    wait_synced(t1)
    t2 = open_game(ctx, '2026-11-11', '21:30', label=':tab2')
    t2.wait_for_function("() => window.__cloud.status === 'suspended'", timeout=15000)
    check('第二個分頁顯示「遊戲已在另一個分頁開啟」', '另一個分頁' in t2.inner_text('#cloud-modal'))
    t1.evaluate("() => { window.__cg.state.profile.hero = '分頁一最新'; window.__cg.render(); }")
    wait_synced(t1)
    before = t1.evaluate(f"() => localStorage.getItem('{SAVE_KEY}')")
    t2.evaluate('() => window.__cg.render()')
    check('暫停中的分頁不會把舊畫面寫回存檔', t2.evaluate(f"() => localStorage.getItem('{SAVE_KEY}')") == before)
    t2.click('[data-cloud="takeover"]')
    t2.wait_for_function("() => window.__cloud && window.__cloud.status === 'synced' && window.__cloud.leader === true", timeout=20000)
    t1.wait_for_function("() => window.__cloud.status === 'suspended'", timeout=15000)
    check('接手：原本的分頁暫停，新分頁接手同步', '另一個分頁' in t1.inner_text('#cloud-modal'))
    check('接手後的分頁拿到最新進度', mstate(t2)['profile']['hero'] == '分頁一最新')
    t2.evaluate("() => { window.__cg.state.profile.hero = '分頁二'; window.__cg.render(); }")
    wait_synced(t2)
    t1.evaluate('() => window.__cg.render()')
    check('被接手的分頁之後也不會覆蓋存檔', json.loads(t2.evaluate(f"() => localStorage.getItem('{SAVE_KEY}')"))['profile']['hero'] == '分頁二' and cloud_save(meta(t2)['playerId'])['state']['profile']['hero'] == '分頁二')
    ctx.close()


@test
def t13_session_loss():
    """t13 Session 遺失／權杖失效：建立新身分但不遺失進度，可用復原代碼接回原存檔"""
    ctx = new_ctx()
    pg = open_game(ctx)
    start_game(pg)
    play_today(pg)
    wait_synced(pg)
    m1, s1 = meta(pg), mstate(pg)
    code = recovery_code(pg)
    pg.evaluate("() => localStorage.removeItem('morning-bond:auth')")
    open_game(None, '2026-11-11', '21:40', page=pg)
    wait_synced(pg)
    m2 = meta(pg)
    check('Session 遺失 → 自動建立新的匿名身分', m2['userId'] != m1['userId'] and m2['identityResetAt'])
    check('Session 遺失不會遺失本機進度', mstate(pg)['settledThrough'] == s1['settledThrough'] and mstate(pg)['player'] == s1['player'])
    check('進度上傳到新身分的雲端存檔', cloud_save(m2['playerId'])['state'] == mstate(pg))
    check('原本的雲端存檔仍在', cloud_save(m1['playerId'])['state'] == s1)
    pg.evaluate('(c) => window.__cloud.redeemRecoveryCode(c, true)', code)
    wait_synced(pg)
    check('用復原代碼接回原本的雲端存檔', meta(pg)['playerId'] == m1['playerId'])
    # 權杖過期＋refresh token 被撤銷
    emu('config', {'accessTtl': 2})
    open_game(None, '2026-11-12', '09:00', page=pg)
    wait_synced(pg)
    pg.evaluate('() => window.__cloud.auth.refresh()')  # 換成 2 秒就過期的權杖
    uid = meta(pg)['userId']
    emu('revoke', {'user_id': uid})
    time.sleep(3)
    pg.evaluate("() => { window.__cg.state.profile.hero = '權杖失效後'; window.__cg.render(); }")
    pg.wait_for_function(f"() => window.__cloud.meta.userId && window.__cloud.meta.userId !== {json.dumps(uid)} && window.__cloud.status === 'synced' && !window.__cloud.meta.dirty", timeout=40000)
    m3 = meta(pg)
    check('refresh token 失效 → 重新建立身分並繼續同步', cloud_save(m3['playerId'])['state']['profile']['hero'] == '權杖失效後')
    check('權杖失效過程中本機進度沒有遺失', mstate(pg)['settledThrough'] == s1['settledThrough'])
    emu('config', {'accessTtl': 3600})
    ctx.close()


# =====================================================================
#  備份還原、刪除、較新版本、金鑰安全、debounce
# =====================================================================
@test
def t14_snapshots_restore_delete():
    """t14 重新開始前自動備份、從雲端備份還原、刪除雲端存檔與重新開啟"""
    ctx = new_ctx()
    pg = open_game(ctx)
    start_game(pg)
    play_today(pg)
    play_day(pg, '2026-11-12')
    wait_synced(pg)
    m = meta(pg)
    progress = mstate(pg)
    pg.click('[data-act="tab:settings"]')
    pg.click('[data-act="reset"]')
    pg.click('#modal [data-act="resetok"]')
    pg.wait_for_selector('[data-act="start"]')
    wait_synced(pg)
    row = cloud_save(m['playerId'])
    check('重新開始也會同步（雲端變成新遊戲）', row['state']['started'] is False and row['last_reason'] == 'reset', row['last_reason'])
    snap = sql("select id::text, state from public.save_snapshots where save_id = $1 and reason = 'reset'", row['id'])
    check('重新開始前的進度自動備份在雲端', any(s['state'] == progress for s in snap), len(snap))
    pg.click('#cloud-pill')
    pg.click('[data-cloud="snapshots"]')
    pg.wait_for_selector('.cl-snaps li')
    check('雲端備份清單顯示「重新開始前」', '重新開始前' in pg.inner_text('.cl-snaps'))
    sid = [s['id'] for s in snap if s['state'] == progress][0]
    pg.click(f'[data-cloud="restore:{sid}"]')
    pg.click(f'[data-cloud="restore-go:{sid}"]')
    pg.wait_for_function('() => window.__cg.state.started === true', timeout=20000)
    wait_synced(pg)
    check('從雲端備份還原 → 進度回來了', mstate(pg) == progress and cloud_save(m['playerId'])['state'] == progress)
    check('還原前的版本也備份（可以再還原回去）', len(sql("select 1 from public.save_snapshots where save_id = $1 and reason = 'restore'", row['id'])) >= 1)
    # 刪除雲端存檔
    pg.click('#cloud-pill')
    pg.click('[data-cloud="delete"]')
    pg.fill('#cl-del-input', '刪除')
    pg.click('[data-cloud="delete-go"]')
    pg.wait_for_selector('[data-cloud="enable"]', timeout=15000)
    check('刪除雲端存檔：雲端存檔、備份、回憶都刪除', cloud_save(m['playerId']) is None and len(sql('select 1 from public.save_snapshots')) == 0 and len(sql('select 1 from public.memories')) == 0)
    check('刪除雲端存檔：本機進度保留', mstate(pg) == progress)
    pg.click('[data-cloud="close"]')
    t0 = int(time.time() * 1000)
    pg.evaluate("() => { window.__cg.state.profile.hero = '停用同步中'; window.__cg.render(); }")
    pg.wait_for_timeout(2500)
    check('刪除後停用自動同步（不會偷偷重新上傳）', not calls(emu_log(), '/rpc/create_game_save', t0) and cloud_save(m['playerId']) is None)
    pg.click('#cloud-pill')
    pg.click('[data-cloud="enable"]')
    wait_synced(pg)
    check('重新開啟雲端同步 → 建立新的雲端存檔', cloud_save(m['playerId']) is not None and cloud_save(m['playerId'])['state'] == mstate(pg))
    ctx.close()


@test
def t15_newer_version_guard():
    """t15 雲端存檔來自較新版本的遊戲：不覆蓋、不讀入、提示更新"""
    ctx = new_ctx()
    pg = open_game(ctx)
    start_game(pg)
    wait_synced(pg)
    m = meta(pg)
    sql("update public.game_saves set state = jsonb_set(state, '{version}', '3'), last_reason = 'restore' where player_id = $1", m['playerId'])
    before = cloud_save(m['playerId'])
    pg.evaluate("() => { window.__cg.state.profile.hero = '舊版遊戲的修改'; window.__cg.render(); }")
    pg.evaluate('() => window.__cloud.syncSave()')
    pg.wait_for_function('() => window.__cloud.readOnly === true', timeout=15000)
    pg.wait_for_timeout(1500)
    after = cloud_save(m['playerId'])
    check('偵測到較新版本 → 停止上傳（雲端不被舊版覆蓋）', after['revision'] == before['revision'] and after['state']['version'] == 3)
    check('顯示需要更新遊戲的提示', '較新版本' in pg.evaluate('() => window.__cloud.detail'))
    check('本機進度不受影響', mstate(pg)['profile']['hero'] == '舊版遊戲的修改' and mstate(pg)['version'] == 2)
    ctx.close()


@test
def t16_key_safety_and_config():
    """t16 金鑰安全：Secret key 會被拒絕、專案檔案不含任何金鑰、設定值符合需求"""
    ctx = new_ctx()
    reqs = []
    ctx.on('request', lambda r: reqs.append(r.url) if r.url.startswith(EMU) else None)
    pg = new_page(ctx)
    msgs = []
    pg.on('console', lambda m: msgs.append(m.text))
    pg.goto(f'{GAME_SECRET}?date=2026-11-11&time=09:30')
    pg.wait_for_function('() => !!window.__cloud')
    pg.wait_for_timeout(800)
    check('config 填了 Secret key → 雲端功能停用', pg.evaluate('() => window.__cloud.enabled') is False and pg.evaluate('() => window.__cloud.problem') == 'secret-key')
    check('Secret key 設定下完全不會連線', not reqs, reqs[:3])
    check('主控台提示只能用 Publishable key', any('Publishable' in t for t in msgs))
    ERRS[:] = [e for e in ERRS if 'Secret / service_role' not in e]  # 這則錯誤訊息是預期中的
    pg.click('[data-act="start"]')
    pg.wait_for_timeout(150)
    dismiss(pg)
    check('雲端停用時遊戲照常（本機模式）', mstate(pg)['started'] is True)
    probe = pg.evaluate("""async () => { const m = await import('./js/supabase.js');
      const b64 = (o) => btoa(JSON.stringify(o)).replace(/=+$/, '');
      const jwt = (role) => b64({ alg: 'HS256', typ: 'JWT' }) + '.' + b64({ role, iss: 'supabase' }) + '.sig';
      const base = { supabaseUrl: 'https://abc.supabase.co' };
      return {
        publishable: m.cloudConfigProblem({ ...base, supabasePublishableKey: 'sb_publishable_abc' }),
        legacyAnon: m.cloudConfigProblem({ ...base, supabasePublishableKey: jwt('anon') }),
        secret: m.cloudConfigProblem({ ...base, supabasePublishableKey: 'sb_secret_abc' }),
        serviceRole: m.cloudConfigProblem({ ...base, supabasePublishableKey: jwt('service_role') }),
        empty: m.cloudConfigProblem({ supabaseUrl: '', supabasePublishableKey: '' }),
        httpUrl: m.cloudConfigProblem({ supabaseUrl: 'http://evil.example.com', supabasePublishableKey: 'sb_publishable_abc' }),
      }; }""")
    check('金鑰檢查：Publishable key 與舊版 anon JWT 允許；Secret／service_role 拒絕；非 https 拒絕', probe == {'publishable': None, 'legacyAnon': None, 'secret': 'secret-key', 'serviceRole': 'secret-key', 'empty': 'not-configured', 'httpUrl': 'bad-url'}, probe)
    ctx.close()
    leaks = []
    for f in ROOT.rglob('*'):
        if not f.is_file() or 'tests' in f.parts or f.suffix not in ('.js', '.html', '.css', '.ts', '.sql', '.md', '.json'):
            continue
        t = f.read_text(encoding='utf-8', errors='ignore')
        if 'vendor' in f.parts:
            continue
        for mm in re.finditer(r'sb_secret_[A-Za-z0-9_]{8,}|eyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}', t):
            leaks.append(f'{f.relative_to(ROOT)}: {mm.group(0)[:20]}…')
    check('專案檔案（不含測試）沒有任何 Secret key 或 JWT', not leaks, leaks)
    shipped = (ROOT / 'js' / 'config.js').read_text(encoding='utf-8')
    check('出貨的 config.js 沒有預填任何網址或金鑰', re.search(r"supabaseUrl: ''", shipped) and re.search(r"supabasePublishableKey: ''", shipped))
    iv = int(re.search(r'syncIntervalMs:\s*(\d+)', shipped).group(1))
    db = int(re.search(r'autosaveDebounceMs:\s*(\d+)', shipped).group(1))
    check('定時同步 30～60 秒、debounce 數秒', 30000 <= iv <= 60000 and 500 <= db <= 5000, (iv, db))


@test
def t17_debounce_and_interval():
    """t17 連續操作合併上傳（debounce）、定時同步、最後成功時間"""
    ctx = new_ctx()
    pg = open_game(ctx)
    start_game(pg)
    wait_synced(pg)
    m = meta(pg)
    t0 = int(time.time() * 1000)
    pg.evaluate("async () => { for (let i = 0; i < 30; i++) { window.__cg.state.profile.hero = '連點' + i; window.__cg.render(); await new Promise(r => setTimeout(r, 20)); } }")
    wait_synced(pg)
    ups = calls(emu_log(), '/rpc/update_game_save', t0)
    check('30 次連續存檔合併成 1～2 次上傳', 1 <= len(ups) <= 2, len(ups))
    check('上傳的是最後的狀態', cloud_save(m['playerId'])['state']['profile']['hero'] == '連點29')
    t1 = int(time.time() * 1000)
    pg.wait_for_timeout(9500)
    heads = calls(emu_log(), '/rpc/get_save_head', t1)
    check('閒置時定時檢查雲端（測試設定 4 秒一次）', len(heads) >= 2, len(heads))
    check('閒置時不會重複上傳沒有變更的存檔', not calls(emu_log(), '/rpc/update_game_save', t1))
    mm = meta(pg)
    import datetime as _dt
    age = (_dt.datetime.now(_dt.timezone.utc) - _dt.datetime.fromisoformat(mm['syncedAt'].replace('Z', '+00:00'))).total_seconds() if mm.get('syncedAt') else 1e9
    check('記錄最後成功同步時間（ISO 時間、就在剛剛）', 0 <= age < 120, mm.get('syncedAt'))
    pg.click('#cloud-pill')
    check('雲端面板顯示最後成功同步時間', '最後成功同步' in pg.inner_text('[data-cloud-status]'))
    ctx.close()


# =====================================================================
def main():
    want = [a for a in sys.argv[1:] if not a.startswith('-')]
    build_site()
    srv = serve_site()
    with sync_playwright() as p:
        PW['p'] = p
        PW['browser'] = p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])
        for fn in TESTS:
            if want and not any(w in fn.__name__ for w in want):
                continue
            CUR[0] = fn.__doc__.strip().split('\n')[0]
            emu('reset')
            t = time.time()
            try:
                fn()
            except Exception as e:
                frames = [f'{fr.name}:{fr.lineno}' for fr in traceback.extract_tb(e.__traceback__) if fr.filename == __file__]
                check('（測試中途發生例外）', False, ' > '.join(frames) + ' :: ' + str(e).replace('\n', ' ')[:400])
            print(f'… {CUR[0]}（{time.time() - t:.0f} 秒）', flush=True)
        PW['browser'].close()
    srv.shutdown()
    cur = None
    for tname, name, ok, info in RESULTS:
        if tname != cur:
            print(f'\n## {tname}')
            cur = tname
        print(f"{'PASS' if ok else 'FAIL'} {name}{'' if ok else '  -> ' + info}")
    passed = sum(1 for r in RESULTS if r[2])
    print(f'\nCloud E2E: {passed}/{len(RESULTS)} passed')
    if ERRS:
        print('\n瀏覽器錯誤：')
        for e in ERRS[:30]:
            print(' ', e)
    shutil.rmtree(SITE, ignore_errors=True)
    sys.exit(0 if passed == len(RESULTS) and not ERRS else 1)


if __name__ == '__main__':
    main()
