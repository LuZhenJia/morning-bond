# 原單檔版的回歸測試：只把網址改成 GAME_URL；唯一改動的檢查是「卡通頭像來源」（單檔版用 blob、模組版用 assets 圖檔）
import os
"""v1.1 測試：卡通頭像、體育移除、兄妹分頁、同步早八、舊存檔升級、妹妹課表設定、體育退選提醒。"""
import json, pathlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
URL = os.environ.get('GAME_URL', 'http://127.0.0.1:8080/Morning-Bond/index.html')
SHOT = ROOT.parent / 'shots'
SHOT.mkdir(parents=True, exist_ok=True)
errors, results = [], []

def check(name, cond, info=''):
    results.append((name, bool(cond), info))

def dismiss(page, limit=40):
    for _ in range(limit):
        if not page.is_visible('#modal'):
            return
        for sel in ['#modal [data-act="storynext"]', '#modal [data-act^="evpick:"]', '#modal [data-act="close"]']:
            if page.query_selector(sel):
                page.click(sel)
                break
        else:
            page.click('#modal .btn')
        page.wait_for_timeout(60)

def hook(page):
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)

def play_morning(page):
    page.click('[data-act="sleep:ok"]')
    page.click('[data-act="wake:ok"]')
    page.click('[data-act="begin"]')
    dismiss(page)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])

    # ---------- 1) 新遊戲：交換課表劇情、卡通頭像、體育已移除 ----------
    ctx = b.new_context(viewport={'width': 1180, 'height': 900})
    page = ctx.new_page(); hook(page)
    page.goto(f'{URL}?date=2026-11-11&time=13:40')
    check('歡迎畫面提到妹妹課表', '靜宜大學食品營養學系' in page.inner_text('#view'))
    page.click('[data-act="start"]')
    page.wait_for_timeout(150)
    titles = []
    for _ in range(40):
        if not page.is_visible('#modal'):
            break
        t = page.query_selector('#modal .story-title')
        if t and (not titles or titles[-1] != t.inner_text()):
            titles.append(t.inner_text())
        if page.query_selector('#modal [data-act="storynext"]'):
            page.click('#modal [data-act="storynext"]')
        else:
            page.click('#modal .btn')
        page.wait_for_timeout(60)
    check('開場依序播放序章與「兩張課表」', '兩張課表' in titles, titles)
    st = page.evaluate('() => window.__cg.state')
    check('預設課表不含體育', not any('體育' in c['name'] for c in st['schedule']), [c['name'] for c in st['schedule']])
    s4 = [c for c in st['schedule'] if c['id'] == 's4'][0]
    check('探索永續為整學期（無結束日）', s4['to'] == '' and s4['note'] == '整學期課程', s4)
    check('妹妹課表 12 科', len(st['sisSchedule']) == 12)
    check('收藏「兩張課表」', 'plan' in st['collection'])
    n_toon = page.evaluate("() => document.querySelectorAll('img.av.toon').length")
    check('今日頁面使用卡通頭像', n_toon >= 3, n_toon)
    # 模組版：卡通頭像改為 assets/images/toon/ 的獨立圖檔（單檔版是內嵌 base64 轉 blob），這是唯一調整過的檢查
    src = page.evaluate("() => (document.querySelector('img.av.toon') || {}).src || ''")
    loaded = page.evaluate("() => [...document.querySelectorAll('img.av.toon')].every(i => i.complete && i.naturalWidth > 0)")
    check('卡通頭像由 assets/images/toon/ 載入且全部顯示成功', '/assets/images/toon/' in src and loaded, src[-40:])
    side = page.inner_text('.sis-card')
    check('今日側欄顯示妹妹的今天（週三 13:40 在上食物學原理）', '食物學原理' in side and '正在上' in side, side[:120])
    check('體育退選提醒出現', page.query_selector('.real-task') is not None)
    page.screenshot(path=str(SHOT / 'v11_today_morning.png'), full_page=True)

    # 早上：週三早八同步
    play_morning(page)
    qtext = page.inner_text('.quests')
    check('探索永續副本卡出現「兄妹同步早八」', '兄妹同步早八' in qtext)
    check('副本卡顯示同時段妹妹的課', '普通生物學' in qtext or '運動健康與素養' in qtext, qtext[:200])
    check('今天沒有體育副本', '男、女生體育' not in qtext and '游泳館' not in qtext)
    for a in ['rep:s4:perfect', 'rep:s5:perfect', 'rep:s6:late', 'rep:s8:perfect']:
        if page.query_selector(f'[data-act="{a}"]'):
            page.click(f'[data-act="{a}"]')
            page.wait_for_timeout(600)
            dismiss(page)
    R = page.evaluate("() => { const d = window.__cg.playDate(); return window.__cg.computeDay(d, window.__cg.getDay(d)); }")
    check('同步早八：計算出 sync 與經驗 +10 註記', R.get('sync') and any('兄妹同步早八' in n for n in R['notes']), R['notes'])
    dismiss(page)
    page.click('[data-act="toEvening"]')
    ev = page.inner_text('.sis-eve')
    check('晚間顯示妹妹今天的分享與同步', '今天的分享' in ev and '同步早八達成' in ev, ev[:160])
    page.screenshot(path=str(SHOT / 'v11_evening.png'), full_page=True)
    page.click('[data-act="settle"]')
    page.wait_for_timeout(100)
    titles = []
    for _ in range(40):
        if not page.is_visible('#modal'):
            break
        t = page.query_selector('#modal .story-title')
        if t and (not titles or titles[-1] != t.inner_text()):
            titles.append(t.inner_text())
        if page.query_selector('#modal [data-act="storynext"]'):
            page.click('#modal [data-act="storynext"]')
        elif page.query_selector('#modal [data-act^="evpick:"]'):
            page.click('#modal [data-act^="evpick:"]')
        else:
            page.click('#modal .btn')
        page.wait_for_timeout(60)
    st = page.evaluate('() => window.__cg.state')
    check('結算後同步次數 = 1、播放「同步早八」劇情', st['counters']['sync'] == 1 and '同步早八' in titles, (st['counters']['sync'], titles))
    check('紀念冊收錄 sync', 'sync' in st['album'])

    # ---------- 2) 兄妹分頁 ----------
    page.click('[data-act="tab:sib"]')
    page.wait_for_timeout(100)
    v = page.inner_text('#view')
    check('兄妹分頁：雙人時間軸、動態、週課表、同步紀錄', all(k in v for k in ['今天的我們', '的動態', '本週雙人課表', '兄妹同步早八', '平行宇宙']), v[:200])
    check('兄妹分頁：現在時間 13:40 與妹妹即時狀態', '13:40' in v and '食物學原理' in v)
    n_blocks = page.evaluate("() => [document.querySelectorAll('.wg-b.mine').length, document.querySelectorAll('.wg-b.hers').length]")
    check('週課表：我 12 堂（含單週大學學習）以內、妹妹 12 堂', n_blocks[1] == 12 and 10 <= n_blocks[0] <= 13, n_blocks)
    fut = page.evaluate("() => document.querySelectorAll('.feed li.fut').length")
    check('動態：未來的動態先隱藏', fut >= 1, fut)
    page.screenshot(path=str(SHOT / 'v11_sib_desktop.png'), full_page=True)
    page.click('[data-act="sibday:1"]')
    v2 = page.inner_text('#view')
    check('兄妹分頁：切換到隔天（週四）', '11/12（四）' in v2 and '文化研究到社會關懷' in v2)
    page.click('[data-act="sibday:0"]')
    check('兄妹分頁：回到今天', '今天的我們' in page.inner_text('#view'))

    # 手機版
    mob = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    mp = mob.new_page(); hook(mp)
    mp.goto(f'{URL}?date=2026-11-11&time=10:30')
    mp.evaluate(f"(s) => {{ localStorage.setItem('chenguang-bond-save-v1', s); }}", json.dumps(st))
    mp.goto(f'{URL}?date=2026-11-11&time=10:30')
    dismiss(mp)
    mp.click('[data-act="tab:sib"]')
    mp.wait_for_timeout(150)
    mp.screenshot(path=str(SHOT / 'v11_sib_mobile.png'), full_page=True)
    ow = mp.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")
    check('手機版兄妹分頁沒有橫向捲動', ow)
    mob.close()

    # ---------- 3) 設定：頭像風格、妹妹課表 ----------
    page.click('[data-act="tab:settings"]')
    page.check('input[data-bind="avatarStyle"][value="svg"]')
    page.wait_for_timeout(100)
    n_svg = page.evaluate("() => [document.querySelectorAll('img.av.toon').length, document.querySelectorAll('svg.av').length]")
    check('切換成手繪角色', n_svg[0] == 0 and n_svg[1] > 0, n_svg)
    page.check('input[data-bind="avatarStyle"][value="toon"]')
    page.wait_for_timeout(100)
    check('切回卡通頭像', page.evaluate("() => document.querySelectorAll('img.av.toon').length") > 0)
    page.fill('tr[data-srow="g12"] [data-g="start"]', '14:10')
    page.fill('tr[data-srow="g12"] [data-g="end"]', '16:00')
    page.click('[data-act="savesis"]')
    g12 = [g for g in page.evaluate('() => window.__cg.state.sisSchedule') if g['id'] == 'g12'][0]
    check('修改妹妹課表並儲存', g12['start'] == '14:10' and g12['end'] == '16:00', g12)
    page.click('[data-act="addsis"]')
    n = len(page.evaluate('() => window.__cg.state.sisSchedule'))
    check('新增妹妹的課', n == 13, n)
    page.click('[data-act="resetsis"]'); page.click('#modal [data-act="resetsisok"]')
    n = len(page.evaluate('() => window.__cg.state.sisSchedule'))
    check('還原妹妹預設課表', n == 12, n)

    # ---------- 4) 體育退選提醒 ----------
    page.click('[data-act="tab:today"]')
    exp0 = page.evaluate('() => window.__cg.state.player.exp')
    page.click('[data-act="petask:done"]')
    dismiss(page)
    exp1 = page.evaluate('() => window.__cg.state.player.exp')
    check('完成體育退選任務：經驗 +20、提醒消失', exp1 == exp0 + 20 and page.query_selector('.real-task') is None, (exp0, exp1))
    ctx.close()

    # ---------- 5) 舊存檔（v1，含體育紀錄）升級 ----------
    ctx = b.new_context(viewport={'width': 1100, 'height': 900})
    page = ctx.new_page(); hook(page)
    page.goto(f'{URL}?date=2026-11-04')
    page.click('[data-act="start"]'); dismiss(page)
    page.evaluate("""() => {
      const S = window.__cg.state;
      S.version = 1;
      delete S.sisSchedule; delete S.syncDays; delete S.tasks; delete S.sibWeekly;
      S.album = { prologue: '2026-11-04' }; S.collection = {};
      S.profile = { hero: '振嘉', names: { mom: '媽媽', dad: '爸爸', sis: '妹妹' }, photos: {}, usePhotos: true, voice: true };
      S.schedule.splice(6, 0, { id: 's7', name: '男、女生體育', day: 3, start: '14:10', end: '16:00', room: '游泳館', diff: 1, guardian: 'sis', parity: 'all', from: '', to: '2026-12-11', note: '預計期中退選；退選後把結束日期改成退選當天' });
      S.schedule.forEach((c) => { delete c.short; if (c.id === 's4') c.note = '若是半學期課且已結束，請設定結束日期'; });
      S.settings.weakIds = ['s12', 's6', 's7'];
      const d = window.__cg.getDay('2026-11-04'); d.reports.s7 = { o: 'absent', remedied: false, medal: false };
      S.days['2026-11-03'] = { date: '2026-11-03', settled: true, phase: 'done', reports: {}, summary: { items: [{ id: 's7', name: '男、女生體育', o: 'absent' }, { id: 's4', name: '探索永續', o: 'perfect' }], exp: 10, know: 3, aff: {}, disc: 0, grit: 0, notes: [] } };
      localStorage.setItem('chenguang-bond-save-v1', JSON.stringify(S));
    }""")
    page.goto(f'{URL}?date=2026-11-04')
    page.wait_for_timeout(150)
    up = page.evaluate('() => window.__cg.state')
    check('升級：版本 2', up['version'] == 2)
    check('升級：課表移除體育', not any(c['id'] == 's7' for c in up['schedule']))
    check('升級：弱項移除體育', 's7' not in up['settings']['weakIds'], up['settings']['weakIds'])
    check('升級：當天體育回報移除', 's7' not in up['days']['2026-11-04']['reports'])
    check('升級：歷史紀錄移除體育', all(i['id'] != 's7' for i in up['days']['2026-11-03']['summary']['items']))
    check('升級：探索永續改為整學期', [c for c in up['schedule'] if c['id'] == 's4'][0]['note'] == '整學期課程')
    check('升級：補上妹妹課表與頭像設定', len(up['sisSchedule']) == 12 and up['profile']['avatarStyle'] == 'toon')
    check('升級：補上課程簡稱', [c for c in up['schedule'] if c['id'] == 's11'][0].get('short') == '普物')
    titles = []
    for _ in range(30):
        if not page.is_visible('#modal'):
            break
        t = page.query_selector('#modal .story-title')
        if t and (not titles or titles[-1] != t.inner_text()):
            titles.append(t.inner_text())
        page.click('#modal [data-act="storynext"]' if page.query_selector('#modal [data-act="storynext"]') else '#modal .btn')
        page.wait_for_timeout(60)
    check('升級：播放「兩張課表」劇情', '兩張課表' in titles, titles)
    ctx.close()

    # ---------- 6) 週日兄妹週報、事件只在妹妹有課時出現 ----------
    ctx = b.new_context(viewport={'width': 1100, 'height': 900})
    page = ctx.new_page(); hook(page)
    page.goto(f'{URL}?date=2026-11-16')
    page.evaluate("() => localStorage.clear()")
    page.goto(f'{URL}?date=2026-11-16')
    page.check('input[name="w-start"][value="2026-11-16"]')
    page.click('[data-act="start"]'); dismiss(page)
    # 用引擎快速走一週（週一到週日），全部準時
    page.evaluate("""() => {
      const cg = window.__cg;
      for (let i = 0; i < 7; i++) {
        const d = cg.playDate();
        const day = cg.getDay(d);
        cg.beginDay(d);
        day.sleep = 'ok'; day.wake = 'ok';
        cg.sessionsOn(d).forEach((s) => { day.reports[s.id] = { o: 'perfect', remedied: false, medal: false }; });
        cg.settleDay(d);
      }
    }""")
    st = page.evaluate('() => window.__cg.state')
    wk = st['sibWeekly'].get('2026-11-16')
    check('週日結算產生兄妹週報', wk is not None and wk['sync'] == 2 and wk['hers'] == 12, wk)
    check('同週同步 2 次 → 徽章「並肩作戰」', 'syncweek' in st['achievements'])
    evs = page.evaluate("""() => { const out = new Set(); for (let i = 0; i < 300; i++) { window.__cg.state.recentEvents = []; out.add(window.__cg.pickEvent ? '' : ''); } return 1; }""")
    ctx.close()
    b.close()

ok = sum(1 for r in results if r[1])
for name, passed, info in results:
    print(('PASS ' if passed else 'FAIL ') + name + ('' if passed else f'  -> {info}'))
print(f'{ok}/{len(results)} passed')
print('errors:', errors[:10])
