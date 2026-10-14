import { useEffect, useState } from 'react';

/**
 * 防抖：value 稳定 delay 毫秒后才更新返回值。
 * 用于搜索输入、自动保存等高频触发场景。
 */
export function useDebouncedValue<T>(value: T, delay = 300): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
