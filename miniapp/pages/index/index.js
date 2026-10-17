// M1 全量自检：21 个分包的数据加载 + 同包/跨包音频播放 + 哈希一致性
const FNV_PRIME = 16777619;
const SALT_A = 0x811c9dc5;
const SALT_B = 0x01234567;

// 与 src/shim.js / make-audio.py 的 hashKey 逐字节一致（UTF-8 字节 + 双盐 FNV-1a 32）
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
  const b = utf8Bytes(String(text));
  return fnv1a(b, SALT_A).toString(16).padStart(8, '0') +
         fnv1a(b, SALT_B).toString(16).padStart(8, '0');
}

const PKG = require('../../core/pkgs.js');         // { pkgs, books, bookPkgs, bookAudioPkgs, samples, crossSamples }
const LOADERS = require('../../core/loaders.js');  // { b01: () => require.async('静态路径'), ... }
const META = require('../../core/books-meta.js');
const store = require('../../core/store.js');
const theme = require('../../core/theme.js');

Page({
  data: {
    summary: '（未加载）',
    playState: '（未播放）',
    logs: [],
    themeCls: 'theme-dark',
    // ---- 首页产品信息 ----
    statPercent: 0,
    statDone: 0,
    statTotal: 0,
    lastLabel: '',       // 「继续学习」副标题；空 = 无历史
    wrongCount: 0,
    diagOpen: false,     // 系统诊断折叠面板
  },

  onShow() {
    // 总进度
    let done = 0;
    let total = 0;
    for (const b of META.books) {
      done += store.getDone(b.id).length;
      total += b.levelCount;
    }
    // 继续学习
    let lastLabel = '';
    const last = store.getLast();
    if (last) {
      const b = META.books.find((x) => x.id === last.book);
      if (b) lastLabel = b.label + ' · 第 ' + (last.level + 1) + ' 关';
    }
    this.setData({
      themeCls: theme.cls(),
      statDone: done,
      statTotal: total,
      statPercent: total ? Math.round((done / total) * 100) : 0,
      lastLabel: lastLabel,
      wrongCount: Object.keys(store.getWrong()).length,
    });
  },

  /** 首页大按钮：有历史直接续玩，否则去选册 */
  primaryAction() {
    const last = store.getLast();
    if (last && META.books.some((x) => x.id === last.book)) {
      wx.navigateTo({ url: '/pages/game/game?book=' + last.book + '&level=' + last.level });
    } else {
      wx.navigateTo({ url: '/pages/books/books' });
    }
  },

  goBooks() {
    wx.navigateTo({ url: '/pages/books/books' });
  },

  goWrong() {
    wx.navigateTo({ url: '/pages/wrong/wrong' });
  },

  toggleDiag() {
    this.setData({ diagOpen: !this.data.diagOpen });
  },

  log(msg) {
    const t = new Date().toTimeString().slice(0, 8);
    this.setData({ logs: [`[${t}] ${msg}`].concat(this.data.logs).slice(0, 40) });
  },

  /** ① 逐个加载全部分包 */
  async onLoadAll() {
    const t0 = Date.now();
    let ok = 0, fail = 0, words = 0, levels = 0;
    this._pkgs = {};
    for (const pkg of PKG.pkgs) {
      try {
        const mod = await LOADERS[pkg]();
        const d = mod && mod.books ? mod : (mod && mod.default) || mod;
        if (!d || !d.levels) throw new Error('结构不符');
        this._pkgs[pkg] = d;
        ok++;
        Object.keys(d.levels).forEach((b) => {
          levels += d.levels[b].length;
          d.levels[b].forEach((lv) => { words += lv.p.length; });
        });
        this.log(`✓ ${pkg} ${d.books.join('+')}`);
      } catch (e) {
        fail++;
        this.log(`✗ ${pkg} 加载失败: ${(e && (e.message || e.errMsg)) || e}`);
      }
    }
    this.setData({
      summary: `分包 ${ok}/${PKG.pkgs.length} 成功 · ${PKG.books.length} 册 · ${levels} 关 · ${words} 词 · ${Date.now() - t0}ms`,
    });
    this.log(`■ 数据加载结束：成功 ${ok} / 失败 ${fail}`);
  },

  /** 通用顺序播放器：items = [{pkg, text, audioPkg?}]，onEnded 接力 */
  playChain(title, items) {
    if (!items.length) { this.log('没有可播项'); return; }
    let i = 0, failCount = 0;
    const playNext = () => {
      if (i >= items.length) {
        this.setData({ playState: `${title}完成 ${items.length - failCount}/${items.length}` });
        this.log(`■ ${title}结束：成功 ${items.length - failCount} / 失败 ${failCount}`);
        return;
      }
      const it = items[i];
      const src = `/packages/${it.audioPkg || it.pkg}/audio/${hashKey(it.text)}.mp3`;
      if (this._audio) { try { this._audio.destroy(); } catch (e) { /* noop */ } }
      const a = wx.createInnerAudioContext({ useWebAudioImplement: false });
      a.src = src;
      a.onEnded(() => {
        this.log(`✓ [${i + 1}/${items.length}] ${it.pkg} ${it.text}`);
        a.destroy(); i++; playNext();
      });
      a.onError((err) => {
        failCount++;
        this.log(`✗ [${i + 1}/${items.length}] ${it.pkg} ${it.text} src=${src} err=${(err && err.errMsg) || '?'}`);
        a.destroy(); i++; playNext();
      });
      this.setData({ playState: `▶ [${i + 1}/${items.length}] ${it.pkg} ${it.text}` });
      a.play();
      this._audio = a;
    };
    playNext();
  },

  /** ② 同包音频连播：每包 1 词（sample 的音频 canonical 就在该包） */
  onPlaySamePkg() {
    const items = PKG.pkgs
      .filter((p) => PKG.samples[p])
      .map((p) => ({ pkg: p, text: PKG.samples[p] }));
    this.playChain('同包连播', items);
  },

  /** ③ 跨包音频连播：词条所在包 ≠ 音频 canonical 包（全部分包已加载后应可播） */
  onPlayCrossPkg() {
    const items = (PKG.crossSamples || []).map((c) => ({
      pkg: `${c.levelPkg}→${c.audioPkg}`, text: c.text, audioPkg: c.audioPkg,
    }));
    this.playChain('跨包连播', items);
  },

  /** ④ 哈希抽查（与 App 线已验证值比对） */
  onHashCheck() {
    const pairs = [['pen', '6f4b93f05390baba'], ['book', 'c1948a38b5e756f2'],
                   ['ruler', '9dcfbd73ba946771'], ['pencil', '78627a04a9d9816e']];
    const bad = pairs.filter(([t, k]) => hashKey(t) !== k);
    this.log(bad.length
      ? '✗ 哈希不一致: ' + bad.map((b) => b[0]).join(',')
      : `✓ 哈希抽查一致 ${pairs.length}/${pairs.length}`);
  },
});
