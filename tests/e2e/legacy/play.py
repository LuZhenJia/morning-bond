# 原單檔版的回歸測試（未修改測試邏輯，只把網址改成 GAME_URL，用來確認 ES Module 版遊戲行為不變）
import os
"""無頭瀏覽器整學期試玩測試。用法：python3 test/play.py [模式]"""
import json, sys, random, pathlib, datetime as dt
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
URL = os.environ.get('GAME_URL', 'http://127.0.0.1:8080/Morning-Bond/index.html')
SHOT = ROOT.parent / 'shots'
SHOT.mkdir(parents=True, exist_ok=True)
MODE = sys.argv[1] if len(sys.argv) > 1 else 'good'
random.seed(7)

errors = []

def dismiss(page, limit=40):
    """關掉所有對話框（劇情、試煉、總結）。"""
    for _ in range(limit):
        if not page.is_visible('#modal'):
            return
        if page.query_selector('#modal [data-act="storynext"]'):
            page.click('#modal [data-act="storynext"]')
        elif page.query_selector('#modal [data-act^="evpick:"]'):
            page.click('#modal [data-act^="evpick:"]')
        elif page.query_selector('#modal [data-act="close"]'):
            page.click('#modal [data-act="close"]')
        elif page.query_selector('#modal [data-act^="skipok"]'):
            page.click('#modal [data-act^="skipok"]')
        else:
            page.click('#modal .btn')
        page.wait_for_timeout(80)
    raise RuntimeError('modal did not close')

def state(page):
    return page.evaluate('() => JSON.parse(JSON.stringify(window.__cg.state))')

def pd(page):
    return page.evaluate('() => window.__cg.playDate()')

def outcome_for(day_index, sid, date):
    if MODE == 'good':
        r = random.random()
        return 'perfect' if r < 0.88 else 'late' if r < 0.96 else 'absent'
    if MODE == 'bad':
        r = random.random()
        return 'perfect' if r < 0.5 else 'absent' if r < 0.8 else 'left'
    return 'perfect'

def play_day(page, date, idx, shots=False):
    page.goto(f'{URL}?date={date}')
    page.wait_for_selector('#view')
    dismiss(page)
    cur = pd(page)
    assert cur == date, f'play date {cur} != {date}'
    if page.query_selector('[data-act="sleep:ok"]'):
        sleep = 'late' if (MODE == 'bad' and random.random() < 0.3) else 'ok'
        page.click(f'[data-act="sleep:{sleep}"]')
        dismiss(page)
        if not page.evaluate('() => !!window.__cg.state.days[window.__cg.playDate()].wake'):
            wake = 'ok' if MODE != 'bad' or random.random() < 0.6 else 'over'
            page.click(f'[data-act="wake:{wake}"]')
        if page.query_selector('[data-act="supply"]'):
            page.click('[data-act="supply"]')
        if shots and idx == 0:
            page.screenshot(path=str(SHOT / 'morning.png'), full_page=True)
        page.click('[data-act="begin"]')
        dismiss(page)
    # 回報每一堂
    for _ in range(20):
        btns = page.query_selector_all('[data-act^="rep:"][data-act$=":perfect"]')
        if not btns:
            break
        sid = btns[0].get_attribute('data-act').split(':')[1]
        o = outcome_for(idx, sid, date)
        page.click(f'[data-act="rep:{sid}:{o}"]')
        page.wait_for_timeout(500)
        dismiss(page)
        if o == 'absent' and page.query_selector(f'[data-act="remedy:{sid}"]') and random.random() < 0.6:
            page.click(f'[data-act="remedy:{sid}"]')
            page.click('#modal [data-act^="remdo:"]')
            dismiss(page)
        if o == 'left' and page.query_selector(f'[data-act="medal:{sid}"]'):
            page.click(f'[data-act="medal:{sid}"]')
    if shots and idx in (0, 3):
        page.screenshot(path=str(SHOT / f'quests_{idx}.png'), full_page=True)
    if page.query_selector('[data-act="candy"]') and random.random() < 0.3:
        page.click('[data-act="candy"]')
    if page.query_selector('[data-act="toEvening"]'):
        page.click('[data-act="toEvening"]')
    who = page.query_selector_all('[data-act^="iwho:"]')
    if who:
        random.choice(who).click()
        page.click('[data-act^="inter:"]')
        dismiss(page)
    if page.query_selector('[data-act="review"]') and random.random() < 0.7:
        page.click('[data-act="review"]')
    if shots and idx == 0:
        page.screenshot(path=str(SHOT / 'evening.png'), full_page=True)
    page.click('[data-act="settle"]')
    page.wait_for_timeout(150)
    if shots and idx == 0:
        page.screenshot(path=str(SHOT / 'summary.png'))
    dismiss(page)
    # 有技能點就學
    st = state(page)
    if st['player']['level'] >= 2 and st['player']['sp'] > 0:
        page.click('[data-act="tab:skills"]')
        for b in page.query_selector_all('[data-act^="learn:"]'):
            b.click()
            page.wait_for_timeout(60)
            dismiss(page)
            break
        page.click('[data-act="tab:today"]')

def main():
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        ctx = b.new_context(viewport={'width': 1200, 'height': 900}, device_scale_factor=1)
        page = ctx.new_page()
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type in ('error', 'warning') else None)
        start = '2026-11-11'
        page.goto(f'{URL}?date={start}')
        page.screenshot(path=str(SHOT / 'welcome.png'), full_page=True)
        page.click('[data-act="start"]')
        page.wait_for_timeout(200)
        page.screenshot(path=str(SHOT / 'prologue.png'))
        dismiss(page)
        end = page.evaluate('() => { const s = window.__cg.state.settings; const d = new Date(s.semStart); return null; }')
        d = dt.date(2026, 11, 11)
        last = dt.date(2027, 1, 17)
        idx = 0
        while d <= last:
            play_day(page, d.isoformat(), idx, shots=(MODE == 'good'))
            if MODE == 'good' and d.isoformat() in ('2026-11-20', '2026-12-10', '2027-01-05'):
                for tab in ['today', 'bonds', 'skills', 'quests', 'album', 'records', 'settings']:
                    page.click(f'[data-act="tab:{tab}"]')
                    page.wait_for_timeout(80)
                    page.screenshot(path=str(SHOT / f'{d.isoformat()}_{tab}.png'), full_page=True)
                page.click('[data-act="tab:today"]')
            d += dt.timedelta(days=1)
            idx += 1
        st = state(page)
        page.goto(f'{URL}?date=2027-01-18')
        page.wait_for_timeout(200)
        page.screenshot(path=str(SHOT / f'end_{MODE}.png'), full_page=True)
        dismiss(page)
        page.click('[data-act="tab:album"]')
        page.screenshot(path=str(SHOT / f'album_{MODE}.png'), full_page=True)
        page.click('[data-act="tab:records"]')
        page.screenshot(path=str(SHOT / f'records_{MODE}.png'), full_page=True)
        st = state(page)
        summary = {
            'level': st['player']['level'], 'exp': st['player']['exp'], 'sp': st['player']['sp'],
            'skills': list(st['player']['skills'].keys()),
            'disc': st['player']['disc'], 'grit': st['player']['grit'], 'knowPts': st['player']['knowPts'],
            'know': page.evaluate('() => window.__cg.knowValue()'), 'target': page.evaluate('() => window.__cg.knowTarget()'),
            'bonds': st['bonds'], 'items': st['items'], 'ending': st['ending'],
            'album': sorted(st['album'].keys()), 'ach': sorted(st['achievements'].keys()), 'collection': sorted(st['collection'].keys()),
            'weekly': st['weekly'], 'monthly': st['monthly'], 'holidayEv': st['holidayEv'], 'midEv': st['midEv'],
            'counters': st['counters'], 'streak': st['streak'], 'queue': st['queue'], 'settled': st['settledThrough'],
        }
        print(json.dumps(summary, ensure_ascii=False, indent=1))
        print('ERRORS:', len(errors))
        for e in errors[:30]:
            print(' ', e)
        b.close()

main()
