// 册数据加载（跨分包合并）与进度持久化
const PKGS = require('./pkgs.js');
const LOADERS = require('./loaders.js');

// bookId -> levels（已按关卡序合并）；模块级缓存，切关不重复加载
const bookCache = {};

/**
 * 加载一册的全部关卡。levels 可跨包（关级粒度装箱），
 * 各包 data.js 只含本包分到的关卡，按下标 i 排序合并。
 * 返回 Promise<[{i, t, p: [[key, en, zh], ...]}]>
 */
function loadBook(bookId) {
  if (bookCache[bookId]) return Promise.resolve(bookCache[bookId]);
  const pkgList = PKGS.bookPkgs[bookId];
  if (!pkgList || !pkgList.length) {
    return Promise.reject(new Error('未知册: ' + bookId));
  }
  return Promise.all(pkgList.map((p) => LOADERS[p]())).then((mods) => {
    const levels = [];
    for (const mod of mods) {
      const arr = mod.levels && mod.levels[bookId];
      if (arr) for (const lv of arr) levels.push(lv);
    }
    levels.sort((a, b) => a.i - b.i);
    bookCache[bookId] = levels;
    return levels;
  });
}

// ---- 进度：wx storage，结构 { bookId: { done: [关卡下标...] } } ----
const PROGRESS_KEY = 'wm_progress_v1';

function loadAll() {
  try {
    return wx.getStorageSync(PROGRESS_KEY) || {};
  } catch (e) {
    return {};
  }
}

function getDone(bookId) {
  const all = loadAll();
  return (all[bookId] && all[bookId].done) || [];
}

/** 标记某关完成，返回最新 done 数组 */
function markDone(bookId, levelIdx) {
  const all = loadAll();
  const done = (all[bookId] && all[bookId].done) || [];
  if (done.indexOf(levelIdx) < 0) {
    done.push(levelIdx);
    all[bookId] = { done: done };
    try {
      wx.setStorageSync(PROGRESS_KEY, all);
    } catch (e) { /* 存储失败静默：进度丢失可接受 */ }
  }
  return done;
}

// ---- 错题本：{ en: { en, zh, book, count } }，答对不自动移除（App 线同规则） ----
// v2：v1 曾把「误点的错误释义」当词条释义存入（脏数据），升 key 直接弃用旧记录
const WRONG_KEY = 'wm_wrong_v2';

function getWrong() {
  try {
    return wx.getStorageSync(WRONG_KEY) || {};
  } catch (e) {
    return {};
  }
}

function addWrong(bookId, en, zh) {
  if (!en) return getWrong();
  const all = getWrong();
  const it = all[en] || { en: en, zh: zh, book: bookId, count: 0 };
  it.count++;
  it.zh = zh;
  it.book = bookId;
  all[en] = it;
  try {
    wx.setStorageSync(WRONG_KEY, all);
  } catch (e) { /* 静默 */ }
  return all;
}

function clearWrong() {
  try {
    wx.setStorageSync(WRONG_KEY, {});
  } catch (e) { /* 静默 */ }
}

/** 删除单个错词，返回是否确有删除 */
function removeWrong(en) {
  const all = getWrong();
  if (!all[en]) return false;
  delete all[en];
  try {
    wx.setStorageSync(WRONG_KEY, all);
  } catch (e) { /* 静默 */ }
  return true;
}

// ---- 最近学习：{ book, level }，首页「继续学习」用 ----
const LAST_KEY = 'wm_last_v1';

function setLast(bookId, level) {
  try {
    wx.setStorageSync(LAST_KEY, { book: bookId, level: level });
  } catch (e) { /* 静默 */ }
}

function getLast() {
  try {
    return wx.getStorageSync(LAST_KEY) || null;
  } catch (e) {
    return null;
  }
}

module.exports = { loadBook, getDone, markDone, getWrong, addWrong, clearWrong, removeWrong, setLast, getLast };
