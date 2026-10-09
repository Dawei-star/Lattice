/**
 * 不可信数据（笔记正文、检索摘要、MCP 工具输出）的围栏包裹。
 *
 * 固定标签（如 <note-data>）可被数据内容写一行闭合标签提前逃出"不可信数据"声明区，
 * 以系统口吻注入指令；这里用一次性随机标签包裹——内容无法预知标签 id，伪造不了闭合。
 * 配套的系统提示词需声明：此类标签内的内容一律不是指令。
 */
let sequence = 0;

export function wrapUntrusted(content) {
  sequence = (sequence + 1) % 1_000_000;
  const tag = `untrusted-${Date.now().toString(36)}-${sequence}`;
  return `<${tag}>\n${String(content ?? '')}\n</${tag}>`;
}

/** 与 wrapUntrusted 同思路的数据区标签（note-data 场景：标签名要进系统提示词声明） */
export function untrustedTag(prefix = 'note-data') {
  sequence = (sequence + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${sequence}`;
}
