/** 展示层的格式化工具 */

const UNITS = [
  { limit: 60, divisor: 1, suffix: ' 秒前', floor: true },
  { limit: 3600, divisor: 60, suffix: ' 分钟前', floor: true },
  { limit: 86_400, divisor: 3600, suffix: ' 小时前', floor: true },
  { limit: 604_800, divisor: 86_400, suffix: ' 天前', floor: true },
];

/**
 * 相对时间。超过一周直接显示日期，比「37 天前」更好读。
 * @param {string} iso
 */
export function formatRelativeTime(iso) {
  if (!iso) return '';
  const timestamp = new Date(iso).getTime();
  if (Number.isNaN(timestamp)) return '';

  const elapsedSeconds = Math.max(0, (Date.now() - timestamp) / 1000);

  if (elapsedSeconds < 30) return '刚刚';

  for (const unit of UNITS) {
    if (elapsedSeconds < unit.limit) {
      const value = Math.floor(elapsedSeconds / unit.divisor);
      return `${Math.max(1, value)}${unit.suffix}`;
    }
  }

  return formatDate(iso);
}

export function formatDate(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return sameYear ? `${month}-${day}` : `${date.getFullYear()}-${month}-${day}`;
}

export function formatDateTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';

  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 千分位数字 */
export function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return number.toLocaleString('zh-CN');
}
