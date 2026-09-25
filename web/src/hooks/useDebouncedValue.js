import { useEffect, useState } from 'react';

/**
 * 防抖：value 稳定 delay 毫秒后才更新返回值。
 * 用于搜索输入、自动保存等高频触发场景。
 * @template T
 * @param {T} value
 * @param {number} delay
 * @returns {T}
 */
export function useDebouncedValue(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
