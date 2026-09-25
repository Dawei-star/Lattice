/**
 * 首屏主题引导。
 *
 * 刻意做成 public/ 下的独立同源脚本，而不是写在 index.html 里的内联 <script>：
 * 生产模式由后端托管前端产物时，HTML 会带上 `script-src 'self'` 的 CSP，
 * 内联脚本会被直接拦下（反主题闪烁就静默失效了）。独立同源文件天然满足该策略。
 *
 * 这里也刻意不用 type="module"：经典脚本是解析阻塞的，能在首次绘制前执行完，
 * 这正是「避免浅色/深色闪烁」的前提。
 */
(() => {
  try {
    const saved = localStorage.getItem('lattice-theme');
    document.documentElement.dataset.theme = saved === 'dark' || saved === 'light' ? saved : 'light';
  } catch {
    document.documentElement.dataset.theme = 'light';
  }
})();
