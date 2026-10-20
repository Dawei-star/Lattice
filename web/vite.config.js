import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import packageJson from './package.json';
const { version: APP_VERSION } = packageJson;

/**
 * 把版本号在**构建期**注入，取代源码里的硬编码副本。
 *
 * 硬编码版留下过一次真实事故（2026-10-02）：改版本号撞上 vite 构建窗口，
 * 打出「exe 名是新版本、bundle 内嵌旧版本」的包，用户装 0.1.3 却看到设置页写 0.1.2，
 * 而「包内 dist == 仓库 dist」这类比对照样通过 —— 只有 bundle 里的版本串能拦下它。
 * 注入后版本只有 web/package.json 一份真源，改版本号不会再有第二处要同步。
 */
if (!/^\d+\.\d+\.\d+/.test(APP_VERSION)) {
  throw new Error(`web/package.json 的 version 不是合法版本号：${JSON.stringify(APP_VERSION)}`);
}

export default defineConfig(({ command }) => ({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __LATTICE_EDITOR__: JSON.stringify(command === 'serve' ? (process.env.LATTICE_EDITOR ?? '') : ''),
  },
  server: {
    port: 5173,
    // 保持 5173 为首选，但已有开发实例时自动选择下一个端口，
    // 避免前端端口冲突连带终止后端开发服务。
    strictPort: false,
    // 源码模块禁用 HTTP 缓存存储：个别内嵌浏览器不理会 no-cache 的协商语义，
    // 会直接执行磁盘缓存里的旧模块，ESM 具名导出对不上时整页白屏
    headers: { 'Cache-Control': 'no-store' },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 800,
  },
}));
