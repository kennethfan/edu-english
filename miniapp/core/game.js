// 游戏核心工具：hashKey（与装配脚本/自检页逐字节同源）+ 音频定位 + 洗牌 + 卡片组构建
const AUDIOMAP = require('./audiomap.js').map;

const FNV_PRIME = 16777619;
const SALT_A = 0x811c9dc5;
const SALT_B = 0x01234567;

function utf8Bytes(str) {
  const out = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(++i);
      const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
               0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return out;
}

function fnv1a(bytes, basis) {
  let h = basis >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

function hashKey(text) {
  const raw = utf8Bytes(text);
  return fnv1a(raw, SALT_A).toString(16).padStart(8, '0') +
         fnv1a(raw, SALT_B).toString(16).padStart(8, '0');
}

/**
 * 音频绝对路径（M1 已验证：InnerAudioContext 跨包绝对路径可用）。
 * audiomap 未收录时返回空串，调用方跳过播放不报错。
 */
function audioSrc(en) {
  const hash = hashKey(en);
  const pkg = AUDIOMAP[hash];
  return pkg ? '/packages/' + pkg + '/audio/' + hash + '.mp3' : '';
}

/** Fisher-Yates 洗牌（返回新数组，不改原数组） */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/**
 * 由一关的 pairs 构建双列卡片组（判分口径与 App 线一致）：
 * 左列英文、右列中文，各自独立洗牌；uid 仅用于布局 key 与点击去重。
 * pairs: [[key, en, zh], ...]
 */
function buildDeck(pairs) {
  const left = pairs.map((p, i) => ({
    uid: 'L' + i, side: 'L', key: p[0],
    text: p[1], zh: p[2], en: p[1],
    done: false, wrong: false, ok: false,
  }));
  const right = pairs.map((p, i) => ({
    uid: 'R' + i, side: 'R', key: p[0],
    text: p[2], zh: p[2], en: p[1],
    done: false, wrong: false, ok: false,
  }));
  return { left: shuffle(left), right: shuffle(right) };
}

module.exports = { hashKey, audioSrc, shuffle, buildDeck };
