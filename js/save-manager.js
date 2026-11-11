// =====================================================================
//  save-manager.js — 存檔管理器：本機優先、雲端同步、舊存檔遷移、衝突處理
//
//  資料流
//    遊戲每次 save() → 本機 localStorage（原本的行為）→ afterSave 掛勾 → 標記「待同步」
//    → debounce（連續操作合併）→ push()：比對 revision 後寫入雲端（同一時間只會有一個請求）
//
//  安全原則
//    * 本機存檔永遠先寫、永遠不被刪除；雲端只是同步目標。
//    * 啟動時一定先比對雲端，比對完成前不上傳（避免空白存檔覆蓋雲端）。
//    * 雲端 revision 與本機記錄不同時，絕不直接覆蓋：能判斷的自動處理，判斷不了就請玩家選擇，
//      而且兩個版本都會留下備份（本機備份＋雲端 save_snapshots）。
//    * 網路中斷時保留「待同步」標記（也存在 localStorage），恢復連線或下次開啟時自動補傳。
// =====================================================================
import { CloudAuth, CloudError, cloudConfigProblem, PROBLEM_TEXT } from './supabase.js';
import { CloudSaveAPI } from './cloud-save.js';
import {
  SLOT, KEYS, readJSON, writeJSON, readRaw, writeRaw, getClientId, stableStringify, sha256Hex,
  saveLocalBackup, PhotoCache, dataUrlInfo, uploadPhoto, downloadPhoto, removePhotos, PHOTO_MAX_BYTES,
} from './storage.js';

const IMMEDIATE = new Set(['start', 'settle', 'reset', 'import', 'newsem', 'photo', 'photo-uploaded']);
const SNAPSHOT_REASONS = new Set(['reset', 'import', 'newsem', 'migration']);
const RETRY_DELAYS = [2000, 5000, 15000, 30000, 60000];
const WHO = new Set(['hero', 'dad', 'mom', 'sis']);
const nowIso = () => new Date().toISOString();

function deviceLabel() {
  const ua = navigator.userAgent || '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '瀏覽器';
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return `${browser}${os ? ' · ' + os : ''}`.slice(0, 80);
}

export function summarize(state) {
  if (!state || typeof state !== 'object') return null;
  const days = state.days && typeof state.days === 'object' ? Object.values(state.days) : [];
  return {
    started: !!state.started,
    hero: (state.profile && state.profile.hero) || '',
    level: (state.player && state.player.level) || 1,
    exp: (state.player && state.player.exp) || 0,
    settledThrough: state.settledThrough || null,
    days: days.filter((d) => d && d.settled).length,
    album: state.album ? Object.keys(state.album).length : 0,
    achievements: state.achievements ? Object.keys(state.achievements).length : 0,
    version: state.version || 1,
  };
}

export class SaveManager {
  constructor({ game, config }) {
    this.game = game;
    this.cfg = config;
    this.slot = SLOT;
    this.problem = cloudConfigProblem(config);
    this.enabled = !this.problem;
    this.meta = this._loadMeta();
    this.clientId = this.enabled ? getClientId() : null;
    this.photoCache = new PhotoCache(KEYS.photos);
    this.status = this.enabled ? 'connecting' : 'disabled';
    this.detail = this.enabled ? '' : PROBLEM_TEXT[this.problem] || '';
    this.listeners = new Set();
    this.ui = null;
    this.auth = null;
    this._apiObj = null;
    this.cloudStarted = false;
    this.leader = undefined;
    this.session = null;
    this.ready = false;
    this.suspended = false;
    this.readOnly = false;
    this.applyingRemote = false;
    this.localSeq = 0;
    this.inFlight = null;
    this.pushAgain = false;
    this.debounceTimer = null;
    this.firstDirtyAt = 0;
    this.retryTimer = null;
    this.retryIndex = 0;
    this.conflict = null;
    this.downloads = new Map();
    this.lastRefs = null;
    this._photoDeleting = false;
    this._photoCheckAt = 0;
    this._photoKept = new Set();
    this.bootPromise = null;
    this.readyResolvers = [];
    this.gameVersion = (game.defaultState().version) || 2;
  }

  // -------------------------------------------------------------------
  //  狀態與事件
  // -------------------------------------------------------------------
  attachUI(ui) { this.ui = ui; }
  // 雲端 API（第一次連線時才建立；還沒建立時呼叫會得到「尚未連上雲端」的 network 錯誤）
  get api() {
    if (!this._apiObj) throw new CloudError('network', '尚未連上雲端，請稍後再試。');
    return this._apiObj;
  }
  onStatus(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  _setStatus(status, detail = '') {
    this.status = status;
    this.detail = detail;
    for (const fn of this.listeners) { try { fn(status, detail); } catch (e) { console.warn(e); } }
  }
  _notice(msg) { try { this.game.toast(msg); } catch (e) { /* 忽略 */ } }
  whenReady(timeoutMs) {
    if (this.ready || !this.enabled) return Promise.resolve(true);
    return new Promise((resolve) => {
      this.readyResolvers.push(resolve);
      if (timeoutMs) setTimeout(() => resolve(false), timeoutMs);
    });
  }
  _markReady() {
    this.ready = true;
    const rs = this.readyResolvers.splice(0);
    rs.forEach((r) => r(true));
  }

  // -------------------------------------------------------------------
  //  本機中繼資料（每個 slot 一份）
  // -------------------------------------------------------------------
  _defaultMeta() {
    return {
      v: 1, userId: null, playerId: null, saveId: null, revision: null, syncedHash: null, syncedAt: null,
      dirty: false, dirtySince: null, pendingReason: null, migration: null, optOut: false,
      pendingPhotoDeletes: [], lastError: null, identityResetAt: null, recentOps: [],
    };
  }
  // 還沒確認結果的寫入 [{ checksum, opId, baseRevision, saveId }]（最近 10 筆），存在 localStorage：
  // 送出後回應遺失、或送出後頁面馬上被關閉／重新整理時，下次比對仍認得「雲端那一版是這台裝置寫的」，
  // 不會誤判成兩台裝置衝突。寫入成功（拿到新的 revision）後清空。
  get lastPushed() { const a = this.meta.recentOps; return a && a.length ? a[a.length - 1] : null; }
  set lastPushed(v) {
    if (!v) { this.meta.recentOps = []; return; }
    const a = (this.meta.recentOps || []).filter((x) => x && x.opId !== v.opId);
    a.push(v);
    this.meta.recentOps = a.slice(-10);
  }
  _isOwnWrite(remote) {
    if (!remote || !remote.last_op_id) return false;
    return (this.meta.recentOps || []).some((x) => x && x.opId === remote.last_op_id);
  }
  _loadMeta() { return Object.assign(this._defaultMeta(), readJSON(KEYS.meta, {}) || {}); }
  _saveMeta() { if (this.enabled) writeJSON(KEYS.meta, this.meta); }
  _markDirty() {
    if (!this.meta.dirty) { this.meta.dirty = true; this.meta.dirtySince = nowIso(); this._saveMeta(); }
  }
  _markClean() {
    if (this.meta.dirty) { this.meta.dirty = false; this.meta.dirtySince = null; }
  }

  // -------------------------------------------------------------------
  //  給遊戲本體的掛勾
  // -------------------------------------------------------------------
  hooks() {
    const on = this.enabled;
    return {
      allowSave: on ? () => !this.suspended : null,
      afterSave: (reason) => this._afterLocalSave(reason),
      onEvent: (name, detail) => this._onGameEvent(name, detail),
      photoURL: (who) => this._photoURL(who),
      exportState: on ? (S) => this.exportState(S) : null,
      welcomeNote: on ? () => '遊戲進度會自動同步到雲端；換裝置時可以用「雲端存檔 → 復原代碼」找回，也可以匯出 JSON 備份。' : null,
      welcomeExtra: on ? () => (this.ui ? this.ui.welcomeExtraHTML() : '') : null,
      settingsCard: on ? () => (this.ui ? this.ui.settingsCardHTML() : '') : null,
      saveNote: on ? () => '進度先存在這個瀏覽器，並自動同步到 Supabase 雲端（狀態請看上方「雲端存檔」）。換電腦或瀏覽器時，可以用復原代碼，或匯出／匯入 JSON 搬家。' : null,
    };
  }

  // 遊戲讀取本機存檔「之前」呼叫：發現舊版存檔就先完整備份一份（不會刪除）
  preInit() {
    if (!this.enabled) return;
    const raw = this.game.readLocalRaw();
    this.legacyDetected = !!raw && !this.meta.migration && !this.meta.saveId && !this.meta.userId;
    if (this.legacyDetected && !readRaw(KEYS.legacyBackup)) {
      if (!writeRaw(KEYS.legacyBackup, raw)) console.warn('[migrate] 無法另存舊版存檔備份（空間不足），原本的存檔仍在原位置');
    }
  }

  _afterLocalSave(reason) {
    if (!this.enabled || this.suspended) return;
    if (this.applyingRemote) { this.lastRefs = null; this._trackPhotoRefs(); return; }
    this._trackPhotoRefs();
    const S = this.game.getState();
    // 還沒開始的遊戲（歡迎畫面）沒有東西要同步；「重新開始」由 reset 事件負責標記
    if (S && !S.started && this.meta.pendingReason !== 'reset' && reason !== 'reset') return;
    this.localSeq++;
    this._markDirty();
    this._schedulePush(IMMEDIATE.has(reason) ? 300 : this.cfg.autosaveDebounceMs);
  }

  _onGameEvent(name, detail) {
    if (!this.enabled || this.suspended) return;
    const S = this.game.getState();
    if (name === 'before-import' || name === 'before-reset') {
      if (S && S.started) saveLocalBackup(name, S);
      return;
    }
    if (SNAPSHOT_REASONS.has(name)) { this.meta.pendingReason = name; this.localSeq++; this._markDirty(); this._saveMeta(); }
    if (name === 'photo-delete' && detail && detail.who) this.photoCache.remove(detail.who);
    if (IMMEDIATE.has(name) || name === 'photo-delete') this._schedulePush(200);
  }

  // -------------------------------------------------------------------
  //  啟動
  // -------------------------------------------------------------------
  // 在遊戲讀取存檔「之前」決定這個分頁是不是同步負責人（同一個瀏覽器只允許一個分頁寫入存檔）
  async acquireLeadership() {
    if (!this.enabled) return true;
    if (this.leader === undefined) {
      this.leader = await this._acquireTabLock();
      if (!this.leader) this.suspended = true;
    }
    return this.leader;
  }

  async start() {
    if (!this.enabled) { this._setStatus('disabled', this.detail); return; }
    const leader = await this.acquireLeadership();
    if (!leader) {
      this._setStatus('suspended', '遊戲已在這個瀏覽器的另一個分頁開啟。');
      if (this.ui) this.ui.showOtherTab(false);
      this._markReady();
      return;
    }
    this.cloudStarted = true;
    window.addEventListener('online', () => this._onOnline());
    window.addEventListener('offline', () => { if (!this.suspended) this._setStatus('offline', '目前離線，進度會先存在這台裝置。'); });
    document.addEventListener('visibilitychange', () => this._onVisibility());
    window.addEventListener('pagehide', () => { if (this.meta.dirty) this.push('pagehide'); });
    this.interval = setInterval(() => this._tick(), this.cfg.syncIntervalMs);
    await this._boot();
  }

  _boot() {
    if (this.bootPromise) return this.bootPromise;
    this.bootPromise = (async () => {
      try {
        if (navigator.onLine === false) throw new CloudError('network', 'offline');
        this._setStatus('connecting');
        await this._ensureAuth();
        await this._connect();
        await this._exclusive(() => this._initialSync());
        this.retryIndex = 0;
        if (!this.ready) this._markReady();
      } catch (e) {
        this._handleError(e, 'boot');
      } finally {
        this.bootPromise = null;
      }
    })();
    return this.bootPromise;
  }

  async _ensureAuth() {
    if (this.auth) return;
    const auth = await CloudAuth.create(this.cfg);
    auth.onChange((event, session) => this._onAuthEvent(event, session));
    this.auth = auth;
    this._apiObj = new CloudSaveAPI(auth, this.cfg);
  }

  async _connect() {
    const { session } = await this.auth.ensureSession();
    this.session = session;
    const uid = session.user.id;
    if (this.meta.userId && this.meta.userId !== uid) {
      // 匿名身分換了（Session 遺失後重新建立）：舊的雲端存檔仍在原本的身分底下，可用復原代碼找回
      this.meta.identityResetAt = nowIso();
      this._resetCloudLink();
      this._notice('雲端身分已重新建立。這台裝置的進度會上傳到新的雲端存檔；若要找回舊的雲端存檔，請使用先前產生的復原代碼。');
    }
    this.meta.userId = uid;
    const p = await this.api.ensurePlayer(deviceLabel());
    if (this.meta.playerId && this.meta.playerId !== p.player_id) this._resetCloudLink();
    this.meta.playerId = p.player_id;
    this._saveMeta();
  }

  _resetCloudLink() {
    this.meta.saveId = null;
    this.meta.revision = null;
    this.meta.syncedHash = null;
    this.meta.playerId = null;
    this.lastPushed = null;
  }

  // 啟動時（或復原後）比對本機與雲端
  async _initialSync(opts = {}) {
    const S = this.game.getState();
    const head = await this.api.getHead(this.slot);
    if (head && Number(head.state_version) > this.gameVersion) {
      this.readOnly = true;
      this._setStatus('error', '雲端存檔來自較新版本的遊戲，請重新整理頁面更新遊戲後再同步（本機進度不受影響）。');
      return;
    }
    if (!head) {
      if (this.meta.saveId) this._resetLinkKeepPlayer();
      if (S && S.started && !this.meta.optOut) {
        if (!this.meta.migration) {
          this.meta.migration = { status: 'pending', since: nowIso(), source: this.legacyDetected ? 'localStorage' : 'this-device', attempts: 0 };
        }
        this._saveMeta();
        this._markReady();
        await this._pushOnce(this.meta.migration && this.meta.migration.status === 'pending' ? 'migration' : 'first-sync', { depth: opts.depth || 0 });
      } else {
        this._markReady();
        this._setStatus('synced', this.meta.optOut ? '已停用雲端同步' : '尚未建立雲端存檔（開始遊戲後會自動建立）');
      }
      return;
    }
    const localHash = S ? await sha256Hex(stableStringify(S)) : null;
    if (this.meta.saveId === head.id && this.meta.revision != null) {
      if ((!S || !S.started) && head.started && this.meta.pendingReason !== 'reset') {
        // 本機的遊戲存檔不見了（或被清空），雲端仍有進度 → 讀回雲端後才放行（開機畫面會等到讀完），
        // 絕不讓之後的新遊戲直接蓋掉雲端進度
        const remote = await this.api.loadSave(this.slot);
        if (remote) { await this._adoptRemote(remote, 'local-missing'); this._markReady(); return; }
      }
      this._markReady();
      if (Number(head.revision) === Number(this.meta.revision)) {
        if (localHash !== this.meta.syncedHash) await this._pushOnce('resume', { depth: opts.depth || 0 });
        else { this._markClean(); this._saveMeta(); this._setStatus('synced'); }
        return;
      }
      await this._handleRemoteChange(opts);
      return;
    }
    // 這台裝置還沒跟這份雲端存檔連結過
    const remote = await this.api.loadSave(this.slot);
    if (!remote) { this._markReady(); return this._pushOnce('first-sync', { depth: opts.depth || 0 }); }
    const remoteHash = await sha256Hex(stableStringify(remote.state));
    if (!S || !S.started) {
      await this._adoptRemote(remote, 'new-device');
      this._markReady();
      return;
    }
    if (localHash === remoteHash) {
      this._linkTo(remote, remoteHash);
      this._markClean();
      if (this.meta.migration && this.meta.migration.status === 'pending') this.meta.migration = { ...this.meta.migration, status: 'done', at: nowIso(), saveId: remote.id, revision: remote.revision };
      this._saveMeta();
      this._markReady();
      this._setStatus('synced');
      return;
    }
    if (this._isOwnWrite(remote)) {
      // 這份雲端存檔是這台裝置建立／寫入的（例如遷移上傳成功但回應遺失，之後又繼續玩）→ 接上後上傳最新進度
      this._linkTo(remote, remoteHash);
      if (this.meta.migration && this.meta.migration.status === 'pending') this.meta.migration = { ...this.meta.migration, status: 'done', at: nowIso(), saveId: remote.id, revision: remote.revision };
      this._saveMeta();
      this._markReady();
      await this._pushOnce('autosave', { depth: opts.depth || 0 });
      return;
    }
    this._markReady();
    this._enterConflict(remote, opts.context || 'first-link');
  }

  _resetLinkKeepPlayer() {
    this.meta.saveId = null;
    this.meta.revision = null;
    this.meta.syncedHash = null;
    this.lastPushed = null;
  }

  _linkTo(remote, hash) {
    this.meta.saveId = remote.id;
    this.meta.revision = Number(remote.revision);
    this.meta.syncedHash = hash;
    this.meta.syncedAt = nowIso();
  }

  // -------------------------------------------------------------------
  //  上傳（autosave / 重要事件 / 手動）
  // -------------------------------------------------------------------
  _schedulePush(delay) {
    if (!this.enabled || this.suspended) return;
    const now = Date.now();
    if (!this.firstDirtyAt) this.firstDirtyAt = now;
    const at = Math.min(now + delay, this.firstDirtyAt + this.cfg.autosaveMaxWaitMs);
    clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => { this.firstDirtyAt = 0; this.push('autosave'); }, Math.max(0, at - now));
  }

  // 同一時間只執行一個雲端寫入／比對流程，避免互相覆蓋
  _exclusive(fn) {
    if (this.inFlight) return this.inFlight.then(() => this._exclusive(fn), () => this._exclusive(fn));
    const run = (async () => fn())();
    this.inFlight = run.finally(() => {
      this.inFlight = null;
      if (this.pushAgain) { this.pushAgain = false; if (this.meta.dirty && !this.conflict) this._schedulePush(400); }
    });
    return this.inFlight;
  }

  // 等目前的請求結束後，再把「最新」的本機進度送出
  async flushNow(reason = 'manual') {
    clearTimeout(this.debounceTimer);
    this.firstDirtyAt = 0;
    while (this.inFlight) { try { await this.inFlight; } catch (e) { /* 忽略 */ } }
    return this.push(reason);
  }

  push(reason = 'autosave', opts = {}) {
    if (!this.enabled || this.suspended || this.readOnly) return Promise.resolve({ skipped: true });
    if (!this.ready || !this.session) {
      if (!this.bootPromise && this.cloudStarted) this._boot();
      return Promise.resolve({ skipped: 'not-ready' });
    }
    if (this.conflict) return Promise.resolve({ skipped: 'conflict' });
    if (this.meta.optOut && !opts.force) return Promise.resolve({ skipped: 'opt-out' });
    if (this.inFlight) { this.pushAgain = true; return this.inFlight; }
    return this._exclusive(() => this._pushOnce(reason, opts));
  }

  async _pushOnce(reason, opts = {}) {
    const depth = (opts.depth || 0) + 1;
    if (depth > 4) { this._setStatus('error', '雲端存檔一直在變動，請稍後按「立即同步」再試。'); return { error: 'too_many_retries' }; }
    opts = { ...opts, depth };
    let S = this.game.getState();
    if (!S) return { skipped: true };
    const reasonToSend = this.meta.pendingReason || (this.meta.migration && this.meta.migration.status === 'pending' ? 'migration' : reason);
    if (!S.started && (reasonToSend !== 'reset' || !this.meta.saveId)) {
      // 尚未開始的空白存檔不上傳（伺服器也會拒絕用空白存檔覆蓋已開始的存檔）；
      // 只有「重新開始」且雲端已有存檔時，才會以 reset 原因上傳（伺服器會先備份舊進度）
      this._markClean();
      if (reasonToSend === 'reset') this.meta.pendingReason = null;
      this._saveMeta();
      if (!this.meta.saveId) this._setStatus('synced', '尚未建立雲端存檔（開始遊戲後會自動建立）');
      return { skipped: 'not-started' };
    }
    try {
      await this._syncPhotos();
    } catch (e) {
      if (e.kind === 'network') return this._handleError(e, 'push');
    }
    S = this.game.getState();
    const seq = this.localSeq;
    const snapshot = JSON.parse(JSON.stringify(S));
    const checksum = await sha256Hex(stableStringify(snapshot));
    if (this.meta.saveId && checksum === this.meta.syncedHash && !opts.force) {
      if (seq === this.localSeq) this._markClean();
      this.meta.pendingReason = null;
      this._saveMeta();
      this._setStatus('synced');
      return { ok: true, unchanged: true };
    }
    const sameAsLast = this.lastPushed && this.lastPushed.checksum === checksum && this.lastPushed.baseRevision === this.meta.revision && this.lastPushed.saveId === this.meta.saveId;
    const opId = sameAsLast ? this.lastPushed.opId : crypto.randomUUID();
    this.lastPushed = { checksum, opId, baseRevision: this.meta.revision, saveId: this.meta.saveId };
    this._saveMeta(); // 先記下這次寫入，再送出請求
    this._setStatus('syncing');
    try {
      let res;
      if (!this.meta.saveId) {
        if (this.meta.migration && this.meta.migration.status === 'pending') {
          this.meta.migration.attempts = (this.meta.migration.attempts || 0) + 1;
          this._saveMeta();
        }
        res = await this.api.createSave(this.slot, snapshot, { checksum, clientId: this.clientId, reason: reasonToSend, opId });
        if (!res.ok && res.error === 'save_exists') {
          // 已經有存檔（另一台裝置建立的，或這台裝置先前送出但沒收到回應的那一次）→ 重新比對，不覆蓋
          return this._initialSync({ depth });
        }
      } else {
        res = await this.api.updateSave(this.meta.saveId, snapshot, this.meta.revision, { checksum, clientId: this.clientId, reason: reasonToSend, opId });
        if (!res.ok && res.error === 'revision_conflict') return this._handleRemoteChange({ depth });
        if (!res.ok && res.error === 'not_found') {
          this._resetLinkKeepPlayer();
          this._saveMeta();
          this._notice('雲端存檔已被刪除（可能是在另一台裝置），重新上傳這台裝置的進度。');
          return this._pushOnce('recreate', opts);
        }
      }
      if (!res || !res.ok) throw new CloudError('unknown', (res && res.error) || 'save failed');
      this._linkTo(res, checksum);
      this.lastPushed = null; // 結果已確認
      this.meta.lastError = null;
      this.meta.pendingReason = null;
      if (this.meta.migration && this.meta.migration.status === 'pending') {
        this.meta.migration = { ...this.meta.migration, status: 'done', at: nowIso(), saveId: res.id, revision: res.revision };
        this._notice(this.legacyDetected ? '舊版存檔已成功搬到雲端（本機也保留一份備份）。' : '已建立雲端存檔。');
      }
      if (seq === this.localSeq) this._markClean();
      this._saveMeta();
      this.retryIndex = 0;
      this._setStatus('synced');
      this._processPhotoDeletes();
      return { ok: true, revision: res.revision, duplicate: !!res.duplicate };
    } catch (e) {
      return this._handleError(e, 'push');
    }
  }

  // -------------------------------------------------------------------
  //  雲端有新版本：能判斷就自動處理，不能判斷就請玩家選擇
  // -------------------------------------------------------------------
  async _handleRemoteChange(opts = {}) {
    const remote = await this.api.loadSave(this.slot);
    if (!remote) {
      this._resetLinkKeepPlayer();
      this._saveMeta();
      return this.meta.optOut ? null : this._pushOnce('recreate', opts);
    }
    if (Number(remote.state_version) > this.gameVersion) {
      this.readOnly = true;
      this._setStatus('error', '雲端存檔來自較新版本的遊戲，請重新整理頁面更新遊戲。');
      return null;
    }
    const remoteHash = await sha256Hex(stableStringify(remote.state));
    const S = this.game.getState();
    const localHash = await sha256Hex(stableStringify(S));
    if (remoteHash === localHash) {
      this._linkTo(remote, remoteHash);
      this._markClean(); this._saveMeta();
      this._setStatus('synced');
      return { ok: true, same: true };
    }
    if ((this.lastPushed && this.lastPushed.checksum === remoteHash) || (this._isOwnWrite(remote) && (S.started || this.meta.pendingReason === 'reset'))) {
      // 雲端最新的一版是這台裝置寫的（例如回應遺失、或送出後馬上重新整理）→ 對齊 revision 後再上傳較新的本機進度
      this._linkTo(remote, remoteHash);
      this._saveMeta();
      return this._pushOnce('autosave', opts);
    }
    if (localHash === this.meta.syncedHash || !this.meta.dirty) {
      // 這台裝置沒有尚未同步的變更 → 直接採用雲端較新的版本
      return this._adoptRemote(remote, 'remote-newer');
    }
    if ((!S || !S.started) && this.meta.pendingReason !== 'reset') {
      // 本機只是空白（尚未開始）的存檔，沒有可保留的進度 → 直接讀回雲端
      return this._adoptRemote(remote, 'local-missing');
    }
    this._enterConflict(remote, 'both-changed');
    return { conflict: true };
  }

  async _adoptRemote(remote, why) {
    if (Number(remote.state_version) > this.gameVersion) {
      this.readOnly = true;
      this._setStatus('error', '雲端存檔來自較新版本的遊戲，請重新整理頁面更新遊戲。');
      return null;
    }
    const cur = this.game.getState();
    if (cur && cur.started) saveLocalBackup(`before-${why}`, cur);
    const remoteHash = await sha256Hex(stableStringify(remote.state));
    this.applyingRemote = true;
    try {
      this.game.replaceState(remote.state, { reason: 'cloud-adopt' });
    } finally { this.applyingRemote = false; }
    this._linkTo(remote, remoteHash);
    this._markClean();
    if (this.meta.migration && this.meta.migration.status === 'pending') this.meta.migration.status = 'skipped';
    if (!this.meta.migration) this.meta.migration = { status: 'not-needed', at: nowIso() };
    this._saveMeta();
    // migrate() 可能把舊格式升級 → 有差異就上傳升級後的版本
    const after = await sha256Hex(stableStringify(this.game.getState()));
    if (after !== remoteHash) { this._markDirty(); this._schedulePush(500); }
    this._setStatus('synced');
    if (why === 'new-device' || why === 'recovery' || why === 'local-missing') this._notice('已讀取雲端存檔。');
    else if (why === 'remote-newer') this._notice('已同步其他裝置的最新進度。');
    return { ok: true, adopted: true };
  }

  _enterConflict(remote, context) {
    const local = JSON.parse(JSON.stringify(this.game.getState()));
    saveLocalBackup('conflict', local);
    this.conflict = { remote, local, context };
    this._setStatus('conflict', '這台裝置與雲端各有不同的進度，請選擇要保留哪一份。');
    if (this.ui) this.ui.showConflict(summarize(local), summarize(remote.state), remote, context);
  }

  // 玩家在衝突視窗中做選擇：'local' 保留這台裝置、'cloud' 改用雲端
  async resolveConflict(choice) {
    const c = this.conflict;
    if (!c) return null;
    this.conflict = null;
    return this._exclusive(async () => {
      try {
        if (choice === 'cloud') {
          this.meta.pendingReason = null;
          return await this._adoptRemote(c.remote, c.context === 'recovery' ? 'recovery' : 'conflict');
        }
        // 以雲端目前的 revision 為基準覆蓋（伺服器會先把雲端版本存進 save_snapshots）
        const head = await this.api.getHead(this.slot);
        if (!head) { this._resetLinkKeepPlayer(); this._saveMeta(); return await this._pushOnce('recreate'); }
        this.meta.saveId = head.id;
        this.meta.revision = Number(head.revision);
        this.meta.syncedHash = null;
        this.meta.pendingReason = 'conflict-keep-local';
        this.lastPushed = null;
        this._markDirty();
        this._saveMeta();
        return await this._pushOnce('conflict-keep-local');
      } catch (e) {
        return this._handleError(e, 'conflict');
      }
    });
  }

  // -------------------------------------------------------------------
  //  錯誤處理與重試
  // -------------------------------------------------------------------
  _handleError(e, phase) {
    const err = e instanceof CloudError ? e : new CloudError(e && e.kind ? e.kind : 'unknown', (e && e.message) || String(e));
    this.meta.lastError = { kind: err.kind, message: String(err.message).slice(0, 300), at: nowIso(), phase };
    this._saveMeta();
    if (err.kind === 'network') {
      this._setStatus('offline', '連不上雲端，進度會先存在這台裝置，恢復連線後自動補傳。');
      this._scheduleRetry();
    } else if (err.kind === 'server' || err.kind === 'rate' || err.kind === 'unknown') {
      this._setStatus('error', `雲端同步失敗（${err.message}），稍後會自動重試。`);
      this._scheduleRetry();
    } else if (err.kind === 'auth') {
      this.session = null;
      this.ready = false;
      this._setStatus('connecting', '雲端身分需要重新連線…');
      this._scheduleRetry(1500);
    } else if (err.kind === 'config' || err.kind === 'denied') {
      this._setStatus('error', `雲端設定有問題：${err.message}（請確認 schema.sql 與 policies.sql 已執行、匿名登入已開啟）`);
    } else if (err.kind === 'validation') {
      this._setStatus('error', `雲端拒絕了這份存檔：${err.message}`);
    }
    if (!this.ready && phase === 'boot') {
      // 開機失敗也要放行遊戲（本機模式繼續玩）
      const rs = this.readyResolvers.splice(0);
      rs.forEach((r) => r(false));
    }
    return { error: err };
  }

  _scheduleRetry(delay) {
    clearTimeout(this.retryTimer);
    const d = delay || RETRY_DELAYS[Math.min(this.retryIndex, RETRY_DELAYS.length - 1)];
    this.retryIndex++;
    this.retryTimer = setTimeout(() => {
      if (this.suspended) return;
      if (!this.ready || !this.session) this._boot();
      else if (this.meta.dirty) this.push('retry');
      else this._checkRemote();
    }, d);
  }

  _onOnline() {
    if (this.suspended) return;
    this.retryIndex = 0;
    clearTimeout(this.retryTimer);
    if (!this.ready || !this.session) this._boot();
    else if (this.meta.dirty) this.push('online');
    else this._checkRemote();
  }

  _onVisibility() {
    if (this.suspended || !this.enabled) return;
    if (document.visibilityState === 'hidden') {
      if (this.meta.dirty) this.flushNow('hidden');
    } else if (this.ready && this.session) {
      if (this.meta.dirty) this.push('visible');
      else this._checkRemote();
    }
  }

  _tick() {
    if (this.suspended || !this.enabled || this.conflict) return;
    if (!this.ready || !this.session) { if (navigator.onLine !== false) this._boot(); return; }
    if (this.meta.dirty) this.push('interval');
    else if (document.visibilityState !== 'hidden') this._checkRemote();
  }

  _checkRemote() {
    if (!this.ready || !this.session || this.inFlight || this.conflict || this.suspended || this.readOnly) return Promise.resolve();
    return this._exclusive(async () => {
      try {
        const head = await this.api.getHead(this.slot);
        if (!head) {
          if (this.meta.saveId && !this.meta.optOut) {
            this._resetLinkKeepPlayer(); this._saveMeta();
            if (this.game.getState().started) await this._pushOnce('recreate');
          }
          return;
        }
        if (head.id === this.meta.saveId && Number(head.revision) === Number(this.meta.revision)) {
          if (this.status !== 'synced') this._setStatus('synced');
          return;
        }
        await this._handleRemoteChange();
      } catch (e) { this._handleError(e, 'check'); }
    });
  }

  _onAuthEvent(event, session) {
    if (event === 'TOKEN_REFRESHED' || event === 'SIGNED_IN') { if (session) this.session = session; return; }
    if (event === 'SIGNED_OUT') {
      // refresh token 失效 → 下次連線會建立新的匿名身分（本機進度保留，並重新上傳）
      this.session = null;
      this.ready = false;
      if (!this.suspended) this._scheduleRetry(1000);
    }
  }

  // -------------------------------------------------------------------
  //  照片：先存本機快取 → 上傳到 Storage → 存檔改存路徑（上傳成功前 data URL 一直留在存檔裡）
  // -------------------------------------------------------------------
  _trackPhotoRefs() {
    const S = this.game.getState();
    const refs = (S && S.profile && S.profile.photoRefs) || {};
    if (this.lastRefs) {
      for (const [who, ref] of Object.entries(this.lastRefs)) {
        const now = refs[who];
        if (ref && ref.path && (!now || now.path !== ref.path) && !this.meta.pendingPhotoDeletes.includes(ref.path)) {
          this.meta.pendingPhotoDeletes.push(ref.path);
          this._saveMeta();
        }
      }
    }
    this.lastRefs = JSON.parse(JSON.stringify(refs));
  }

  async _syncPhotos() {
    if (!this.meta.playerId || !this.session) return;
    const S = this.game.getState();
    const photos = (S.profile && S.profile.photos) || {};
    for (const [who, dataUrl] of Object.entries(photos)) {
      if (!WHO.has(who) || typeof dataUrl !== 'string') continue;
      const info = dataUrlInfo(dataUrl);
      if (!info || info.bytes.length > PHOTO_MAX_BYTES) continue; // 不能上傳的照片維持原本的 data URL 存法
      const sha = await sha256Hex(info.bytes);
      this.photoCache.set(who, { sha, dataUrl });
      const path = `${this.meta.playerId}/${who}-${sha.slice(0, 16)}.${info.ext}`;
      try {
        await uploadPhoto(this.auth.client, this.cfg.photoBucket, path, info);
      } catch (e) {
        if (e.kind === 'network') throw e;
        console.warn('[photo] 上傳失敗，照片先留在存檔內', e.message);
        continue;
      }
      const cur = this.game.getState();
      if (!cur.profile.photos || cur.profile.photos[who] !== dataUrl) continue; // 上傳期間又換了照片
      cur.profile.photoRefs = cur.profile.photoRefs || {};
      cur.profile.photoRefs[who] = { path, sha, mime: info.mime, size: info.bytes.length, updatedAt: nowIso() };
      delete cur.profile.photos[who];
      this.game.save('photo-uploaded');
    }
  }

  // 被換掉或移除的舊照片：只有在「本機存檔、雲端存檔、所有雲端備份」都不再使用時才刪除，
  // 否則留在待刪清單，等備份輪替掉之後再刪（從備份還原時照片才不會不見）
  async _processPhotoDeletes(opts = {}) {
    if (this._photoDeleting || !this.meta.pendingPhotoDeletes.length) return;
    // 清單裡只剩「上次檢查仍被備份引用」的照片時，每 10 分鐘才再檢查一次（避免每次同步都多一個請求）
    const onlyKept = this.meta.pendingPhotoDeletes.every((p) => this._photoKept.has(p));
    if (onlyKept && !opts.force && Date.now() - this._photoCheckAt < 10 * 60 * 1000) return;
    this._photoDeleting = true;
    this._photoCheckAt = Date.now();
    try {
      const S = this.game.getState();
      const inUse = new Set(Object.values((S.profile && S.profile.photoRefs) || {}).map((r) => r && r.path));
      let cloudInUse;
      try { cloudInUse = new Set(await this.api.photoPathsInUse()); } catch (e) { return; } // 查不到就先不刪
      const own = `${this.meta.playerId}/`;
      const handled = this.meta.pendingPhotoDeletes.slice();
      const keep = [];
      const todo = [];
      for (const p of handled) {
        if (!p || !this.meta.playerId || !p.startsWith(own)) continue; // 不是自己資料夾的路徑（例如匯入別人的檔案）→ 不能也不該刪，移出清單
        if (inUse.has(p) || cloudInUse.has(p)) keep.push(p);          // 仍被使用 → 保留，之後再檢查
        else todo.push(p);
      }
      if (todo.length) await removePhotos(this.auth.client, this.cfg.photoBucket, todo);
      const added = this.meta.pendingPhotoDeletes.filter((p) => !handled.includes(p)); // 等待期間新加入的
      this.meta.pendingPhotoDeletes = keep.concat(added);
      this._photoKept = new Set(keep);
      this._saveMeta();
    } catch (e) {
      /* 刪除失敗：清單保留，下次同步成功後再試 */
    } finally {
      this._photoDeleting = false;
    }
  }

  _photoURL(who) {
    const S = this.game.getState();
    const ref = S && S.profile && S.profile.photoRefs && S.profile.photoRefs[who];
    if (!ref) return null;
    const c = this.photoCache.get(who);
    if (c && c.sha === ref.sha) return c.dataUrl;
    if (this.enabled && this.session && ref.path && !this.downloads.has(ref.path)) {
      const p = downloadPhoto(this.auth.client, this.cfg.photoBucket, ref.path)
        .then((dataUrl) => {
          this.photoCache.set(who, { sha: ref.sha, dataUrl });
          const ae = document.activeElement;
          if (!(ae && /INPUT|SELECT|TEXTAREA/.test(ae.tagName))) this.game.render();
        })
        .catch((e) => { console.warn('[photo] 下載失敗', e.message); })
        .finally(() => { setTimeout(() => this.downloads.delete(ref.path), 30000); });
      this.downloads.set(ref.path, p);
    }
    return null;
  }

  // -------------------------------------------------------------------
  //  對外操作（介面與測試會用到）
  // -------------------------------------------------------------------
  // 建立雲端存檔（若已存在則改為比對）
  async createSave() { this.meta.optOut = false; this._saveMeta(); return this.push('create', { force: true }); }
  // 立即上傳目前進度
  async updateSave() { return this.flushNow('manual'); }
  // 立即同步：先上傳本機變更，再檢查其他裝置的新進度
  async syncSave() {
    if (!this.enabled) return { skipped: true };
    if (!this.ready || !this.session) { await this._boot(); return { booted: true }; }
    await this.flushNow('manual');
    await this._checkRemote();
    return { status: this.status };
  }

  // 讀取雲端存檔並取代本機進度（本機會先備份）
  async loadSave() {
    return this._exclusive(async () => {
      const remote = await this.api.loadSave(this.slot);
      if (!remote) return { ok: false, error: 'no_cloud_save' };
      return this._adoptRemote(remote, 'manual-load');
    });
  }

  // 刪除雲端存檔（本機進度保留），並停用自動同步，直到玩家重新開啟
  async deleteSave() {
    if (!this.meta.saveId) return { ok: false, error: 'no_cloud_save' };
    await this.flushNow('before-delete').catch(() => {});
    return this._exclusive(async () => {
      const r = await this.api.deleteSave(this.meta.saveId);
      this._resetLinkKeepPlayer();
      this.meta.optOut = true;
      this._saveMeta();
      this._setStatus('synced', '已刪除雲端存檔並停用雲端同步（本機進度仍在）。');
      return r;
    });
  }

  async enableSync() {
    this.meta.optOut = false;
    this._markDirty();
    this._saveMeta();
    return this.push('create', { force: true });
  }

  async listSnapshots() {
    if (!this.meta.saveId) return [];
    return this.api.listSnapshots(this.meta.saveId);
  }

  // 從雲端備份還原（先把本機尚未同步的變更送上去，讓目前的版本也能被備份）
  async restoreSave(snapshotId) {
    if (!this.meta.saveId) throw new CloudError('validation', 'no_cloud_save');
    await this.flushNow('before-restore');
    if (this.conflict) throw new CloudError('validation', 'conflict_pending');
    return this._exclusive(async () => {
      const res = await this.api.restoreSave(this.meta.saveId, snapshotId, this.meta.revision, { clientId: this.clientId, opId: crypto.randomUUID() });
      if (!res.ok) {
        if (res.error === 'revision_conflict') { await this._handleRemoteChange(); throw new CloudError('validation', 'revision_conflict'); }
        throw new CloudError('validation', res.error || 'restore_failed');
      }
      await this._adoptRemote({ id: res.id, revision: res.revision, state: res.state, state_version: res.state && res.state.version }, 'restore');
      this._notice('已從雲端備份還原。');
      return res;
    });
  }

  // 匯出：與單檔版相同的 JSON 格式；雲端照片會補回 data URL，匯入舊版也看得到
  async exportState(S) {
    const out = JSON.parse(JSON.stringify(S || this.game.getState()));
    const refs = (out.profile && out.profile.photoRefs) || {};
    let missing = 0;
    for (const [who, ref] of Object.entries(refs)) {
      out.profile.photos = out.profile.photos || {};
      if (out.profile.photos[who]) continue;
      let dataUrl = null;
      const c = this.photoCache.get(who);
      if (c && ref && c.sha === ref.sha) dataUrl = c.dataUrl;
      else if (this.session && ref && ref.path) { try { dataUrl = await downloadPhoto(this.auth.client, this.cfg.photoBucket, ref.path); } catch (e) { dataUrl = null; } }
      if (dataUrl) { out.profile.photos[who] = dataUrl; delete refs[who]; } else missing++;
    }
    // 照片已經以 data URL 放進檔案 → 不再需要雲端路徑；全部補齊時匯出格式與單檔版完全相同
    if (out.profile && out.profile.photoRefs && !Object.keys(out.profile.photoRefs).length) delete out.profile.photoRefs;
    if (missing) this._notice(`有 ${missing} 張照片目前無法下載，匯出的檔案不含這些照片。`);
    return out;
  }

  async exportSave() {
    const data = await this.exportState(this.game.getState());
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `晨光羈絆存檔-${this.game.today()}.json`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    return data;
  }

  // 匯入：接受檔案或已解析的物件；格式檢查與單檔版相同，之後交給原本的 migrate()
  async importSave(input) {
    const data = typeof input === 'object' && !(input instanceof Blob) ? input : JSON.parse(await input.text());
    if (!data || typeof data !== 'object' || !data.settings || !data.player) throw new CloudError('validation', '檔案格式不正確');
    const cur = this.game.getState();
    if (cur && cur.started) saveLocalBackup('before-import', cur);
    this.meta.pendingReason = 'import';
    this._saveMeta();
    this.game.replaceState(data, { reason: 'import' });
    this._schedulePush(200);
    return this.game.getState();
  }

  // 復原代碼
  async createRecoveryCode() {
    await this.flushNow('before-recovery-code');
    return this.api.createRecoveryCode();
  }
  recoveryStatus() { return this.api.recoveryStatus(); }
  revokeRecoveryCode() { return this.api.revokeRecoveryCode(); }

  async redeemRecoveryCode(code, force = false) {
    if (!this.ready || !this.session) await this._boot();
    if (!this.session) throw new CloudError('network', '目前無法連線雲端');
    await this.flushNow('before-redeem').catch(() => {});
    const res = await this.api.redeemRecoveryCode(code, force);
    const cur = this.game.getState();
    if (cur && cur.started) saveLocalBackup('before-recovery', cur);
    const p = await this.api.ensurePlayer(deviceLabel());
    this.meta.playerId = p.player_id;
    this._resetLinkKeepPlayer();
    this.meta.optOut = false;
    this.meta.migration = this.meta.migration || { status: 'not-needed', at: nowIso() };
    this._saveMeta();
    await this._exclusive(() => this._initialSync({ context: 'recovery' }));
    if (!this.ready) this._markReady();
    return res;
  }

  async listMemories() { return this.api.listMemories(this.slot, null, 12); }
  async listDevices() { return this.api.listDevices(); }

  // -------------------------------------------------------------------
  //  同一個瀏覽器只允許一個分頁同步（Web Locks + BroadcastChannel）
  // -------------------------------------------------------------------
  _lockName() { return `morning-bond:${this.slot}`; }

  async _acquireTabLock() {
    if (!('locks' in navigator) || typeof BroadcastChannel === 'undefined') return true;
    this.channel = new BroadcastChannel(`morning-bond:${this.slot}`);
    this.channel.onmessage = (ev) => this._onChannel(ev.data);
    return new Promise((resolve) => {
      navigator.locks.request(this._lockName(), { ifAvailable: true }, (lock) => {
        if (!lock) { resolve(false); return undefined; }
        resolve(true);
        return new Promise((release) => { this.releaseLock = release; });
      });
    });
  }

  async _onChannel(msg) {
    if (!msg || msg.type !== 'takeover' || this.suspended) return;
    // 另一個分頁要接手：先把進度存好、送上雲端，再暫停這個分頁並釋放鎖
    try { this.game.save('takeover'); } catch (e) { /* 忽略 */ }
    try { await Promise.race([this.flushNow('takeover'), new Promise((r) => setTimeout(r, 5000))]); } catch (e) { /* 忽略 */ }
    this.suspended = true;
    clearInterval(this.interval);
    clearTimeout(this.debounceTimer);
    clearTimeout(this.retryTimer);
    this._setStatus('suspended', '遊戲已在另一個分頁繼續。');
    if (this.ui) this.ui.showOtherTab(true);
    if (this.releaseLock) { this.releaseLock(); this.releaseLock = null; }
    this.channel.postMessage({ type: 'released' });
  }

  // 在這個分頁接手：通知持有鎖的分頁暫停，拿到鎖後重新載入（讀取最新的本機存檔）
  takeOver() {
    if (!('locks' in navigator)) { location.reload(); return; }
    if (!this.channel) this.channel = new BroadcastChannel(`morning-bond:${this.slot}`);
    navigator.locks.request(this._lockName(), () => { location.reload(); return new Promise(() => {}); });
    this.channel.postMessage({ type: 'takeover' });
  }
}
