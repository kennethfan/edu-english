/**
 * 生成 www/index.html：把原始单页 HTML 复制过来，并注入：
 *   1. <head> 最前面的 shim.js（Capacitor 桥）
 *   2. </body> 前的双主题补丁（theme-patch.css + theme-patch.js，浮动切换钮）
 * 原始 HTML 保持只读不改动。可重复执行（幂等）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = '/Users/kenneth/agent/edu/单词匹配精校版-PEP-CET-全26册.html';
const OUT = resolve(__dirname, '../www/index.html');
const SHIM_TAG = '<script src="shim.js"></script>';
const PATCH_STYLE_ID = 'wm-theme-patch-style';
const PATCH_SCRIPT_ID = 'wm-theme-patch-script';

let html = readFileSync(SRC, 'utf8');

// ---- 1. shim 注入 ----
if (html.includes(SHIM_TAG)) {
  console.log('[prepare-www] shim 已注入，跳过');
} else {
  const headOpen = html.match(/<head[^>]*>/i);
  if (!headOpen) throw new Error('未找到 <head> 标签，无法注入 shim');
  const at = headOpen.index + headOpen[0].length;
  html = html.slice(0, at) + '\n' + SHIM_TAG + '\n' + html.slice(at);
  console.log('[prepare-www] 已注入 shim:', SHIM_TAG);
}

// ---- 2. 双主题补丁注入（style 在主样式之后保证级联胜出；script 靠后保证 DOM 就绪）----
const patchCss = readFileSync(resolve(__dirname, 'theme-patch.css'), 'utf8');
const patchJs = readFileSync(resolve(__dirname, 'theme-patch.js'), 'utf8');

if (html.includes(PATCH_STYLE_ID)) {
  console.log('[prepare-www] 主题补丁已注入，跳过');
} else {
  const styleTag = `\n<style id="${PATCH_STYLE_ID}">\n${patchCss}\n</style>\n`;
  const scriptTag = `\n<script id="${PATCH_SCRIPT_ID}">\n${patchJs}\n</script>\n`;
  const bodyClose = html.lastIndexOf('</body>');
  if (bodyClose < 0) throw new Error('未找到 </body>，无法注入主题补丁');
  html = html.slice(0, bodyClose) + styleTag + scriptTag + html.slice(bodyClose);
  console.log('[prepare-www] 已注入主题补丁 (style+script)');
}

writeFileSync(OUT, html, 'utf8');
console.log('[prepare-www] 已写出', OUT, `(${html.length} 字节)`);
