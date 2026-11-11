# 原單檔版的回歸測試（未修改測試邏輯，只把網址改成 GAME_URL，用來確認 ES Module 版遊戲行為不變）
import os
"""快速數值模擬：直接呼叫遊戲引擎跑完整學期，輸出每週進度。"""
import json, pathlib, sys
from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent
URL = os.environ.get('GAME_URL', 'http://127.0.0.1:8080/Morning-Bond/index.html')

JS = r"""
(policy) => {
  const cg = window.__cg;
  let seed = 12345;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  cg.handle('start', []);
  const S = cg.state;
  S.queue = [];
  cg.closeModal();
  const P = { perfect: [1, 0, 0], good: [0.88, 0.08, 0.04], mediocre: [0.72, 0.06, 0.22], poor: [0.5, 0.05, 0.45] }[policy];
  const snaps = [];
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
    // 依序學技能
    const order = ['dawn', 'endure', 'wish', 'clock', 'mutual', 'window', 'commute', 'stay', 'resonance', 'weekend', 'holiday', 'home'];
    for (const id of order) {
      if (S.player.level >= 2 && !S.player.skills[id]) { cg.handle('learn', [id]); }
    }
    S.queue = [];
    if (new Date(d).getUTCDay() === 0 || d === end) {
      snaps.push({ d, lv: S.player.level, exp: S.player.exp, disc: S.player.disc, grit: S.player.grit, know: cg.knowValue(),
        mom: S.bonds.mom.aff + '/L' + S.bonds.mom.lv, dad: S.bonds.dad.aff + '/L' + S.bonds.dad.lv, sis: S.bonds.sis.aff + '/L' + S.bonds.sis.lv });
    }
  }
  const album = Object.entries(S.album).sort((a, b) => a[1] < b[1] ? -1 : 1).map(([k, v]) => v.slice(5) + ' ' + k);
  return { snaps, ending: S.ending, album, ach: Object.keys(S.achievements), weekly: Object.values(S.weekly).filter(w => w.disc != null).length,
           items: S.items, skills: Object.keys(S.player.skills), knowPts: S.player.knowPts, target: cg.knowTarget(), holiday: S.holidayEv };
}
"""

with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
    for pol in (sys.argv[1:] or ['perfect', 'good', 'mediocre', 'poor']):
        ctx = b.new_context()
        page = ctx.new_page()
        errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.goto(f'{URL}?date=2026-11-11')
        res = page.evaluate(JS, pol)
        print(f'===== {pol} =====')
        for s in res['snaps']:
            print(f"{s['d']} Lv{s['lv']} exp{s['exp']:5} 自律{s['disc']:5} 堅毅{s['grit']:5} 學識{s['know']:3}  媽{s['mom']:>9} 爸{s['dad']:>9} 妹{s['sis']:>9}")
        e = res['ending']
        print('ENDING', e['type'], round(e['rate'] * 100), 'bond', e['bond'], 'know', e['know'], 'grade', e['grade'])
        print('album:', ', '.join(res['album']))
        print('ach:', res['ach'], 'weeklyDisc:', res['weekly'], 'items', res['items'], 'knowPts', res['knowPts'], '/', res['target'])
        print('holiday', res['holiday'])
        print('skills', res['skills'])
        if errs: print('ERRORS', errs[:5])
        ctx.close()
    b.close()
