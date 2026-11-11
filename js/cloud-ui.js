// =====================================================================
//  cloud-ui.js — 雲端存檔的狀態提示與對話框（只新增必要元件，沿用遊戲原本的樣式）
//    * 左下角狀態膠囊：正在連接雲端／雲端同步中／已同步／離線模式／同步失敗／存檔衝突
//    * 雲端存檔面板：立即同步、匯出入 JSON、復原代碼、雲端備份、刪除雲端存檔
//    * 衝突選擇、開機檢查、其他分頁提示
//  沒有設定雲端時完全不顯示，遊戲畫面與單檔版相同。
// =====================================================================
import { summarize } from './save-manager.js';

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pad = (n) => String(n).padStart(2, '0');
const hm = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const ymdhm = (iso) => { if (!iso) return ''; const d = new Date(iso); return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };

const VIEW = {
  disabled: ['💾', '本機模式'],
  connecting: ['⏳', '正在連接雲端'],
  syncing: ['🔄', '雲端同步中'],
  synced: ['✅', '已同步'],
  offline: ['📴', '離線模式'],
  error: ['⚠️', '同步失敗'],
  conflict: ['⚠️', '存檔衝突'],
  suspended: ['⏸', '已在其他分頁'],
};
const REASON = {
  autosave: '自動備份', settle: '每日結算', import: '匯入前', restore: '還原前', reset: '重新開始前', newsem: '新學期前',
  migration: '搬家前', 'conflict-keep-local': '衝突時的雲端版本', 'conflict-keep-cloud': '衝突時', recovery: '復原前',
  start: '開始時', manual: '手動同步', interval: '自動備份', resume: '自動備份', hidden: '自動備份', visible: '自動備份', pagehide: '自動備份',
};
const REDEEM_ERR = {
  invalid_code: '代碼不正確，請再檢查一次（大小寫、破折號都沒關係）。',
  invalid_format: '代碼格式不對：應該是 20 個英數字（例如 ABCD-EFGH-JKMN-PQRS-TVWX）。',
  code_used: '這組代碼已經用過了，請在原本的裝置重新產生。',
  code_expired: '代碼已過期，請在原本的裝置重新產生。',
  code_revoked: '這組代碼已作廢，請使用最新產生的代碼。',
  rate_limited: '嘗試次數太多，請一小時後再試。',
  not_authenticated: '雲端身分還沒準備好，請稍後再試。',
  function_not_deployed: '復原代碼功能還沒有部署（Supabase Edge Function：recover-save），請先依 README 部署。',
  function_unreachable: '連不到復原代碼功能：請確認已部署 Supabase Edge Function「recover-save」，而且 ALLOWED_ORIGINS 包含這個網站的網址。',
  server_misconfigured: '復原代碼功能的伺服器設定不完整（缺少 RECOVERY_CODE_PEPPER），請依 README 設定。',
  no_player: '雲端玩家資料還沒建立，請先按「立即同步」再試一次。',
};

export class CloudUI {
  constructor(mgr, game) {
    this.mgr = mgr;
    this.game = game;
    this.view = null;
    this.closable = true;
    this.lastCode = null;
  }

  mount() {
    this.pill = document.getElementById('cloud-pill');
    this.modal = document.getElementById('cloud-modal');
    if (!this.mgr.enabled) {
      if (this.mgr.problem === 'secret-key') console.error('[cloud] 偵測到 Secret / service_role 金鑰，雲端功能已停用。前端只能使用 Publishable key！');
      return;
    }
    this.pill.hidden = false;
    this.pill.addEventListener('click', () => this.openPanel());
    document.addEventListener('click', (e) => {
      const el = e.target.closest('[data-cloud]');
      if (!el) return;
      e.preventDefault();
      this.handle(el.dataset.cloud, el).catch((err) => this.error(err));
    });
    this.modal.addEventListener('change', (e) => { if (e.target.dataset && e.target.dataset.import && this.closable) this.close(); });
    this.modal.addEventListener('click', (e) => { if (e.target === this.modal && this.closable) this.close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !this.modal.hidden && this.closable) this.close(); });
    this.mgr.onStatus(() => this.render());
    const footer = document.querySelector('#app > footer');
    if (footer) footer.textContent = '晨光羈絆：學園修行物語 · 進度存在這個瀏覽器，並自動同步到雲端';
    this.render();
  }

  // ---------------------------------------------------------------------
  //  狀態膠囊
  // ---------------------------------------------------------------------
  statusLine() {
    const m = this.mgr;
    const [icon, label] = VIEW[m.status] || VIEW.error;
    let extra = '';
    if (m.status === 'synced' && m.meta.dirty) extra = '・待同步';
    else if (m.status === 'synced' && m.meta.syncedAt) extra = ` ${hm(m.meta.syncedAt)}`;
    else if (m.status === 'offline' && m.meta.dirty) extra = '・待同步';
    return { icon, label, extra };
  }

  render() {
    if (!this.pill || !this.mgr.enabled) return;
    const { icon, label, extra } = this.statusLine();
    this.pill.className = `cloud-pill st-${this.mgr.status}${this.mgr.meta.dirty ? ' dirty' : ''}`;
    this.pill.innerHTML = `<span class="cp-t"><span aria-hidden="true">${icon}</span> <span class="cp-l">${esc(label)}</span><span class="cp-x">${esc(extra)}</span></span>`;
    this.pill.title = this.mgr.detail || '雲端存檔';
    this.pill.setAttribute('aria-label', `雲端存檔：${label}${extra}`);
    const st = this.modal && !this.modal.hidden && this.modal.querySelector('[data-cloud-status]');
    if (st) st.innerHTML = this.statusHTML();
    const card = document.querySelector('[data-cloud-card-status]');
    if (card) card.textContent = this.cardStatusText();
    if (this.view === 'gate' && (this.mgr.ready || ['offline', 'error', 'disabled', 'suspended'].includes(this.mgr.status))) this.hideBootGate();
  }

  statusHTML() {
    const m = this.mgr;
    const { icon, label } = this.statusLine();
    const when = m.meta.syncedAt ? `最後成功同步：${ymdhm(m.meta.syncedAt)}` : '尚未同步過';
    const pending = m.meta.dirty ? `<span class="cl-pending">有尚未同步的變更${m.meta.dirtySince ? `（${hm(m.meta.dirtySince)} 起）` : ''}</span>` : '';
    return `<b>${icon} ${esc(label)}</b><span>${esc(when)}</span>${pending}${m.detail ? `<p>${esc(m.detail)}</p>` : ''}`;
  }

  // ---------------------------------------------------------------------
  //  對話框
  // ---------------------------------------------------------------------
  open(html, { closable = true, view = 'panel', wide = false } = {}) {
    this.view = view;
    this.closable = closable;
    this.modal.innerHTML = `<div class="modal-card cloud-card${wide ? ' wide' : ''}" role="dialog" aria-modal="true">${html}</div>`;
    this.modal.hidden = false;
    const f = this.modal.querySelector('input:not([type=file]), .btn.primary');
    if (f) setTimeout(() => f.focus(), 30);
  }

  close() {
    this.modal.hidden = true;
    this.modal.innerHTML = '';
    this.view = null;
    this.closable = true;
  }

  error(err) {
    const code = (err && (err.payload && err.payload.error)) || (err && err.message) || String(err);
    const msg = REDEEM_ERR[code] && !/^(invalid_code|invalid_format|code_used|code_expired|code_revoked)$/.test(code) ? REDEEM_ERR[code] : code;
    this.game.toast(`雲端操作失敗：${msg}`);
    console.warn('[cloud-ui]', err);
  }

  async openPanel() {
    if (this.mgr.status === 'conflict' && this.mgr.conflict) { this.showConflict(summarize(this.mgr.conflict.local), summarize(this.mgr.conflict.remote.state), this.mgr.conflict.remote, this.mgr.conflict.context); return; }
    if (this.mgr.status === 'suspended') { this.showOtherTab(true); return; }
    const m = this.mgr;
    const canCloud = m.ready && !!m.session;
    const ids = m.meta.playerId ? `<dt>玩家編號</dt><dd>${esc(m.meta.playerId.slice(0, 8))}…</dd>` : '';
    const rev = m.meta.saveId ? `<dt>雲端版本</dt><dd>第 ${esc(m.meta.revision)} 版</dd>` : '<dt>雲端存檔</dt><dd>尚未建立</dd>';
    this.open(`<h2>☁️ 雲端存檔</h2>
      <div class="cl-status" data-cloud-status>${this.statusHTML()}</div>
      <dl class="cl-meta">${ids}${rev}<dt>連結裝置</dt><dd data-cloud-devices>—</dd><dt>雲端回憶</dt><dd data-cloud-memories>—</dd></dl>
      <div class="row cl-actions">
        <button class="btn primary sm" data-cloud="sync">立即同步</button>
        <button class="btn ghost sm" data-cloud="export">匯出存檔 JSON</button>
        <label class="btn ghost sm">匯入存檔 JSON<input type="file" accept="application/json,.json" data-import="1" hidden></label>
      </div>
      <h4>🔑 換裝置／找回存檔</h4>
      <p class="hint">不需要帳號密碼。在這台裝置產生「復原代碼」，到新的裝置輸入，就能接回同一份雲端存檔（兩台裝置之後會自動同步）。</p>
      <div class="row cl-actions">
        <button class="btn ghost sm" data-cloud="code"${canCloud ? '' : ' disabled'}>產生復原代碼</button>
        <button class="btn ghost sm" data-cloud="redeem">輸入復原代碼</button>
      </div>
      <h4>🗂️ 雲端備份</h4>
      <p class="hint">每次結算、匯入、還原、重新開始之前，雲端都會自動備份上一個版本（保留最近 40 份）。</p>
      <div class="row cl-actions"><button class="btn ghost sm" data-cloud="snapshots"${m.meta.saveId && canCloud ? '' : ' disabled'}>查看雲端備份</button></div>
      <h4>進階</h4>
      <div class="row cl-actions">${m.meta.optOut
        ? '<button class="btn ghost sm" data-cloud="enable">重新開啟雲端同步</button>'
        : `<button class="btn danger sm" data-cloud="delete"${m.meta.saveId && canCloud ? '' : ' disabled'}>刪除雲端存檔</button>`}</div>
      <div class="actions"><button class="btn ghost" data-cloud="close">關閉</button></div>`, { view: 'panel' });
    if (canCloud) {
      m.listDevices().then((d) => { const el = this.modal.querySelector('[data-cloud-devices]'); if (el) el.textContent = `${d.length} 台${d.length > 1 ? '（會互相同步）' : ''}`; }).catch(() => {});
      m.listMemories().then((r) => {
        const el = this.modal.querySelector('[data-cloud-memories]');
        if (!el || !r) return;
        const c = r.counts || {};
        const parts = [['story', '劇情'], ['achievement', '徽章'], ['collection', '收藏'], ['share', '訊息'], ['log', '日誌']].filter(([k]) => c[k]).map(([k, n]) => `${n} ${c[k]}`);
        el.textContent = parts.length ? parts.join('・') : '還沒有紀錄';
      }).catch(() => {});
    }
  }

  async handle(act, el) {
    const m = this.mgr;
    const [a, arg] = act.split(':');
    switch (a) {
      case 'close': this.close(); return;
      case 'panel': await this.openPanel(); return;
      case 'sync': {
        await m.syncSave();
        this.game.toast(m.status === 'synced' ? '☁️ 已同步' : `☁️ ${(VIEW[m.status] || VIEW.error)[1]}`);
        if (this.view === 'panel') await this.openPanel();
        return;
      }
      case 'export': await m.exportSave(); this.game.toast('已匯出存檔'); return;
      case 'code': {
        el.disabled = true;
        try {
          const r = await m.createRecoveryCode();
          this.lastCode = r.code;
          this.open(`<h2>🔑 復原代碼</h2>
            <p>在新的裝置打開遊戲 → 按左下角「雲端」→「輸入復原代碼」，就能接回這份存檔。</p>
            <div class="cl-code" data-cloud-code>${esc(r.code)}</div>
            <p class="hint">有效期限：${esc(ymdhm(r.expires_at))}，只能使用一次；產生新的代碼後舊的會失效。<b>任何拿到代碼的人都能讀寫你的存檔，請不要分享給別人。</b>代碼只會顯示這一次，請先抄下來或截圖。</p>
            <div class="actions"><button class="btn ghost" data-cloud="copy">複製代碼</button><button class="btn primary" data-cloud="panel">完成</button></div>`, { view: 'code' });
        } finally { el.disabled = false; }
        return;
      }
      case 'copy': {
        try { await navigator.clipboard.writeText(this.lastCode || ''); this.game.toast('已複製復原代碼'); } catch (e) { this.game.toast('無法自動複製，請手動抄下代碼'); }
        return;
      }
      case 'redeem': this.showRedeem(); return;
      case 'redeem-go': await this.doRedeem(false); return;
      case 'redeem-force': await this.doRedeem(true); return;
      case 'snapshots': await this.showSnapshots(); return;
      case 'restore': {
        this.open(`<h2>還原這個雲端備份？</h2><p>目前的進度會先自動備份（雲端與這台裝置各一份），之後隨時可以再還原回來。</p>
          <div class="actions"><button class="btn ghost" data-cloud="snapshots">取消</button><button class="btn primary" data-cloud="restore-go:${esc(arg)}">還原</button></div>`, { view: 'restore' });
        return;
      }
      case 'restore-go': {
        el.disabled = true;
        await m.restoreSave(arg);
        this.close();
        return;
      }
      case 'delete': {
        this.open(`<h2>刪除雲端存檔？</h2><p>會刪除雲端上的存檔、雲端備份與雲端回憶紀錄，並停用自動同步。<b>這台裝置的進度不會被刪除</b>，之後可以再重新開啟雲端同步。</p>
          <p>確定的話請輸入「刪除」：</p><input id="cl-del-input" autocomplete="off" maxlength="10">
          <div class="actions"><button class="btn ghost" data-cloud="panel">取消</button><button class="btn danger" data-cloud="delete-go">刪除雲端存檔</button></div>`, { view: 'delete' });
        return;
      }
      case 'delete-go': {
        const v = (this.modal.querySelector('#cl-del-input') || {}).value || '';
        if (v.trim() !== '刪除') { this.game.toast('請輸入「刪除」確認'); return; }
        await m.deleteSave();
        this.game.toast('已刪除雲端存檔（本機進度仍在）');
        await this.openPanel();
        return;
      }
      case 'enable': await m.enableSync(); this.game.toast('已重新開啟雲端同步'); await this.openPanel(); return;
      case 'keep-local': this.close(); await m.resolveConflict('local'); this.game.toast('已保留這台裝置的進度（雲端舊版本已備份）'); return;
      case 'keep-cloud': this.close(); await m.resolveConflict('cloud'); return;
      case 'dl-both': this.downloadConflictPair(); return;
      case 'takeover': m.takeOver(); return;
      case 'offline-start': this.hideBootGate(true); return;
      default:
    }
  }

  showRedeem(errMsg = '') {
    this.open(`<h2>輸入復原代碼</h2>
      <p>輸入在原本裝置產生的 20 碼復原代碼，這台裝置就會接回同一份雲端存檔。</p>
      <input id="cl-code-input" class="cl-code-input" placeholder="XXXX-XXXX-XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="40">
      <p class="cl-err"${errMsg ? '' : ' hidden'}>${esc(errMsg)}</p>
      <p class="hint">如果這台裝置已經有進度，接回前會先在本機留一份備份。</p>
      <div class="actions"><button class="btn ghost" data-cloud="${this.game.getState().started ? 'panel' : 'close'}">取消</button><button class="btn primary" data-cloud="redeem-go">接回存檔</button></div>`, { view: 'redeem' });
  }

  async doRedeem(force) {
    const input = this.modal.querySelector('#cl-code-input');
    const code = force ? this.pendingCode : (input ? input.value : '');
    this.pendingCode = code;
    if (!code || !code.trim()) { this.showRedeem('請輸入復原代碼'); return; }
    try {
      this.open('<h2>⏳ 正在接回雲端存檔…</h2><p>請稍候。</p>', { closable: false, view: 'busy' });
      await this.mgr.redeemRecoveryCode(code, force);
      if (this.mgr.status !== 'conflict') this.close();
      this.game.toast('✅ 已接回雲端存檔，這台裝置之後會自動同步');
    } catch (e) {
      const code2 = (e && e.payload && e.payload.error) || (e && e.message);
      if (code2 === 'has_own_progress') {
        this.open(`<h2>這台裝置在雲端也有自己的進度</h2>
          <p>接回後，這台裝置會改用原本那份雲端存檔；目前這台裝置的進度會先在本機留一份備份。建議先匯出 JSON 保存。</p>
          <div class="actions"><button class="btn ghost" data-cloud="export">先匯出 JSON</button><button class="btn ghost" data-cloud="close">取消</button><button class="btn primary" data-cloud="redeem-force">確定接回</button></div>`, { view: 'redeem-confirm' });
        return;
      }
      if (e && e.kind === 'network') { this.showRedeem('目前無法連線雲端，請確認網路後再試。'); return; }
      this.showRedeem(REDEEM_ERR[code2] || `接回失敗：${code2}`);
    }
  }

  async showSnapshots() {
    const list = await this.mgr.listSnapshots();
    const rows = (list || []).map((s) => `<li><div><b>${esc(ymdhm(s.created_at))}</b><span>${esc(REASON[s.reason] || s.reason)}・Lv${esc(s.player_level || 1)}${s.settled_through ? `・結算到 ${esc(s.settled_through.slice(5).replace('-', '/'))}` : ''}</span></div>
      <button class="btn ghost sm" data-cloud="restore:${esc(s.id)}">還原</button></li>`).join('');
    this.open(`<h2>🗂️ 雲端備份</h2>
      ${rows ? `<ul class="cl-snaps">${rows}</ul>` : '<p class="hint">還沒有備份。之後每次結算、匯入或重新開始前都會自動備份。</p>'}
      <div class="actions"><button class="btn ghost" data-cloud="panel">返回</button></div>`, { view: 'snapshots', wide: true });
  }

  // ---------------------------------------------------------------------
  //  衝突
  // ---------------------------------------------------------------------
  showConflict(local, cloud, remote, context) {
    const better = (a, b) => (a.settledThrough || '') > (b.settledThrough || '') || ((a.settledThrough || '') === (b.settledThrough || '') && (a.level * 100000 + a.exp) > (b.level * 100000 + b.exp));
    const preferCloud = context === 'recovery' || better(cloud, local);
    const side = (title, s, extra) => `<div class="cl-side"><h4>${title}</h4><ul>
      <li>名字：${esc(s.hero || '—')}</li><li>等級：Lv${esc(s.level)}（經驗 ${esc(s.exp)}）</li>
      <li>已結算到：${esc(s.settledThrough || '—')}</li><li>結算天數：${esc(s.days)} 天</li>
      <li>紀念冊：${esc(s.album)} 張・徽章 ${esc(s.achievements)} 枚</li>${extra}</ul></div>`;
    const why = {
      'first-link': '這台裝置原本就有進度，雲端上也已經有另一份存檔。',
      'both-changed': '這台裝置和另一台裝置都在同一段時間修改了進度。',
      recovery: '你剛接回雲端存檔，但這台裝置原本也有進度。',
    }[context] || '這台裝置與雲端的進度不同。';
    this.open(`<h2>⚠️ 兩邊的進度不一樣</h2>
      <p>${esc(why)}請選擇要繼續使用哪一份。</p>
      <div class="cl-compare">${side('📱 這台裝置', local, '')}${side('☁️ 雲端', cloud, `<li>雲端更新：${esc(ymdhm(remote.updated_at))}</li>`)}</div>
      <p class="hint">不論選哪一份，另一份都不會消失：這台裝置的版本會留在本機備份，雲端版本會存進雲端備份，之後可以在「雲端備份」還原。</p>
      <div class="actions cl-actions-wrap">
        <button class="btn ghost" data-cloud="dl-both">先下載兩份 JSON</button>
        <button class="btn ${preferCloud ? 'primary' : 'ghost'}" data-cloud="keep-cloud">使用雲端的進度</button>
        <button class="btn ${preferCloud ? 'ghost' : 'primary'}" data-cloud="keep-local">保留這台裝置的進度</button>
      </div>`, { closable: false, view: 'conflict', wide: true });
  }

  downloadConflictPair() {
    const c = this.mgr.conflict;
    if (!c) return;
    const dl = (obj, name) => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' }));
      a.download = name;
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    };
    const t = this.game.today();
    dl(c.local, `晨光羈絆存檔-這台裝置-${t}.json`);
    setTimeout(() => dl(c.remote.state, `晨光羈絆存檔-雲端-${t}.json`), 300);
  }

  // ---------------------------------------------------------------------
  //  開機檢查（新裝置先看看雲端有沒有存檔，避免一開始就分岔）
  // ---------------------------------------------------------------------
  showBootGate() {
    if (!this.mgr.enabled || this.mgr.ready) return;
    this.open(`<div class="cl-gate"><h2>⏳ 正在連接雲端</h2><p>正在檢查有沒有雲端存檔，請稍候…</p>
      <div class="actions"><button class="btn ghost sm" data-cloud="offline-start" hidden>先離線開始</button></div></div>`, { closable: false, view: 'gate' });
    setTimeout(() => { const b = this.modal.querySelector('[data-cloud="offline-start"]'); if (b) b.hidden = false; }, 3000);
  }

  hideBootGate(force = false) {
    if (this.view === 'gate' || force) this.close();
  }

  showOtherTab(wasActive) {
    this.open(`<h2>${wasActive ? '⏸ 遊戲已移到另一個分頁' : '🗂️ 遊戲已在另一個分頁開啟'}</h2>
      <p>為了避免兩個分頁的進度互相覆蓋，同一個瀏覽器一次只能在一個分頁遊玩。</p>
      <div class="actions"><button class="btn primary" data-cloud="takeover">在這個分頁繼續</button></div>`, { closable: false, view: 'other-tab' });
  }

  // ---------------------------------------------------------------------
  //  嵌進遊戲畫面的小區塊（只在雲端模式出現）
  // ---------------------------------------------------------------------
  welcomeExtraHTML() {
    return `<div class="cl-welcome"><b>☁️ 已經在別的裝置玩過？</b>
      <span>可以輸入復原代碼接回雲端存檔，或匯入從舊版（單檔 HTML）「設定 → 匯出存檔」下載的 JSON。</span>
      <div class="row"><button class="btn ghost sm" data-cloud="redeem">輸入復原代碼</button>
      <label class="btn ghost sm">匯入存檔 JSON<input type="file" accept="application/json,.json" data-import="1" hidden></label></div></div>`;
  }

  cardStatusText() {
    const { icon, label, extra } = this.statusLine();
    return `${icon} ${label}${extra}${this.mgr.detail ? `：${this.mgr.detail}` : ''}`;
  }

  settingsCardHTML() {
    return `<div class="card"><h3>☁️ 雲端存檔</h3>
      <p class="hint" data-cloud-card-status>${esc(this.cardStatusText())}</p>
      <div class="row"><button class="btn primary sm" data-cloud="panel">開啟雲端存檔</button><button class="btn ghost sm" data-cloud="sync">立即同步</button></div></div>`;
  }
}
