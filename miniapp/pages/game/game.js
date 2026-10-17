// 配对玩法页：判分/交互口径与 App 线同源（同侧改选不判错、错配锁 620ms、零错 = 完美）
const store = require('../../core/store.js');
const game = require('../../core/game.js');

const LOCK_MS = 620;       // 错配锁定时长（同 App 线）
const OK_FLASH_MS = 500;   // 配对成功闪绿时长
const NEXT_DELAY_MS = 1100;// 过关提示后自动进入下一关的延迟

Page({
  data: {
    loading: true,
    loadError: '',
    bookId: '',
    bookLabel: '',
    levelIndex: 0,
    levelCount: 0,
    theme: '',
    leftCards: [],
    rightCards: [],
    matchedCount: 0,
    pairsTotal: 0,
    flash: '',          // 过关提示文案
    flashCls: '',       // perfect / good / finish
    bookEnd: false,
    hasPrev: false,
    hasNext: false,
    doneAll: false,     // 本册是否全部通关（选册页展示用不着，这里控制进度条文案）
    autoMode: false,    // 自动学习：自动配对 + 朗读（App 线同款）
    autoPaused: false,
    themeCls: 'theme-dark',
  },

  onLoad(query) {
    this.bookId = query.book || '';
    this.levelIndex = parseInt(query.level || '0', 10) || 0;
    this.sel = null;          // 当前选中卡
    this.locked = false;      // 错配锁定
    this.levelWrong = 0;      // 本关错配次数
    this.okTimers = [];       // 待清理的 ok-flash 定时器
    this.audio = wx.createInnerAudioContext();
    this.drillMode = query.drill === '1';   // 错词重刷局：不计册进度、不记错题本
    const theme = require('../../core/theme.js');

    let b = require('../../core/books-meta.js').books.find((x) => x.id === this.bookId);
    this.bookMeta = b || {};
    this.setData({
      bookId: this.bookId,
      bookLabel: this.drillMode ? '错词重刷' : ((b && b.label) || this.bookId),
      drillMode: this.drillMode,
      themeCls: theme.cls(),
    });

    const ready = this.drillMode ? this.buildDrillLevels() : store.loadBook(this.bookId);
    Promise.resolve(ready)
      .then((levels) => {
        if (!levels || !levels.length) throw new Error('没有可重刷的错词');
        this.levels = levels;
        this.setData({
          loading: false,
          levelCount: levels.length,
          doneAll: this.drillMode ? false : store.getDone(this.bookId).length >= levels.length,
        });
        this.loadLevel(Math.min(this.levelIndex, levels.length - 1));
      })
      .catch((err) => {
        this.setData({ loading: false, loadError: '关卡数据加载失败：' + (err.message || err) });
      });
  },

  /** 错词重刷：错词洗牌后切「关」。同关内中文释义去重（释义相同的词拆到不同关，
   *  避免同关出现两张一样的中文卡造成歧义），每关最多 6 对。 */
  buildDrillLevels() {
    const wrong = store.getWrong();
    const words = game.shuffle(Object.keys(wrong).map((k) => wrong[k]));
    const pool = words.slice();
    const levels = [];
    let cur = [];
    const seen = {};
    let guard = 0;
    while (pool.length && guard++ < 1000) {
      let placed = false;
      for (let i = 0; i < pool.length; i++) {
        if (!seen[pool[i].zh]) {
          cur.push(pool[i]);
          seen[pool[i].zh] = true;
          pool.splice(i, 1);
          placed = true;
          break;
        }
      }
      // 当前关已满 6 对，或剩下的词释义全撞车 -> 收关
      if (cur.length >= 6 || (!placed && cur.length)) {
        levels.push({
          i: levels.length,
          t: '错词重刷 ' + (levels.length + 1),
          p: cur.map((w) => ['drill:' + w.en, w.en, w.zh]),
        });
        cur = [];
        for (const k in seen) delete seen[k];
      }
      if (!placed && !cur.length) break;   // 剩余词无法成关（理论上不会发生）
    }
    // 尾关落盘：循环结束时 cur 里还攒着的词（可能因释义撞车只剩 1~5 个）必须入列
    if (cur.length) {
      levels.push({
        i: levels.length,
        t: '错词重刷 ' + (levels.length + 1),
        p: cur.map((w) => ['drill:' + w.en, w.en, w.zh]),
      });
    }
    return levels;
  },

  onUnload() {
    this.clearTimers();
    this.stopAuto();
    if (this.audio) {
      this.audio.destroy();
      this.audio = null;
    }
    if (this.nextTimer) { clearTimeout(this.nextTimer); this.nextTimer = null; }
  },

  clearTimers() {
    this.okTimers.forEach(clearTimeout);
    this.okTimers = [];
  },

  // ---- 关卡装载 ----
  loadLevel(idx) {
    this.levelIndex = idx;
    this.sel = null;
    this.locked = false;
    this.levelWrong = 0;
    this.clearTimers();
    this.stopAutoSteps();   // 换关先掐掉旧的自动步进

    const lv = this.levels[idx];
    const deck = game.buildDeck(lv.p);
    this.setData({
      levelIndex: idx,
      theme: lv.t || '',
      leftCards: deck.left,
      rightCards: deck.right,
      pairsTotal: lv.p.length,
      matchedCount: 0,
      flash: '',
      flashCls: '',
      bookEnd: false,
      hasPrev: idx > 0,
      hasNext: idx < this.levels.length - 1,
    });
    this.syncDoneFlag();
    // 自动学习模式：新关落定后自动续跑
    if (this.data.autoMode && !this.data.autoPaused) {
      this.autoTimer = setTimeout(() => { this.autoTimer = null; this.autoStep(); }, 600);
    }
  },

  syncDoneFlag() {
    const done = store.getDone(this.bookId);
    this.setData({ doneAll: done.length >= this.levels.length });
  },

  // ---- 交互 ----
  pick(e) {
    if (this.locked || this.data.bookEnd) return;
    if (this.data.autoMode) return;   // 自动学习中不接受手动点击（App 线同规则）
    const side = e.currentTarget.dataset.side;
    const uid = e.currentTarget.dataset.uid;
    const cards = side === 'L' ? this.data.leftCards : this.data.rightCards;
    const card = cards.find((c) => c.uid === uid);
    if (!card || card.done) return;

    // 再次点击同一张 -> 取消选中
    if (this.sel && this.sel.uid === card.uid) {
      this.sel = null;
      this.setSel(card.uid, side, false);
      return;
    }
    if (!this.sel) {
      this.sel = card;
      this.setSel(card.uid, side, true);
      if (side === 'L') this.speak(card.en);   // 点英文那一下就读
      return;
    }
    // 同侧改选：替换，不判错
    if (this.sel.side === card.side) {
      const prev = this.sel;
      this.sel = card;
      this.setSel(prev.uid, prev.side, false);
      this.setSel(card.uid, side, true);
      if (side === 'L') this.speak(card.en);
      return;
    }
    // 异侧：判定（card 为后选中那张）
    this.judge(this.sel, card);
  },

  setSel(uid, side, val) {
    const key = (side === 'L' ? 'leftCards' : 'rightCards');
    const arr = this.data[key];
    const i = arr.findIndex((c) => c.uid === uid);
    if (i >= 0) this.setData({ [key + '[' + i + '].sel']: val });
  },

  judge(first, second) {
    // 判定口径与 App 线 sameMeaning 同源：跨侧按中文释义相等判定
    // （同关内两词同释义时不误判），同侧比较才退回 key。
    const l = first.side === 'L' ? first : second;
    const r = first.side === 'L' ? second : first;
    const match = l.zh === r.zh;
    const en = first.side === 'L' ? first : second;
    if (second.side === 'L') this.speak(second.en); // 中文先选、英文后选：补读一次

    if (match) {
      this.applyState(first, { done: true, sel: false, ok: true });
      this.applyState(second, { done: true, sel: false, ok: true });
      this.sel = null;
      const matched = this.data.matchedCount + 1;
      this.setData({ matchedCount: matched });
      const t1 = setTimeout(() => {
        this.applyState(first, { ok: false });
        this.applyState(second, { ok: false });
      }, OK_FLASH_MS);
      this.okTimers.push(t1);
      if (matched >= this.data.pairsTotal) this.completeLevel();
    } else {
      // 错配：锁定 + 抖动 + 震动反馈（App 线为提示音，小程序用触感替代）
      this.levelWrong++;
      this.locked = true;
      this.applyState(first, { sel: false, wrong: true });
      this.applyState(second, { sel: false, wrong: true });
      wx.vibrateShort({ type: 'light' });
      // 记入错题本（错词重刷局不重复计）。注意：记「单词自己的正确释义」
      // （enCard.zh 来自数据源），而不是用户误点的那个错误释义。
      const enCard = first.side === 'L' ? first : second;
      if (!this.drillMode) store.addWrong(this.bookId, enCard.en, enCard.zh);
      setTimeout(() => {
        this.applyState(first, { wrong: false });
        this.applyState(second, { wrong: false });
        this.locked = false;
      }, LOCK_MS);
      this.sel = null;
    }
  },

  /** 按 uid 定位并更新一张卡的任意字段 */
  applyState(card, patch) {
    const key = card.side === 'L' ? 'leftCards' : 'rightCards';
    const arr = this.data[key];
    const i = arr.findIndex((c) => c.uid === card.uid);
    if (i < 0) return;
    const data = {};
    for (const k in patch) data[key + '[' + i + '].' + k] = patch[k];
    this.setData(data);
  },

  // ---- 结算 ----
  completeLevel() {
    const perfect = this.levelWrong === 0;
    if (!this.drillMode) {
      store.markDone(this.bookId, this.levelIndex);
      this.syncDoneFlag();
    }

    const isLast = this.levelIndex >= this.levels.length - 1;
    if (isLast) {
      this.stopAutoSteps();   // 本册完成，自动学习终止
      this.setData({
        bookEnd: true,
        flash: this.drillMode
          ? '🎉 错词重刷完成！'
          : (perfect ? '🎉 全对通关！本册完成' : '👍 本册完成！'),
        flashCls: 'finish',
      });
      return;
    }
    this.setData({
      flash: perfect ? '⭐️ 完美过关' : '👍 过关',
      flashCls: perfect ? 'perfect' : 'good',
    });
    this.nextTimer = setTimeout(() => {
      this.nextTimer = null;
      this.loadLevel(this.levelIndex + 1);
    }, NEXT_DELAY_MS);
  },

  // ---- 关卡导航 ----
  prevLevel() {
    if (this.data.hasPrev && !this.nextTimer) this.loadLevel(this.levelIndex - 1);
  },
  nextLevel() {
    if (this.data.hasNext && !this.nextTimer) this.loadLevel(this.levelIndex + 1);
  },
  redoLevel() {
    if (!this.nextTimer) this.loadLevel(this.levelIndex);
  },
  goBooks() {
    wx.navigateBack();
  },

  // ---- 自动学习（App 线同款：自动配对 + 朗读，可暂停/退出） ----
  toggleAuto() {
    if (this.data.autoMode) {
      this.stopAuto();
      return;
    }
    this.setData({ autoMode: true, autoPaused: false });
    this.autoStep();
  },

  toggleAutoPause() {
    if (!this.data.autoMode) return;
    if (this.data.autoPaused) {
      this.setData({ autoPaused: false });
      this.autoStep();
    } else {
      this.setData({ autoPaused: true });
      this.stopAutoSteps();
      if (this.sel) {   // 暂停时取消半选状态
        this.setSel(this.sel.uid, this.sel.side, false);
        this.sel = null;
      }
    }
  },

  stopAuto() {
    this.stopAutoSteps();
    if (this.sel) {
      this.setSel(this.sel.uid, this.sel.side, false);
      this.sel = null;
    }
    this.setData({ autoMode: false, autoPaused: false });
  },

  stopAutoSteps() {
    if (this.autoTimer) { clearTimeout(this.autoTimer); this.autoTimer = null; }
    if (this.autoPickTimer) { clearTimeout(this.autoPickTimer); this.autoPickTimer = null; }
  },

  /** 自动步进：找第一张未配对的英文卡 -> 朗读 -> 配对 -> 下一对 */
  autoStep() {
    if (!this.data.autoMode || this.data.autoPaused || this.data.bookEnd) return;
    const card = this.data.leftCards.find((c) => !c.done);
    if (!card) return;   // 全配完，交给过关流程
    this.sel = card;
    this.setSel(card.uid, 'L', true);
    this.speak(card.en);
    this.autoPickTimer = setTimeout(() => {
      this.autoPickTimer = null;
      if (!this.data.autoMode || this.data.autoPaused || this.data.bookEnd) return;
      const right = this.data.rightCards.find((c) => !c.done && c.key === card.key);
      if (!right || !this.sel) return;
      this.judge(this.sel, right);   // auto 恒配对正确，不会触发错配
      this.autoTimer = setTimeout(() => { this.autoTimer = null; this.autoStep(); }, 900);
    }, 750);
  },

  // ---- 朗读 ----
  speak(en) {
    if (!this.audio || !en) return;
    const src = game.audioSrc(en);
    if (!src) return;
    this.audio.stop();
    this.audio.src = src;
    this.audio.play();
  },
});
