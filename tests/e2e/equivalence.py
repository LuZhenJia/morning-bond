"""
等價測試：同一組操作分別在「v1.1 單檔版」與「Morning-Bond 模組版（本機模式）」執行，
固定 Math.random 種子後逐項比對：

  1. 引擎模擬整學期（4 種玩法）→ 完整狀態 S 必須逐字相同
  2. 以滑鼠操作實際遊玩 19 天（含週日結算、補救、勳章、提早離開、技能、照片）
     → 每天的狀態 S、每一個彈出視窗的內容、最後 8 個分頁的畫面 HTML 必須相同
  3. 匯出的 JSON 必須相同；舊版匯出 → 新版匯入、新版匯出 → 舊版匯入，結果必須相同

用法：
  OLD_GAME_URL=file:///…/晨光羈絆.html GAME_URL=http://127.0.0.1:8080/Morning-Bond/index.html python3 tests/e2e/equivalence.py
"""
import datetime as dt
import json
import os
import pathlib
import random
import re
import struct
import sys
import zlib

from playwright.sync_api import sync_playwright

OLD = os.environ.get('OLD_GAME_URL', '')
NEW = os.environ.get('GAME_URL', 'http://127.0.0.1:8080/Morning-Bond/index.html')
CHROME = os.environ.get('CHROME', '/usr/bin/google-chrome')
TMP = pathlib.Path(os.environ.get('TMPDIR', '/tmp')) / 'mb-equivalence'
TMP.mkdir(parents=True, exist_ok=True)

if not OLD:
    print('SKIP：請設定 OLD_GAME_URL 指向 v1.1 單檔版 HTML 才能做新舊等價比對')
    sys.exit(2)

SEED_JS = """
(() => {
  let a = 0x2B7E1516 ^ 20261111;
  Math.random = function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();
"""

SIM_JS = r"""
(policy) => {
  const cg = window.__cg;
  let seed = 12345;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  cg.handle('start', []);
  const S = cg.state;
  S.queue = [];
  cg.closeModal();
  const P = { perfect: [1, 0, 0], good: [0.88, 0.08, 0.04], mediocre: [0.72, 0.06, 0.22], poor: [0.5, 0.05, 0.45] }[policy];
  const end = '2027-01-17';
  let guard = 0;
  while (cg.playDate() <= end && guard++ < 200) {
    const d = cg.playDate();
    const day = cg.beginDay(d);
    day.sleep = rnd() < (policy === 'poor' ? 0.6 : 0.9) ? 'ok' : 'late';
    day.wake = rnd() < (policy === 'poor' ? 0.55 : policy === 'mediocre' ? 0.8 : 0.95) ? 'ok' : 'snooze';
    const ss = cg.sessionsOn(d);
    ss.forEach((s) => { const r = rnd(); day.reports[s.id] = { o: r < P[0] ? 'perfect' : r < P[0] + P[1] ? 'late' : 'absent', remedied: false, medal: false }; });
    const open = ['mom', 'dad', 'sis'].filter((m) => S.bonds[m].lv >= 1);
    if (open.length) {
      const R = cg.computeDay(d, day);
      day.inter = { who: open[Math.floor(rnd() * open.length)], type: 'report', special: R.perfectAll, line: '' };
    }
    day.review = rnd() < (policy === 'poor' ? 0.3 : 0.7);
    cg.settleDay(d);
    const order = ['dawn', 'endure', 'wish', 'clock', 'mutual', 'window', 'commute', 'stay', 'resonance', 'weekend', 'holiday', 'home'];
    for (const id of order) { if (S.player.level >= 2 && !S.player.skills[id]) cg.handle('learn', [id]); }
    S.queue = [];
  }
  return JSON.stringify(S);
}
"""

results = []
errors = []


def check(name, cond, info=''):
    results.append((name, bool(cond), info))


def first_diff(a, b, path='S'):
    """回傳第一個不同的位置，方便除錯。"""
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
    return None if a == b else f'{path}: {str(a)[:80]} != {str(b)[:80]}'


TOON_SRC = re.compile(r'src="(?:blob:[^"]+|[^"]*/assets/images/toon/[^"]+)"')


def norm_html(html):
    # 單檔版的卡通頭像是 blob 網址、模組版是 assets 圖檔，比對時統一成 TOON
    return TOON_SRC.sub('src="TOON"', html)


def png(path, w=64, h=80, color=(200, 120, 80)):
    raw = b''.join(b'\x00' + bytes(color) * w for _ in range(h))
    def chunk(t, d):
        c = struct.pack('>I', len(d)) + t + d
        return c + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
    pathlib.Path(path).write_bytes(data)


class Recorder:
    def __init__(self, browser, base, label):
        self.base, self.label = base, label
        self.ctx = browser.new_context(viewport={'width': 1200, 'height': 900}, accept_downloads=True)
        self.ctx.add_init_script(SEED_JS)
        self.page = self.ctx.new_page()
        self.page.on('pageerror', lambda e: errors.append(f'[{label}] pageerror: {e}'))
        self.page.on('console', lambda m: errors.append(f'[{label}] console.{m.type}: {m.text}') if m.type == 'error' else None)
        self.modals = []
        self.days = []
        self.rng = random.Random(4242)

    def goto(self, date, time=None):
        q = f'?date={date}' + (f'&time={time}' if time else '')
        self.page.goto(self.base + q)
        self.page.wait_for_selector('#view')
        self.page.wait_for_timeout(120)

    def state(self):
        return self.page.evaluate('() => JSON.parse(JSON.stringify(window.__cg.state))')

    def dismiss(self, limit=50):
        pg = self.page
        for _ in range(limit):
            if not pg.is_visible('#modal'):
                return
            self.modals.append(norm_html(pg.inner_html('#modal')))
            for sel in ('#modal [data-act="storynext"]', '#modal [data-act^="evpick:"]', '#modal [data-act="close"]', '#modal [data-act^="skipok"]'):
                if pg.query_selector(sel):
                    pg.click(sel)
                    break
            else:
                pg.click('#modal .btn')
            pg.wait_for_timeout(70)
        raise RuntimeError('modal did not close')

    def play_day(self, date):
        pg, rnd = self.page, self.rng
        # 固定時間（不固定的話，「兄妹」分頁會依真實時鐘顯示妹妹正在做什麼，兩次執行時間不同就會不一樣）
        self.goto(date, '21:30')
        self.dismiss()
        if pg.query_selector('[data-act="sleep:ok"]'):
            pg.click(f'[data-act="sleep:{"late" if rnd.random() < 0.25 else "ok"}"]')
            self.dismiss()
            if not pg.evaluate('() => !!window.__cg.state.days[window.__cg.playDate()].wake'):
                pg.click(f'[data-act="wake:{"ok" if rnd.random() < 0.75 else "over"}"]')
            if pg.query_selector('[data-act="supply"]'):
                pg.click('[data-act="supply"]')
            pg.click('[data-act="begin"]')
            self.dismiss()
        for _ in range(20):
            btns = pg.query_selector_all('[data-act^="rep:"][data-act$=":perfect"]')
            if not btns:
                break
            sid = btns[0].get_attribute('data-act').split(':')[1]
            r = rnd.random()
            o = 'perfect' if r < 0.6 else 'late' if r < 0.72 else 'absent' if r < 0.9 else 'left'
            pg.click(f'[data-act="rep:{sid}:{o}"]')
            # 遊戲在回報後 450ms 才決定是否跳出隨機試煉；等久一點，兩個版本才會在相同時間點處理
            pg.wait_for_timeout(900)
            self.dismiss()
            if o == 'absent' and pg.query_selector(f'[data-act="remedy:{sid}"]') and rnd.random() < 0.6:
                pg.click(f'[data-act="remedy:{sid}"]')
                pg.click('#modal [data-act^="remdo:"]')
                self.dismiss()
            if o == 'left' and pg.query_selector(f'[data-act="medal:{sid}"]'):
                pg.click(f'[data-act="medal:{sid}"]')
        if pg.query_selector('[data-act="candy"]') and rnd.random() < 0.3:
            pg.click('[data-act="candy"]')
        if pg.query_selector('[data-act="toEvening"]'):
            pg.click('[data-act="toEvening"]')
        who = pg.query_selector_all('[data-act^="iwho:"]')
        if who:
            who[int(rnd.random() * len(who))].click()
            inter = pg.query_selector_all('[data-act^="inter:"]')
            inter[int(rnd.random() * len(inter))].click()
            self.dismiss()
        if pg.query_selector('[data-act="review"]') and rnd.random() < 0.7:
            pg.click('[data-act="review"]')
        pg.click('[data-act="settle"]')
        pg.wait_for_timeout(150)
        self.dismiss()
        st = self.state()
        if st['player']['level'] >= 2 and st['player']['sp'] > 0:
            pg.click('[data-act="tab:skills"]')
            btn = pg.query_selector('[data-act^="learn:"]')
            if btn:
                btn.click()
                pg.wait_for_timeout(60)
                self.dismiss()
            pg.click('[data-act="tab:today"]')
        self.days.append((date, self.state()))

    def screens(self):
        out = {}
        for tab in ('today', 'sib', 'bonds', 'skills', 'quests', 'album', 'records', 'settings'):
            self.page.click(f'[data-act="tab:{tab}"]')
            self.page.wait_for_timeout(80)
            out[tab] = norm_html(self.page.inner_html('#top') + self.page.inner_html('#tabs') + self.page.inner_html('#view'))
        return out

    def export(self):
        self.page.click('[data-act="tab:settings"]')
        with self.page.expect_download() as dl:
            self.page.click('[data-act="export"]')
        return json.loads(pathlib.Path(dl.value.path()).read_text(encoding='utf-8')), dl.value.suggested_filename

    def import_file(self, path):
        self.page.evaluate("() => { const i = document.createElement('input'); i.type = 'file'; i.dataset.import = '1'; i.id = 'imp-eq'; document.body.appendChild(i); }")
        self.page.set_input_files('#imp-eq', str(path))
        self.page.wait_for_timeout(500)
        self.dismiss()

    def close(self):
        self.ctx.close()


def run_ui(browser, base, label):
    r = Recorder(browser, base, label)
    r.goto('2026-11-11', '09:30')
    welcome = norm_html(r.page.inner_html('#view'))
    r.page.click('[data-act="start"]')
    r.page.wait_for_timeout(150)
    r.dismiss()
    # 照片（設定頁上傳；兩邊用同一張圖）
    png(TMP / 'face.png')
    r.page.click('[data-act="tab:settings"]')
    r.page.set_input_files('input[data-photo="mom"]', str(TMP / 'face.png'))
    r.page.wait_for_timeout(500)
    r.page.click('[data-act="tab:today"]')
    d = dt.date(2026, 11, 11)
    while d <= dt.date(2026, 11, 29):
        r.play_day(d.isoformat())
        d += dt.timedelta(days=1)
    screens = r.screens()
    exported, fname = r.export()
    return r, welcome, screens, exported, fname


def main():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME, args=['--no-sandbox'])

        # 1) 引擎模擬整學期
        for pol in ('perfect', 'good', 'mediocre', 'poor'):
            out = {}
            for label, base in (('old', OLD), ('new', NEW)):
                ctx = b.new_context()
                ctx.add_init_script(SEED_JS)
                pg = ctx.new_page()
                pg.on('pageerror', lambda e, l=label: errors.append(f'[{l}] pageerror: {e}'))
                pg.goto(base + '?date=2026-11-11')
                pg.wait_for_selector('#view')
                out[label] = json.loads(pg.evaluate(SIM_JS, pol))
                ctx.close()
            same = out['old'] == out['new']
            check(f'引擎模擬整學期（{pol}）狀態完全相同', same, first_diff(out['old'], out['new']))
            check(f'引擎模擬整學期（{pol}）有結局', bool(out['new'].get('ending')), out['new'].get('ending'))

        # 2) 實際操作 19 天
        o_r, o_welcome, o_screens, o_exp, o_name = run_ui(b, OLD, 'old')
        n_r, n_welcome, n_screens, n_exp, n_name = run_ui(b, NEW, 'new')
        check('歡迎畫面 HTML 相同', o_welcome == n_welcome)
        check('19 天每天的狀態 S 相同', len(o_r.days) == len(n_r.days) == 19 and all(a == c for (_, a), (_, c) in zip(o_r.days, n_r.days)),
              next((f'{d1}: {first_diff(a, c)}' for (d1, a), (_, c) in zip(o_r.days, n_r.days) if a != c), f'{len(o_r.days)} vs {len(n_r.days)}'))
        check('所有彈出視窗（劇情、試煉、總結）內容與順序相同', o_r.modals == n_r.modals,
              next((f'#{i}' for i, (x, y) in enumerate(zip(o_r.modals, n_r.modals)) if x != y), f'{len(o_r.modals)} vs {len(n_r.modals)}'))
        check('彈出視窗數量 > 20（確實有比對到劇情）', len(n_r.modals) > 20, len(n_r.modals))
        for tab in o_screens:
            same = o_screens[tab] == n_screens[tab]
            info = ''
            if not same:
                import difflib
                a = o_screens[tab].replace('><', '>\n<').splitlines(); c = n_screens[tab].replace('><', '>\n<').splitlines()
                info = ' | '.join(l[:160] for l in difflib.unified_diff(a, c, lineterm='', n=0) if l[:1] in '+-' and l[:3] not in ('---', '+++'))[:900]
            check(f'分頁「{tab}」畫面 HTML 相同', same, info)
        st_new = n_r.state()
        check('照片已存在狀態中（data URL）', str(st_new['profile']['photos'].get('mom', '')).startswith('data:image/jpeg'))
        check('匯出 JSON 完全相同', o_exp == n_exp, first_diff(o_exp, n_exp))
        check('匯出檔名格式相同', o_name == n_name, (o_name, n_name))
        check('有遊玩紀錄（已結算 19 天）', sum(1 for v in st_new['days'].values() if v.get('settled')) == 19)

        # 3) 交叉匯入
        (TMP / 'old-export.json').write_text(json.dumps(o_exp, ensure_ascii=False), encoding='utf-8')
        (TMP / 'new-export.json').write_text(json.dumps(n_exp, ensure_ascii=False), encoding='utf-8')
        for src, dst_label, dst in (('old-export.json', 'new', NEW), ('new-export.json', 'old', OLD)):
            r = Recorder(b, dst, dst_label)
            r.goto('2026-11-29')
            r.import_file(TMP / src)
            got = r.state()
            ref = o_r.state() if src.startswith('old') else n_r.state()
            check(f'{src} 匯入{("新版" if dst_label == "new" else "舊版")}後狀態與原本相同', got == ref, first_diff(ref, got))
            r.close()
        o_r.close(); n_r.close()
        b.close()

    for n, ok, info in results:
        print(('PASS' if ok else 'FAIL'), n, '' if ok else f'-> {info}')
    print(f'{sum(1 for _, ok, _ in results if ok)}/{len(results)} passed')
    print('errors:', errors[:10])
    sys.exit(0 if all(ok for _, ok, _ in results) and not errors else 1)


main()
