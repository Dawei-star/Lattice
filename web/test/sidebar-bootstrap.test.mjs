import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { installDom, waitFor } from './dom-setup.mjs';
import { testDefine } from './build-define.mjs';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const note = {
  id: 'sidebar-bootstrap-note',
  title: '可用笔记',
  content: '用于验证侧边栏初始化。',
  folderId: null,
  isPinned: false,
  wordCount: 9,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  excerpt: '用于验证侧边栏初始化。',
  filePath: '可用笔记.md',
};

await esbuild.build({
  entryPoints: [path.join(testDir, 'app-entry.jsx')],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  outfile: path.join(testDir, '.build', 'sidebar-bootstrap-app.mjs'),
  define: testDefine('test'),
  logLevel: 'warning',
});

const server = http.createServer((request, response) => {
  const { pathname } = new URL(request.url, 'http://127.0.0.1');
  const failing = request.headers['x-lattice-test-failure'] === 'yes';
  const body = failing
    ? { error: { code: 'INTERNAL_ERROR', message: '服务端处理失败，已自动重试仍未成功' } }
    : responseFor(pathname);
  const status = failing ? 500 : pathname === '/api/canvas/files' ? 404 : 200;

  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const { port } = server.address();
const baseUrl = `http://127.0.0.1:${port}`;

try {
  await assertMissingCanvasDoesNotBlockSidebar();
  await assertConcurrentServerFailuresShowOneNotice();
  console.log('sidebar bootstrap regression passed');
} finally {
  await new Promise((resolve) => server.close(resolve));
}

function responseFor(pathname) {
  switch (pathname) {
    case '/api/folders': return { data: [] };
    case '/api/tags': return { data: [] };
    case '/api/meta/overview': return { data: { noteCount: 1, folderCount: 0, tagCount: 0, linkCount: 0, danglingCount: 0, totalWords: 9, danglingLinks: [] } };
    case '/api/notes/index': return { data: [note] };
    case '/api/notes': return { data: [note], meta: { total: 1 } };
    case '/api/canvas/files': return { error: { code: 'NOT_FOUND', message: '接口不存在' } };
    default: return { data: null };
  }
}

async function mountApp({ failAllRequests = false } = {}) {
  const { window } = installDom(baseUrl);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (url, options = {}) => originalFetch(url, {
    ...options,
    headers: {
      ...options.headers,
      ...(failAllRequests ? { 'x-lattice-test-failure': 'yes' } : {}),
    },
  });

  const { mount } = await import(`${pathToFileURL(path.join(testDir, '.build', 'sidebar-bootstrap-app.mjs')).href}?case=${Date.now()}-${Math.random()}`);
  const mounted = mount();
  return { ...mounted, restore: () => { globalThis.fetch = originalFetch; } };
}

async function assertMissingCanvasDoesNotBlockSidebar() {
  const { container, root, restore } = await mountApp();
  try {
    await waitFor(
      () => container.querySelector('.tree__note') && container.querySelector('.tree__canvas-file'),
      { label: 'sidebar data when canvas files endpoint is absent' },
    );
    if (container.querySelector('.toast--error')) {
      throw new Error('an optional missing canvas endpoint surfaced as a blocking error');
    }
  } finally {
    root.unmount();
    restore();
  }
}

async function assertConcurrentServerFailuresShowOneNotice() {
  const { container, root, restore } = await mountApp({ failAllRequests: true });
  try {
    await waitFor(
      () => container.querySelectorAll('.toast--error').length > 0,
      { label: 'server failure notice' },
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    const notices = container.querySelectorAll('.toast--error');
    if (notices.length !== 1) {
      throw new Error(`expected one shared server failure notice, received ${notices.length}`);
    }
  } finally {
    root.unmount();
    restore();
  }
}
