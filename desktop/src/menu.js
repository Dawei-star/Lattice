'use strict';
/**
 * 应用菜单模板。
 * 只保留必要的逃生通道（重载 / 开发者工具 / 缩放 / 全屏），
 * 不在这里注册 Ctrl+K、Ctrl+N、Ctrl+S 等快捷键 —— 那些由前端应用自己处理，
 * 菜单一旦占用同一组加速键就会把按键从页面手里抢走。
 */
function buildMenuTemplate() {
  return [
    {
      label: '文件',
      submenu: [{ label: '关闭窗口', role: 'close' }, { type: 'separator' }, { label: '退出', role: 'quit' }],
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '强制重新加载', role: 'forceReload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' },
      ],
    },
  ];
}

module.exports = { buildMenuTemplate };
