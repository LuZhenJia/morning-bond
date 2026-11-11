# 原單檔版的回歸測試（未修改測試邏輯，只把網址改成 GAME_URL，用來確認 ES Module 版遊戲行為不變）
import os
"""補充測試：明天開始、補登、手機版面、照片、設定、匯出匯入、道具與重啟。"""
import json, pathlib, base64, struct, zlib
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
URL = os.environ.get('GAME_URL', 'http://127.0.0.1:8080/Morning-Bond/index.html')
SHOT = ROOT.parent / 'shots'
SHOT.mkdir(parents=True, exist_ok=True)
errors = []
results = []

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

def png(path, color=(220, 120, 140)):
    w, h = 64, 80
    raw = b''.join(b'\x00' + bytes(color) * w for _ in range(h))
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    data = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b'')
    pathlib.Path(path).write_bytes(data)

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])

    # 1) 明天開始
    ctx = b.new_context(viewport={'width': 1100, 'height': 900}, accept_downloads=True)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
    page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type == 'error' else None)
    page.goto(f'{URL}?date=2026-11-11')
    page.check('input[name="w-start"][value="2026-11-12"]')
    page.click('[data-act="start"]')
    dismiss(page)
    check('明天開始：顯示準備畫面', '修行準備中' in page.inner_text('#view'))
    page.goto(f'{URL}?date=2026-11-12')
    dismiss(page)
    check('明天開始：隔天進入晨起', page.query_selector('[data-act="sleep:ok"]') is not None)

    # 2) 補登：直接跳到 11/15
    page.goto(f'{URL}?date=2026-11-15')
    dismiss(page)
    check('補登：出現補登列', '補登模式' in page.inner_text('#view'))
    page.click('[data-act="skip:one"]')
    page.click('#modal [data-act="skipok:one"]')
    page.wait_for_timeout(100)
    dismiss(page)
    pdv = page.evaluate('() => window.__cg.playDate()')
    check('補登：結算一天後前進到 11/13', pdv == '2026-11-13', pdv)
    page.click('[data-act="skip:all"]')
    page.click('#modal [data-act="skipok:all"]')
    page.wait_for_timeout(100)
    dismiss(page)
    pdv = page.evaluate('() => window.__cg.playDate()')
    check('補登：全部結算到今天', pdv == '2026-11-15', pdv)
    st = page.evaluate('() => window.__cg.state.days["2026-11-12"].summary.items.map(i => i.o)')
    check('補登：未回報記為 none', all(o == 'none' for o in st), st)

    # 3) 道具、補救、勳章、糖果、重啟（直接給道具）
    page.goto(f'{URL}?date=2026-11-16')
    dismiss(page)
    # 11/15 週日先結算
    page.click('[data-act="sleep:ok"]'); page.click('[data-act="wake:snooze"]')
    page.evaluate('() => { const S = window.__cg.state; S.items.supply = 1; S.items.medal = 1; S.items.candy = 1; window.__cg.render(); }')
    check('補給包按鈕出現', page.query_selector('[data-act="supply"]') is not None)
    page.click('[data-act="supply"]')
    check('補給包已使用', page.evaluate('() => window.__cg.state.days[window.__cg.playDate()].supply') is True)
    page.click('[data-act="begin"]'); dismiss(page)
    page.click('[data-act="settle"]'); dismiss(page)
    check('週日結算完成', page.evaluate('() => window.__cg.playDate()') == '2026-11-16')
    page.click('[data-act="sleep:ok"]'); page.click('[data-act="wake:ok"]'); page.click('[data-act="begin"]'); dismiss(page)
    page.click('[data-act="rep:s1:left"]'); page.wait_for_timeout(100); dismiss(page)
    check('勳章按鈕出現', page.query_selector('[data-act="medal:s1"]') is not None)
    page.click('[data-act="medal:s1"]')
    check('勳章已使用', page.evaluate('() => window.__cg.state.days["2026-11-16"].reports.s1.medal') is True)
    page.click('[data-act="rep:s2:absent"]'); page.wait_for_timeout(100); dismiss(page)
    page.click('[data-act="remedy:s2"]')
    page.screenshot(path=str(SHOT / 'remedy.png'))
    page.click('#modal [data-act="remdo:s2:notes"]')
    dismiss(page)
    check('補救完成', page.evaluate('() => window.__cg.state.days["2026-11-16"].reports.s2.remedied') is True)
    page.click('[data-act="candy"]')
    check('糖果已使用', page.evaluate('() => window.__cg.state.days["2026-11-16"].candy') is True)
    page.click('[data-act="restart"]')
    page.screenshot(path=str(SHOT / 'restart.png'))
    dismiss(page)
    check('重啟已使用', page.evaluate('() => window.__cg.state.days["2026-11-16"].restart') is True)
    page.click('[data-act="unrep:s1"]')
    check('取消回報退回勳章', page.evaluate('() => window.__cg.state.items.medal') == 1)
    page.click('[data-act="rep:s1:perfect"]'); page.wait_for_timeout(500); dismiss(page)
    page.click('[data-act="toEvening"]')
    page.click('[data-act="iwho:mom"]'); page.click('[data-act="inter:mom:call"]'); dismiss(page)
    page.click('[data-act="settle"]'); dismiss(page)
    sm = page.evaluate('() => window.__cg.state.days["2026-11-16"].summary')
    check('結算含補救', any(i['remedied'] for i in sm['items']), [i['o'] for i in sm['items']])

    # 4) 設定：名字、課表、假日、學期
    page.click('[data-act="tab:settings"]')
    page.fill('[data-pf="mom"]', '老媽')
    page.click('[data-act="saveprofile"]')
    check('稱呼更新', page.evaluate('() => window.__cg.state.profile.names.mom') == '老媽')
    page.fill('tr[data-row="s2"] [data-f="name"]', '化工安全（測試）')
    page.click('[data-act="savesched"]')
    check('課名更新', page.evaluate('() => window.__cg.state.schedule.find(s => s.id === "s2").name') == '化工安全（測試）')
    n0 = page.evaluate('() => window.__cg.state.schedule.length')
    page.click('[data-act="addcourse"]')
    check('新增課', page.evaluate('() => window.__cg.state.schedule.length') == n0 + 1)
    last = page.evaluate('() => window.__cg.state.schedule[window.__cg.state.schedule.length - 1].id')
    page.click(f'[data-act="delcourse:{last}"]')
    check('刪除課', page.evaluate('() => window.__cg.state.schedule.length') == n0)
    page.fill('#hol-d', '2026-11-20'); page.fill('#hol-n', '校慶補假')
    page.click('[data-act="addhol"]')
    check('新增假日', page.evaluate('() => window.__cg.state.settings.holidays.some(h => h.date === "2026-11-20")'))
    check('假日當天沒有課', page.evaluate('() => window.__cg.sessionsOn("2026-11-20").length') == 0)
    # 照片
    png('/tmp/face.png')
    page.set_input_files('input[data-photo="mom"]', '/tmp/face.png')
    page.wait_for_timeout(400)
    check('照片上傳', page.evaluate('() => (window.__cg.state.profile.photos.mom || "").startsWith("data:image/jpeg")'))
    page.screenshot(path=str(SHOT / 'settings_photo.png'))
    # 匯出
    with page.expect_download() as dl:
        page.click('[data-act="export"]')
    path = dl.value.path()
    data = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    check('匯出存檔', data.get('profile', {}).get('names', {}).get('mom') == '老媽')
    # 重置再匯入
    page.click('[data-act="reset"]'); page.click('#modal [data-act="resetok"]')
    page.wait_for_timeout(100)
    check('重置回到歡迎畫面', page.query_selector('[data-act="start"]') is not None)
    pathlib.Path('/tmp/save.json').write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    page.evaluate("() => { const i = document.createElement('input'); i.type = 'file'; i.dataset.import = '1'; i.id = 'imp'; document.body.appendChild(i); }")
    page.set_input_files('#imp', '/tmp/save.json')
    page.wait_for_timeout(400)
    check('匯入存檔', page.evaluate('() => window.__cg.state.profile.names.mom') == '老媽')
    ctx.close()

    # 5) 手機版面
    ctx = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True)
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append(f'pageerror(m): {e}'))
    page.goto(f'{URL}?date=2026-11-11')
    page.screenshot(path=str(SHOT / 'm_welcome.png'), full_page=True)
    page.click('[data-act="start"]')
    page.wait_for_timeout(150)
    page.screenshot(path=str(SHOT / 'm_story.png'))
    # 鍵盤翻頁
    page.keyboard.press('Enter')
    check('Enter 翻頁', page.evaluate('() => document.querySelector("#modal .story") !== null'))
    dismiss(page)
    page.screenshot(path=str(SHOT / 'm_morning.png'), full_page=True)
    page.click('[data-act="sleep:ok"]'); page.click('[data-act="wake:ok"]'); page.click('[data-act="begin"]'); dismiss(page)
    page.screenshot(path=str(SHOT / 'm_quests.png'), full_page=True)
    page.click('[data-act="tab:bonds"]')
    page.screenshot(path=str(SHOT / 'm_bonds.png'), full_page=True)
    page.click('[data-act="tab:records"]')
    page.screenshot(path=str(SHOT / 'm_records.png'), full_page=True)
    ctx.close()
    b.close()

for n, ok, info in results:
    print(('PASS' if ok else 'FAIL'), n, '' if ok else info)
print('ERRORS:', len(errors))
for e in errors[:20]:
    print(' ', e)
