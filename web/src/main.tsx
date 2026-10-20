import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { isTauri } from '@tauri-apps/api/core';
import App from './App.tsx';
import AppErrorBoundary from './components/AppErrorBoundary.tsx';
import { ToastProvider } from './hooks/useToast.tsx';
import './styles.css';

const container = document.getElementById('root');

// Release builds must stay on Tauri's embedded resource origin. A stale desktop
// launcher or a persisted WebView navigation can otherwise point at localhost,
// where another local service may return an unrelated page such as Nginx.
const isTauriEmbeddedOrigin = (origin: string): boolean => (
  origin === 'http://tauri.localhost'
  || origin === 'https://tauri.localhost'
  || origin === 'tauri://localhost'
  || origin === 'asset://localhost'
);

const isLoopbackOrigin = (origin: string): boolean => {
  try {
    const url = new URL(origin);
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  } catch {
    return false;
  }
};

const shouldRestoreEmbeddedOrigin = (
  isDesktop: boolean,
  isDevelopment: boolean,
  origin: string,
): boolean => isDesktop && !isDevelopment && !isTauriEmbeddedOrigin(origin) && isLoopbackOrigin(origin);

if (shouldRestoreEmbeddedOrigin(isTauri(), import.meta.env.DEV, window.location.origin)) {
  window.location.replace('http://tauri.localhost/');
}

if (container && !shouldRestoreEmbeddedOrigin(isTauri(), import.meta.env.DEV, window.location.origin)) {
  createRoot(container).render(
    <StrictMode>
      <ToastProvider>
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </ToastProvider>
    </StrictMode>,
  );
} else {
  document.body.textContent = '应用挂载点缺失（#root），请确认页面未被自定义脚本改写。';
}
