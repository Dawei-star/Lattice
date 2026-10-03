/** LIKE 模式中的 % _ \ 必须转义，否则目录名/标题含通配符时会命中无关行 */
export function escapeLikePattern(value) {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}
