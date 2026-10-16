/**
 * 生成 www/index.html：把原始单页 HTML 复制过来，并在 <head> 最前面注入 shim.js。
 * 原始 HTML 保持只读不改动。可重复执行（幂等）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = '/Users/kenneth/agent/edu/单词匹配精校版-PEP-CET-全26册.html';
const OUT = resolve(__dirname, '../www/index.html');
const SHIM_TAG = '<script src="shim.js"></script>';

let html = readFileSync(SRC, 'utf8');

if (html.includes(SHIM_TAG)) {
  console.log('[prepare-www] shim 已注入，跳过');
} else {
  const headOpen = html.match(/<head[^>]*>/i);
  if (!headOpen) throw new Error('未找到 <head> 标签，无法注入 shim');
  const at = headOpen.index + headOpen[0].length;
  html = html.slice(0, at) + '\n' + SHIM_TAG + '\n' + html.slice(at);
  console.log('[prepare-www] 已注入 shim:', SHIM_TAG);
}

writeFileSync(OUT, html, 'utf8');
console.log('[prepare-www] 已写出', OUT, `(${html.length} 字节)`);
