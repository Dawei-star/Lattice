/**
 * 键盘事件工具。
 * 中文/日文等输入法在组词阶段也会派生 keydown（Enter 确认候选、Esc 取消组词、
 * 方向键选候选），这些按键不应触发界面快捷行为，否则输入法用户的输入会被打断。
 */

/** 该键盘事件是否来自输入法组词过程（兼容 React 合成事件与原生事件） */
export function isComposingEvent(event) {
  const native = event.nativeEvent ?? event;
  return native.isComposing === true || event.keyCode === 229;
}
