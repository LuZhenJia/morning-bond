# assets/audio

這個遊戲目前**沒有任何音訊檔**：角色的語音是用瀏覽器內建的語音合成（Web Speech API 的 `speechSynthesis`），
可以在遊戲的「設定」裡開關。資料夾保留給之後如果要加入背景音樂或音效時使用；
加入時請用相對路徑（例如 `new URL('../assets/audio/xxx.mp3', import.meta.url)`），GitHub Pages 的子路徑才能正常載入。
