// =====================================================================
//  重新打包 supabase-js 成單一 ES Module，放到 js/vendor/
//    cd tools/vendor && npm install && npm run build
//  更新版本：改 package.json 的 @supabase/supabase-js 版本 → npm install → npm run build
//            → 把 js/supabase.js 的 LIB_URL 改成新的檔名 → 刪掉舊檔 → 跑一次測試
// =====================================================================
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const pkg = (name) => JSON.parse(readFileSync(new URL(`./node_modules/${name}/package.json`, import.meta.url), 'utf8'));
const v = pkg('@supabase/supabase-js').version;
const sub = ['auth-js', 'postgrest-js', 'storage-js', 'functions-js', 'realtime-js'].map((n) => `${n} ${pkg('@supabase/' + n).version}`);
const out = fileURLToPath(new URL(`../../js/vendor/supabase-js-${v}.js`, import.meta.url));
const banner = `/*!
 * @supabase/supabase-js ${v}（含 ${sub.join('、')}）
 * 以 esbuild 打包成單一 ES Module（--bundle --format=esm --platform=browser --target=es2020 --minify），
 * 讓 GitHub Pages 不需要建置工具或 CDN 也能載入。只匯出遊戲需要的名稱。
 * 授權：MIT License — Copyright (c) 2020 Supabase。https://github.com/supabase/supabase-js
 * 更新方式見 README「更新 supabase-js」。
 */`;

await build({
  entryPoints: [fileURLToPath(new URL('./entry.mjs', import.meta.url))],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'none',
  banner: { js: banner },
  outfile: out,
});
console.log(`已輸出 ${out}`);
console.log(`請確認 js/supabase.js 的 LIB_URL 是 './vendor/supabase-js-${v}.js'`);
