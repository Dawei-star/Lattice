/**
 * 冒烟测试入口：由 esbuild 打包后在 jsdom 环境中运行。
 * 只做一件事 —— 挂载真实的 App 组件树，并暴露 DOM 供测试脚本断言。
 */
import { createRoot } from 'react-dom/client';
import App from '../src/App.jsx';
import { ToastProvider } from '../src/hooks/useToast.jsx';

export function mount() {
  const container = document.getElementById('root');
  const root = createRoot(container);

  root.render(
    <ToastProvider>
      <App />
    </ToastProvider>,
  );

  return { root, container };
}
