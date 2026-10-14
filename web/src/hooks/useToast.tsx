import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react';

/** Toast 语气。 */
export type ToastTone = 'success' | 'info' | 'error';

/** push 一条 toast 的选项。 */
export interface ToastOptions {
  tone?: ToastTone;
  /** 次级说明文字 */
  detail?: string;
  /** 展示时长（毫秒），<=0 表示不自动消失 */
  duration?: number;
  /** 去重键：同键未消失时返回已有 toast 的 id */
  dedupeKey?: string;
}

/** 单条 toast 的渲染数据。 */
export interface ToastItem {
  id: number;
  message: string;
  tone: ToastTone;
  detail?: string;
  dedupeKey?: string;
}

/** ToastProvider 暴露的 API（useToast 的返回值）。 */
export interface ToastApi {
  push: (message: string, options?: ToastOptions) => number | null | undefined;
  dismiss: (id: number) => void;
  success: (message: string, options?: ToastOptions) => number | null | undefined;
  info: (message: string, options?: ToastOptions) => number | null | undefined;
  error: (message: string, options?: ToastOptions) => number | null | undefined;
}

const ToastContext = createContext<ToastApi | null>(null);

const AUTO_DISMISS_MS: Record<ToastTone, number> = { success: 2600, info: 3200, error: 6000 };

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const seq = useRef(0);
  const dedupeKeys = useRef(new Map<string, number>());

  const dismiss = useCallback((id: number) => {
    for (const [dedupeKey, toastId] of dedupeKeys.current) {
      if (toastId === id) dedupeKeys.current.delete(dedupeKey);
    }
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (message: string, options: ToastOptions = {}): number | null | undefined => {
      if (!message) return null;
      if (options.dedupeKey && dedupeKeys.current.has(options.dedupeKey)) {
        return dedupeKeys.current.get(options.dedupeKey);
      }
      seq.current += 1;
      const id = seq.current;
      const tone = options.tone ?? 'info';
      if (options.dedupeKey) dedupeKeys.current.set(options.dedupeKey, id);

      setToasts((current) => [...current, { id, message, tone, detail: options.detail, dedupeKey: options.dedupeKey }]);

      const lifetime = options.duration ?? AUTO_DISMISS_MS[tone] ?? 3200;
      if (lifetime > 0) setTimeout(() => dismiss(id), lifetime);

      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      push,
      dismiss,
      success: (message, options) => push(message, { ...options, tone: 'success' }),
      info: (message, options) => push(message, { ...options, tone: 'info' }),
      error: (message, options) => push(message, { ...options, tone: 'error' }),
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-host" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.tone}`}>
            <span className="toast__dot" aria-hidden="true" />
            <div className="toast__content">
              <div className="toast__message">{toast.message}</div>
              {toast.detail ? <div className="toast__detail">{toast.detail}</div> : null}
            </div>
            <button type="button" className="toast__close" onClick={() => dismiss(toast.id)} aria-label="关闭提示">
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast 必须在 ToastProvider 内部使用');
  return context;
}
