/**
 * cdp-eval.mjs — 通过 Chrome DevTools Protocol 在 WebView 页面里执行 JS 并打印结果
 * 用法：node cdp-eval.mjs <webSocketDebuggerUrl> [exprFile]
 *   exprFile 省略时从 stdin 读表达式
 */
import { readFileSync } from 'node:fs';

const wsUrl = process.argv[2];
const expr = process.argv[3]
  ? readFileSync(process.argv[3], 'utf8')
  : readFileSync(0, 'utf8');

const ws = new WebSocket(wsUrl);
let id = 0;
const pending = new Map();

ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m);
    pending.delete(m.id);
  }
});

function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id;
    pending.set(msgId, (m) =>
      m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result));
    ws.send(JSON.stringify({ id: msgId, method, params }));
  });
}

ws.addEventListener('open', async () => {
  try {
    const r = await send('Runtime.evaluate', {
      expression: expr,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.result && r.result.exceptionDetails) {
      console.log('EXCEPTION ' + JSON.stringify(r.result.exceptionDetails, null, 2));
    } else if (r.result && r.result.value !== undefined) {
      console.log(typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value, null, 2));
    } else {
      console.log(JSON.stringify(r, null, 2));
    }
  } catch (e) {
    console.log('ERR ' + e.message);
  }
  try { ws.close(); } catch (e) { /* noop */ }
  process.exit(0);
});

ws.addEventListener('error', (e) => { console.log('WSERR ' + (e.message || e)); process.exit(1); });
setTimeout(() => { console.log('TIMEOUT'); process.exit(2); }, 20000);
