// 错题本：错配自动归集的词列表，支持朗读 / 错词重刷 / 清空
const store = require('../../core/store.js');
const META = require('../../core/books-meta.js');
const game = require('../../core/game.js');

Page({
  data: {
    themeCls: 'theme-kids',
    items: [],     // [{en, zh, count, bookLabel}]
    total: 0,
  },

  onShow() {
    const theme = require('../../core/theme.js');
    this.setData({ themeCls: theme.cls() });
    theme.applyNav();
    this.refresh();
  },

  onUnload() {
    if (this.audio) {
      this.audio.destroy();
      this.audio = null;
    }
  },

  refresh() {
    const wrong = store.getWrong();
    const items = Object.keys(wrong).map((k) => {
      const w = wrong[k];
      const b = META.books.find((x) => x.id === w.book);
      return {
        en: w.en,
        zh: w.zh,
        count: w.count,
        bookLabel: (b && b.label) || w.book,
      };
    });
    // 错得多的排前面
    items.sort((a, b) => b.count - a.count);
    this.setData({ items: items, total: items.length });
  },

  /** 点一下朗读该词 */
  speak(e) {
    const en = e.currentTarget.dataset.en;
    if (!this.audio) this.audio = wx.createInnerAudioContext();
    const src = game.audioSrc(en);
    if (!src) return;
    this.audio.stop();
    this.audio.src = src;
    this.audio.play();
  },

  /** 错词重刷：>= 2 个词才有意义（1 个词配不成对） */
  drill() {
    if (this.data.total < 2) {
      wx.showToast({ title: '错词不足 2 个', icon: 'none' });
      return;
    }
    wx.navigateTo({ url: '/pages/game/game?drill=1' });
  },

  /** 删除单个错词（直接删，误删重答一次即可重建） */
  remove(e) {
    const en = e.currentTarget.dataset.en;
    if (store.removeWrong(en)) {
      this.refresh();
      wx.showToast({ title: '已删除', icon: 'none', duration: 800 });
    }
  },

  clearAll() {
    if (!this.data.total) return;
    wx.showModal({
      title: '清空错题本',
      content: '将删除全部 ' + this.data.total + ' 条错词记录，不可恢复。',
      confirmText: '清空',
      confirmColor: '#f87171',
      success: (res) => {
        if (res.confirm) {
          store.clearWrong();
          this.refresh();
        }
      },
    });
  },
});
