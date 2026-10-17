// 主题管理：dark（Linear 冷峻）/ kids（儿童活泼），持久化到 storage
const KEY = 'wm_theme';

function getTheme() {
  try {
    return wx.getStorageSync(KEY) || 'dark';
  } catch (e) {
    return 'dark';
  }
}

function setTheme(t) {
  try {
    wx.setStorageSync(KEY, t === 'kids' ? 'kids' : 'dark');
  } catch (e) { /* 静默 */ }
}

/** 页面根节点 class */
function cls(t) {
  return (t || getTheme()) === 'kids' ? 'theme-kids' : 'theme-dark';
}

module.exports = { getTheme, setTheme, cls };
