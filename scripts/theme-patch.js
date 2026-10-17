/* App 端主题切换：localStorage 持久化（wm_theme），浮动按钮 🌙/🧸。
 * 由 scripts/prepare-www.mjs 注入到 www/index.html 末尾。 */
(function () {
  var KEY = 'wm_theme';
  var root = document.documentElement;

  function apply(t) {
    root.setAttribute('data-wm-theme', t);
    try { localStorage.setItem(KEY, t); } catch (e) { /* 隐私模式静默 */ }
    btn.textContent = t === 'kids' ? '🌙' : '🧸';
    btn.title = t === 'kids' ? '切换到深色模式' : '切换到儿童模式';
  }

  var btn = document.createElement('div');
  btn.id = 'wm-theme-toggle';
  btn.setAttribute('role', 'button');

  var saved = 'kids';
  try { saved = localStorage.getItem(KEY) || 'kids'; } catch (e) { /* 静默 */ }
  apply(saved === 'dark' ? 'dark' : 'kids');

  btn.addEventListener('click', function () {
    apply(root.getAttribute('data-wm-theme') === 'kids' ? 'dark' : 'kids');
  });

  document.body.appendChild(btn);
})();
