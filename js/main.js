// =====================================================================
//  main.js — 啟動順序
//  1. 建立存檔管理器與雲端介面，掛到遊戲本體的 HOOKS
//  2. preInit()：在遊戲讀取本機存檔「之前」，把舊版存檔完整備份一份
//  3. 確認這個分頁是否負責存檔（同一個瀏覽器開了兩個分頁時，只有一個能寫入）
//  4. 遊戲照原本方式啟動（先讀本機存檔，離線也能玩）
//  5. 背景連接雲端：匿名身分 → 比對雲端 → 遷移／同步
// =====================================================================
import * as Game from './game.js';
import { CONFIG } from './config.js';
import { SaveManager } from './save-manager.js';
import { CloudUI } from './cloud-ui.js';

const manager = new SaveManager({ game: Game, config: CONFIG });
const cloudUI = new CloudUI(manager, Game);
manager.attachUI(cloudUI);
Game.setHooks(manager.hooks());
manager.preInit();
await manager.acquireLeadership();
Game.init();
cloudUI.mount();

if (manager.enabled && !Game.getState().started) {
  // 新裝置：先確認雲端有沒有存檔，避免一開始就產生兩份分岔的進度
  cloudUI.showBootGate();
  manager.whenReady(CONFIG.bootGateTimeoutMs).then(() => cloudUI.hideBootGate());
}
manager.start().catch((e) => console.error('[cloud] start failed', e));

// 除錯用：在瀏覽器主控台輸入 __cloud 可以看到同步狀態
window.__cloud = manager;
