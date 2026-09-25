/** 统一的时间源：全库只存 ISO-8601 UTC 字符串 */
export function nowIso() {
  return new Date().toISOString();
}
