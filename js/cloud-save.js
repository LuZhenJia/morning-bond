// =====================================================================
//  cloud-save.js — 雲端存檔資料層：呼叫 Supabase RPC 與 recover-save Edge Function
//  只負責「送出請求、整理回應、分類錯誤」；何時存、怎麼處理衝突由 save-manager.js 決定。
// =====================================================================
import { CloudError, classifyPostgrest } from './supabase.js';

export class CloudSaveAPI {
  constructor(auth, cfg) {
    this.auth = auth;
    this.sb = auth.client;
    this.cfg = cfg;
  }

  // 權杖失效（401）時先更新一次再重試；其餘錯誤分類後丟出
  async rpc(fn, args = {}) {
    let r = await this.sb.rpc(fn, args);
    if (r.error && Number(r.status) === 401) {
      await this.auth.refresh();
      r = await this.sb.rpc(fn, args);
    }
    if (r.error) throw classifyPostgrest(r);
    return r.data;
  }

  ensurePlayer(deviceLabel) { return this.rpc('ensure_player', { p_device_label: deviceLabel || null }); }
  getHead(slot) { return this.rpc('get_save_head', { p_slot: slot }); }
  loadSave(slot) { return this.rpc('load_game_save', { p_slot: slot }); }

  createSave(slot, state, { checksum, clientId, reason, opId }) {
    return this.rpc('create_game_save', {
      p_slot: slot, p_state: state, p_checksum: checksum || null, p_client_id: clientId || null,
      p_reason: reason || 'create', p_op_id: opId || null,
    });
  }

  updateSave(saveId, state, baseRevision, { checksum, clientId, reason, opId }) {
    return this.rpc('update_game_save', {
      p_save_id: saveId, p_state: state, p_base_revision: baseRevision, p_checksum: checksum || null,
      p_client_id: clientId || null, p_reason: reason || 'autosave', p_op_id: opId || null,
    });
  }

  deleteSave(saveId) { return this.rpc('delete_game_save', { p_save_id: saveId }); }
  listSnapshots(saveId) { return this.rpc('list_save_snapshots', { p_save_id: saveId }); }

  restoreSave(saveId, snapshotId, baseRevision, { clientId, opId }) {
    return this.rpc('restore_game_save', {
      p_save_id: saveId, p_snapshot_id: snapshotId, p_base_revision: baseRevision,
      p_client_id: clientId || null, p_op_id: opId || null,
    });
  }

  listMemories(slot, kind = null, limit = 30) { return this.rpc('list_memories', { p_slot: slot, p_kind: kind, p_limit: limit }); }
  listDevices() { return this.rpc('list_player_devices', {}); }
  photoPathsInUse() { return this.rpc('list_photo_paths_in_use', {}); }

  // -------------------------------------------------------------------
  //  復原代碼（Edge Function：recover-save）
  // -------------------------------------------------------------------
  async fn(body) {
    const { FunctionsHttpError, FunctionsFetchError, FunctionsRelayError } = this.auth.lib;
    const { data, error } = await this.sb.functions.invoke(this.cfg.recoveryFunction, { body });
    if (!error) return data;
    if (error instanceof FunctionsHttpError) {
      const res = error.context;
      let payload = null;
      try { payload = await res.json(); } catch (e) { /* 非 JSON */ }
      // 沒有回傳 JSON 的 404 = 專案裡還沒有部署 recover-save 這個 Edge Function
      const code = (payload && payload.error) || (res.status === 404 ? 'function_not_deployed' : `http_${res.status}`);
      const kind = res.status === 429 ? 'rate' : res.status === 401 ? 'auth' : res.status >= 500 ? 'server' : res.status === 404 ? 'config' : 'validation';
      throw new CloudError(kind, code, { status: res.status, payload });
    }
    if (error instanceof FunctionsFetchError || error instanceof FunctionsRelayError) {
      // 連不到函式：可能是網路中斷，也可能是函式沒部署、或 ALLOWED_ORIGINS 沒有這個網站
      // （瀏覽器的 CORS 檢查失敗時看起來也像網路錯誤）→ 用一個資料庫請求確認網路是否正常
      let dbOk = false;
      try { await this.rpc('get_save_head', { p_slot: 'main' }); dbOk = true; } catch (e) { dbOk = false; }
      if (dbOk) throw new CloudError('config', 'function_unreachable');
      throw new CloudError('network', error.message || 'function unreachable');
    }
    throw new CloudError('unknown', error.message || 'function failed');
  }

  createRecoveryCode() { return this.fn({ action: 'create' }); }
  redeemRecoveryCode(code, force = false) { return this.fn({ action: 'redeem', code, force: !!force }); }
  recoveryStatus() { return this.fn({ action: 'status' }); }
  revokeRecoveryCode() { return this.fn({ action: 'revoke' }); }
}
