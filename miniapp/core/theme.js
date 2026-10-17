// 主题管理：kids（儿童活泼，默认）/ dark（冷峻深色），持久化到 storage
const KEY = 'wm_theme';

function getTheme() {
  try {
    return wx.getStorageSync(KEY) || 'kids';
  } catch (e) {
    return 'kids';
  }
}

function setTheme(t) {
  try {
    wx.setStorageSync(KEY, t === 'dark' ? 'dark' : 'kids');
  } catch (e) { /* 静默 */ }
}

/** 页面根节点 class */
function cls(t) {
  return (t || getTheme()) === 'dark' ? 'theme-dark' : 'theme-kids';
}

/** 导航栏颜色跟随主题（frontColor 仅支持黑/白） */
function applyNav(t) {
  const conf = (t || getTheme()) === 'dark'
    ? { frontColor: '#ffffff', backgroundColor: '#171b26' }
    : { frontColor: '#000000', backgroundColor: '#fff6ea' };
  wx.setNavigationBarColor(Object.assign({ fail: () => {} }, conf));
}

module.exports = { getTheme, setTheme, cls, applyNav };
