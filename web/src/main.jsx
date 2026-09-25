import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { ToastProvider } from './hooks/useToast.jsx';
import './styles.css';

const container = document.getElementById('root');

createRoot(container).render(
  <StrictMode>
    <ToastProvider>
      <App />
    </ToastProvider>
  </StrictMode>,
);

/**
 * 注册 Service Worker 以启用 PWA（可安装 + 离线外壳）。
 * 仅在打包产物（PROD）下注册：开发模式由 Vite 托管，缓存反而碍事。
 * 桌面端（Electron）跳过：它本就是原生安装、后端始终随进程常驻，
 * 引入 SW 只会给热更新与调试添不确定性。
 */
const isElectron = typeof navigator !== 'undefined' && /Electron\//i.test(navigator.userAgent);

if (import.meta.env.PROD && 'serviceWorker' in navigator && !isElectron) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // 注册失败（如非安全上下文）不影响正常使用，静默降级即可
    });
  });
}
