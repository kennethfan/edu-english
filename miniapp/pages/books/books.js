// 选册页：主题切换 + 学段 Tab + 总进度 + 26 册网格
const META = require('../../core/books-meta.js');
const store = require('../../core/store.js');
const theme = require('../../core/theme.js');

const STAGE_ORDER = ['小学', '初中', '高中', '大学'];
const TABS = ['全部'].concat(STAGE_ORDER);

Page({
  data: {
    themeCls: 'theme-dark',
    theme: 'dark',
    side: TABS,
    activeStage: '全部',
    books: [],
    statDone: 0,
    statTotal: 0,
    statPercent: 0,
    wrongCount: 0,
    totalBooks: 0,
  },

  onShow() {
    this.setData({ themeCls: theme.cls(), theme: theme.getTheme() });
    this.refresh();
  },

  /** 切主题：写入 storage 并整页换肤 */
  toggleTheme() {
    const next = this.data.theme === 'dark' ? 'kids' : 'dark';
    theme.setTheme(next);
    this.setData({ theme: next, themeCls: theme.cls(next) });
  },

  switchTab(e) {
    const stage = e.currentTarget.dataset.stage;
    if (stage === this.data.activeStage) return;
    this.setData({ activeStage: stage });
    this.refresh();
  },

  refresh() {
    const books = META.books;
    const stage = this.data.activeStage;
    const use = stage === '全部' ? books : books.filter((b) => b.stage === stage);

    let statDone = 0;
    let statTotal = 0;
    const list = use.map((b) => {
      const done = store.getDone(b.id).length;
      statDone += done;
      statTotal += b.levelCount;
      return {
        id: b.id,
        label: b.label,
        stage: b.stage,
        levelCount: b.levelCount,
        wordCount: b.wordCount,
        done: done,
        total: b.levelCount,
        percent: b.levelCount ? Math.round((done / b.levelCount) * 100) : 0,
        finished: done >= b.levelCount,
      };
    });
    this.setData({
      books: list,
      totalBooks: use.length,
      statDone: statDone,
      statTotal: statTotal,
      statPercent: statTotal ? Math.round((statDone / statTotal) * 100) : 0,
      wrongCount: Object.keys(store.getWrong()).length,
    });
  },

  /** 进入该册第一个未完成的关（全完成则回第 1 关） */
  openBook(e) {
    const bookId = e.currentTarget.dataset.id;
    const b = META.books.find((x) => x.id === bookId);
    if (!b) return;
    const done = store.getDone(bookId);
    let level = 0;
    for (let i = 0; i < b.levelCount; i++) {
      if (done.indexOf(i) < 0) { level = i; break; }
      level = i;
    }
    wx.navigateTo({ url: '/pages/game/game?book=' + bookId + '&level=' + level });
    store.setLast(bookId, level);   // 供首页「继续学习」直达
  },

  openWrong() {
    wx.navigateTo({ url: '/pages/wrong/wrong' });
  },
});
