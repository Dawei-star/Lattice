import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * 开发期把 /api 代理到后端，前端因此始终使用同源相对路径，
 * 不需要在代码里硬编码后端地址，也不会触发 CORS。
 */
const API_TARGET = process.env.VITE_PROXY_TARGET ?? 'http://127.0.0.1:5177';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: false },
      '/attachments': { target: API_TARGET, changeOrigin: false },
      '/export': { target: API_TARGET, changeOrigin: false },
      '/health': { target: API_TARGET, changeOrigin: false },
      '/ready': { target: API_TARGET, changeOrigin: false },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 800,
  },
});
