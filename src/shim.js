/**
 * word-match-app — Android WebView 兼容 shim
 *
 * 作用：让「单词对对碰」这份纯前端单页在 Android WebView 里照常工作，且**不修改游戏源码**。
 *
 *  1) 发音：
 *     首选**内置音频包**（www/audio/<key>.ogg，由 scripts/make-audio.py 预生成）。
 *     原因：Android 的 speechSynthesis 依赖系统 TTS 引擎，而国内 ROM 普遍不预装
 *     （实测小米 22011211C / Android 14 上零引擎），导致发音静默失效。内置音频彻底摆脱该依赖，
 *     离线可用、音色统一、时长精确（用 ended 事件而非估算）。
 *     未命中或播放失败时，**退回原生 TTS**（@capacitor-community/text-to-speech）兜底。
 *     两个实现都挂到 window.speechSynthesis / SpeechSynthesisUtterance 上，游戏调用方式完全不变。
 *  2) 存储：移动端 WebView 的 localStorage 会被系统在空间紧张时回收。
 *     这里把 localStorage 额外镜像到 @capacitor/preferences（原生键值存储），
 *     启动时若本地为空则从 Preferences 恢复（必要时重载一次）。
 *
 * 部署形态：本文件经 esbuild 打包为 www/shim.js（IIFE），由 www/index.html 在 <head> 最先引入。
 */
import { TextToSpeech } from '@capacitor-community/text-to-speech';
import { Preferences } from '@capacitor/preferences';

/* ============================================================
 * 1) 发音垫片：内置音频包 → 原生 TTS 兜底
 * ============================================================ */
(function installTtsShim() {
  // 已自带可用实现（桌面浏览器预览 / iOS WKWebView）则保留系统实现，仅 Android WebView 走垫片
  if (window.speechSynthesis && typeof window.speechSynthesis.speak === 'function') return;

  try { console.log('[WMSHIM] install, href=' + location.href); } catch (e) {}

  class ShimUtterance {
    constructor(text) {
      this.text = String(text == null ? '' : text);
      this.lang = 'en-US';
      this.rate = 1;
      this.pitch = 1;
      this.volume = 1;
      this.onstart = null;
      this.onend = null;
      this.onerror = null;
      this.onpause = null;
      this.onresume = null;
    }
  }

  /* --- 音频文件名哈希：必须与 scripts/make-audio.py 的 hash_key() 逐字节一致 ---
   * 双盐 FNV-1a 32 拼接成 16 位 hex。用哈希而非原文做文件名，是因为原文含空格、
   * 单引号与弯引号(’) 等，直接当文件名不安全。 */
  const FNV_PRIME = 16777619;
  const SALT_A = 0x811c9dc5;
  const SALT_B = 0x01234567;
  const textEncoder = new TextEncoder();

  function fnv1a(bytes, basis) {
    let h = basis >>> 0;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, FNV_PRIME) >>> 0;
    }
    return h >>> 0;
  }

  function hashKey(text) {
    const bytes = textEncoder.encode(text);
    return fnv1a(bytes, SALT_A).toString(16).padStart(8, '0') +
           fnv1a(bytes, SALT_B).toString(16).padStart(8, '0');
  }

  let token = 0;      // 每次 speak/cancel 自增，用于丢弃过期回调（对应「先 cancel 再 speak」的调用习惯）
  let audioEl = null; // 当前正在播放的内置音频

  function stopAudio() {
    if (!audioEl) return;
    const el = audioEl;
    audioEl = null;
    try { el.onended = null; el.onerror = null; el.onplaying = null; } catch (e) { /* noop */ }
    try { el.pause(); } catch (e) { /* noop */ }
    try { el.removeAttribute('src'); el.load(); } catch (e) { /* noop */ }
  }

  /** 兜底：原生 TTS（部分机型的系统引擎可用；无引擎时插件会 reject，此处静默收尾） */
  function speakNative(u, my) {
    const text = (u && u.text) || '';
    try { console.log('[WMSHIM] -> fallback native TTS, text="' + text + '"'); } catch (e) {}
    if (!text) { if (u && u.onend) setTimeout(u.onend, 0); return; }

    const startedAt = Date.now();
    TextToSpeech.speak({
      text,
      lang: (u && u.lang) || 'en-US',
      rate: (u && u.rate) || 1,
      pitch: (u && u.pitch) || 1,
      volume: (u && u.volume) || 1,
    })
      .then(() => {
        if (my !== token) return; // 已被 cancel/新 speak 取代，丢弃
        // 插件若在朗读结束时才 resolve，则 elapsed≈真实时长；若立即 resolve，则按文本长度估算补齐等待，
        // 保证「自动连播」链式推进的节奏正确。
        const elapsed = Date.now() - startedAt;
        const est = Math.max(450, Math.min(8000, text.length * 95));
        const wait = Math.max(0, est - elapsed);
        setTimeout(() => {
          if (my !== token) return;
          synth.speaking = false;
          if (u && u.onend) { try { u.onend(); } catch (e) { /* noop */ } }
        }, wait);
      })
      .catch((err) => {
        if (my !== token) return;
        try { console.log('[WMSHIM] native TTS rejected: ' + (err && (err.message || JSON.stringify(err)))); } catch (e) {}
        synth.speaking = false;
        if (u && u.onerror) { try { u.onerror(err); } catch (e) { /* noop */ } }
        else if (u && u.onend) { try { u.onend(); } catch (e) { /* noop */ } }
      });
  }

  const synth = {
    speaking: false,
    pending: false,
    paused: false,

    getVoices() { return []; }, // 原生 TTS 无「语音列表」，游戏未依赖它选声

    speak(u) {
      const my = ++token;
      const text = (u && u.text) || '';
      if (!text) { if (u && u.onend) setTimeout(u.onend, 0); return; }

      stopAudio();
      this.speaking = true;

      const el = new Audio();
      el.preload = 'auto';
      const key = hashKey(text);
      const url = 'audio/' + key + '.ogg';
      el.src = url;
      audioEl = el;
      try { console.log('[WMSHIM] speak "' + text + '" key=' + key + ' url=' + url); } catch (e) {}

      el.onplaying = () => {
        if (my !== token) return;
        try { console.log('[WMSHIM] PLAYING "' + text + '"'); } catch (e) {}
        if (u && u.onstart) { try { u.onstart(); } catch (e) { /* noop */ } }
      };
      el.onended = () => {
        if (my !== token) return;
        audioEl = null;
        this.speaking = false;
        try { console.log('[WMSHIM] ended "' + text + '" dur=' + (el.duration || 0)); } catch (e) {}
        if (u && u.onend) { try { u.onend(); } catch (e) { /* noop */ } }
      };
      // 音频包缺失 / 解码失败 → 退回原生 TTS
      el.onerror = () => {
        if (my !== token) return;
        audioEl = null;
        let ec = -1, ns = el.networkState, rs = el.readyState;
        try { ec = el.error && el.error.code; } catch (e) {}
        try { console.log('[WMSHIM] audio ERROR "' + text + '" code=' + ec + ' networkState=' + ns + ' readyState=' + rs + ' url=' + url); } catch (e) {}
        speakNative(u, my);
      };

      const p = el.play();
      if (p && typeof p.catch === 'function') {
        p.catch((reason) => {
          if (my !== token) return;
          audioEl = null;
          try { console.log('[WMSHIM] play() rejected: ' + (reason && (reason.name + ': ' + reason.message))); } catch (e) {}
          speakNative(u, my);
        });
      }
    },

    cancel() {
      token++;
      this.speaking = false;
      stopAudio();
      try { TextToSpeech.stop(); } catch (e) { /* noop */ }
    },

    pause() {
      this.paused = true;
      if (audioEl) { try { audioEl.pause(); } catch (e) { /* noop */ } }
      try { TextToSpeech.stop(); } catch (e) { /* noop */ }
    },
    resume() { this.paused = false; },
  };

  try { window.SpeechSynthesisUtterance = ShimUtterance; } catch (e) { /* noop */ }
  try {
    Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true, writable: true });
  } catch (e) {
    try { window.speechSynthesis = synth; } catch (_) { /* noop */ }
  }
})();

/* ============================================================
 * 2) 存储垫片：localStorage ↔ Preferences 双向兜底
 * ============================================================ */
(function installStorageBridge() {
  const PREFIX = 'wmp_';
  const RESTORED_FLAG = 'wmp_restored';

  async function mirrorToPreferences() {
    try {
      const keys = Object.keys(localStorage);
      for (const k of keys) {
        const v = localStorage.getItem(k);
        if (v != null) await Preferences.set({ key: PREFIX + k, value: v });
      }
    } catch (e) { /* noop */ }
  }

  async function restoreFromPreferences() {
    try {
      if (sessionStorage.getItem(RESTORED_FLAG)) return;
      const { keys } = await Preferences.keys();
      if (!keys || !keys.length) return;
      let changed = 0;
      for (const k of keys) {
        if (!k.startsWith(PREFIX)) continue;
        const localKey = k.slice(PREFIX.length);
        const { value } = await Preferences.get({ key: k });
        if (value == null) continue;
        if (localStorage.getItem(localKey) !== value) {
          localStorage.setItem(localKey, value); // 仅本地缺失/不一致时才写回
          changed++;
        }
      }
      if (changed > 0) {
        sessionStorage.setItem(RESTORED_FLAG, '1');
        location.reload(); // 让游戏以自己的加载逻辑读到恢复后的数据
      }
    } catch (e) { /* noop */ }
  }

  // 退出/切后台时把最新进度镜像回原生存储
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') mirrorToPreferences();
  });
  window.addEventListener('pagehide', mirrorToPreferences);
  window.addEventListener('blur', mirrorToPreferences);

  restoreFromPreferences();
})();
