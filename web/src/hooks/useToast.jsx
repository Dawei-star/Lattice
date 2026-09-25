import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';

const ToastContext = createContext(null);

const AUTO_DISMISS_MS = { success: 2600, info: 3200, error: 6000 };

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const seq = useRef(0);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (message, options = {}) => {
      if (!message) return null;
      seq.current += 1;
      const id = seq.current;
      const tone = options.tone ?? 'info';

      setToasts((current) => [...current, { id, message, tone, detail: options.detail }]);

      const lifetime = options.duration ?? AUTO_DISMISS_MS[tone] ?? 3200;
      if (lifetime > 0) setTimeout(() => dismiss(id), lifetime);

      return id;
    },
    [dismiss],
  );

  const api = useMemo(
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

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast 必须在 ToastProvider 内部使用');
  return context;
}
