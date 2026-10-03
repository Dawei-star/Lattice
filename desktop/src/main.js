'use strict';
/**
 * 格物 Lattice 桌面版主进程。
 *
 * 架构：主进程内嵌 Express（见 backend.js），窗口直接加载
 * http://127.0.0.1:<临时端口>/ —— 后端同时托管前端产物，因此是单进程、单端口。
 * 渲染进程按纯 Web 页面处理，不开 nodeIntegration，保持和浏览器里完全一致的安全边界。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, shell, safeStorage } = require('electron');
const { startBackend, stopBackendSync } = require('./backend.js');
const { buildMenuTemplate } = require('./menu.js');
const { readVaultDir, writeVaultDir } = require('./vault-config.js');
const { copyVaultToBackup } = require('./vault-backup.js');
const { isInternalUrl, isSafeExternalUrl } = require('./url-security.js');
const { ensureAiSettingsKey } = require('./ai-key.js');
const {
  MAX_MARKDOWN_SIZE,
  findMarkdownFileArg,
  resolveExternalMarkdown,
  readExternalMarkdown,
  writeExternalMarkdown,
} = require('./external-file.js');

const APP_NAME = '格物 Lattice';
const APP_ID = 'com.lattice.desktop';

/**
 * 可用系统默认应用打开的扩展名白名单。
 * 与服务端附件功能（server/src/modules/vault/vault.attachments.js 的 MIME_BY_EXTENSION）
 * 保持同一份清单：「显示附件」开关列出的文件都必须能打开，另外放行 .md/.canvas。
 * 白名单而非任意扩展名：避免 vault 里混入的可执行/脚本文件被一键启动。
 */
const OPENABLE_FILE_EXTENSIONS = [
  '.avif', '.canvas', '.csv', '.doc', '.docx', '.gif', '.jpeg', '.jpg', '.json',
  '.md', '.mp3', '.mp4', '.pdf', '.png', '.svg', '.txt', '.wav', '.webm', '.webp',
  '.xls', '.xlsx',
];

/**
 * 窗口图标。
 *
 * Windows 上不设这个字段时会退回可执行文件内嵌的图标，所以安装版其实不设也对；
 * 但开发模式跑的是 electron.exe，不设就顶着 Electron 的默认图标 ——
 * 显式指定同一枚 .ico，开发态与发行态的窗口 / 任务栏图标才是同一套。
 *
 * 由 build/make-icon.py 生成并复制到 assets/，随包分发（见 electron-builder.yml 的 files）。
 * 开发模式下如果还没跑过生成脚本，退回可执行文件图标，不影响启动。
 */
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.ico');

/** 源码里定义的两种主题底色，用于窗口预绘制与深色下的尺寸调整 */
const THEME_BACKGROUND = { light: '#f4f6f8', dark: '#16181d' };

/**
 * 数据目录。
 *
 * - 安装版：%APPDATA%\Lattice
 * - 绿色版：exe 同级的 LatticeData\ —— 真正便携，拷走整个目录就能带走笔记库
 *
 * 目录名显式写成 ASCII，避免 productName 里的中文进入路径，减少各类工具链的编码意外。
 * 绿色版如果落在只读位置（比如直接塞进 Program Files），自动退回 %APPDATA%。
 */
function resolveUserDataDir() {
  const appDataDir = path.join(app.getPath('appData'), 'Lattice');
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;

  if (!portableDir) return ensureWritable(appDataDir) ?? appDataDir;

  const portableDataDir = path.join(portableDir, 'LatticeData');
  return ensureWritable(portableDataDir) ?? ensureWritable(appDataDir) ?? appDataDir;
}

function ensureWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return dir;
  } catch {
    return null;
  }
}

const userDataDir = resolveUserDataDir();
app.setPath('userData', userDataDir);

/**
 * GUI 应用没有控制台，把 stdout/stderr 落盘，出问题时才有迹可循。
 * 服务端的结构化日志本来就写这两个流，因此这里一接管就全都有了。
 */
function redirectStdioToLogFile() {
  const logFile = path.join(userDataDir, 'logs', 'lattice.log');
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    // 简单轮转：超过 2MB 就归档一份，避免无限增长
    if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) {
      fs.renameSync(logFile, `${logFile}.1`);
    }
  } catch {
    return;
  }

  let stream;
  try {
    stream = fs.createWriteStream(logFile, { flags: 'a' });
    // 磁盘写满、日志文件被占用等异步错误以 error 事件抛出；
    // 不挂监听器 Node 会直接 throw，主进程当场崩溃
    stream.on('error', (error) => {
      try {
        process.stderr.write(`[log] 日志写入失败: ${error?.message ?? error}\n`);
      } catch {
        // 兜底通道本身失败就只能放弃
      }
    });
  } catch {
    return;
  }

  for (const name of ['stdout', 'stderr']) {
    const target = process[name];
    if (!target || typeof target.write !== 'function') continue;

    const original = target.write.bind(target);
    target.write = (chunk, encoding, callback) => {
      try {
        stream.write(chunk);
      } catch {
        // 落盘失败不能影响业务输出
      }
      return original(chunk, encoding, callback);
    };
  }
}

redirectStdioToLogFile();

// 主进程全局兜底：打包后没有控制台，console.error 会落入日志文件（lattice.log）。
// 不兜底的话，启动完成之后注册的任意回调（托盘、IPC、定时器）抛错都会直接崩溃整个应用。
process.on('uncaughtException', (error) => {
  console.error('[main] uncaughtException', error);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection', reason);
});

/**
 * GPU 兼容性自愈。
 *
 * 少数受管环境（受限沙箱、部分虚拟机 / 远程桌面会话）里 Chromium 的 GPU 进程沙箱
 * 无法初始化，GPU 进程会反复崩溃，最终以
 *   FATAL:gpu_data_manager_impl_private.cc  GPU process isn't usable. Goodbye.
 * 直接终结整个应用 —— 用户看到的现象就是「双击了，什么都没发生」。
 *
 * 这里用标记文件兜住：同一次启动内 GPU 进程崩溃到阈值，就落下标记；
 * 下次启动自动关掉 GPU 沙箱（只作用于 GPU 进程，主进程与内嵌后端不受影响）。
 * 驱动正常的机器上永远不会触发。
 */
const GPU_CRASH_THRESHOLD = 3;
const gpuFallbackMarker = path.join(userDataDir, 'gpu-sandbox-unusable');
let gpuCrashCount = 0;

if (fs.existsSync(gpuFallbackMarker)) {
  app.commandLine.appendSwitch('disable-gpu-sandbox');
}

app.on('child-process-gone', (_event, details) => {
  if (!details || details.type !== 'GPU') return;
  if (fs.existsSync(gpuFallbackMarker)) return;

  gpuCrashCount += 1;
  if (gpuCrashCount < GPU_CRASH_THRESHOLD) return;

  try {
    fs.writeFileSync(gpuFallbackMarker, `${new Date().toISOString()} ${details.reason}\n`);
    console.error('[main] GPU 进程反复崩溃，已记录标记，下次启动将关闭 GPU 沙箱');
  } catch {
    // 标记写不进去就只能下次再试
  }
});

let mainWindow = null;
let tray = null;
let isQuitting = false;
let backend = null;
let vaultDir = null;
let pendingExternalFile = findMarkdownFileArg(process.argv);
const externalSessions = new Map();

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function toggleMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.hide();
    return;
  }
  showMainWindow();
}

function createTray() {
  if (tray || !fs.existsSync(ICON_PATH)) return;

  tray = new Tray(ICON_PATH);
  tray.setToolTip(APP_NAME);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 Lattice', click: showMainWindow },
    { type: 'separator' },
    {
      label: '退出 Lattice',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]));
  tray.on('click', toggleMainWindow);
  tray.on('double-click', showMainWindow);
}

function destroyTray() {
  tray?.destroy();
  tray = null;
}

/** 单实例：重复启动时把已有窗口拉到前台，而不是开第二个后端 */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId(APP_ID);

  app.on('second-instance', (_event, commandLine) => {
    const filePath = findMarkdownFileArg(commandLine);
    if (!mainWindow) {
      if (filePath) pendingExternalFile = filePath;
      return;
    }
    showMainWindow();
    if (filePath) void openExternalMarkdown(filePath);
  });

  app.whenReady().then(() => {
    createTray();
    return bootstrap();
  }).catch(handleFatal);

  app.on('window-all-closed', () => {
    if (!tray) app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    destroyTray();
    stopBackendSync();
  });
}

async function bootstrap() {
  Menu.setApplicationMenu(Menu.buildFromTemplate(buildMenuTemplate()));

  vaultDir = await ensureVaultSelected();
  const initialFilePath = pendingExternalFile;
  pendingExternalFile = null;
  let initialExternalToken = null;
  if (initialFilePath) {
    try {
      initialExternalToken = createExternalSession(initialFilePath);
    } catch (error) {
      reportExternalMarkdownError(error);
    }
  }
  registerVaultIpc();

  if (!process.env.AI_SETTINGS_ENCRYPTION_KEY) {
    try {
      const key = ensureAiSettingsKey({
        keyPath: path.join(userDataDir, 'ai-settings.key'),
        safeStorage,
      });
      if (key) process.env.AI_SETTINGS_ENCRYPTION_KEY = key;
    } catch (error) {
      console.warn('[main] unable to initialize OS-protected AI settings key', error?.message ?? error);
    }
  }

  backend = await startBackend({
    appRoot: app.getAppPath(),
    userDataDir,
    vaultDir,
    log: (message) => console.log(`[main] ${message}`),
  });

  createWindow(backend.url, initialExternalToken);
}

async function openExternalMarkdown(filePath) {
  if (!vaultDir || !backend || !mainWindow) {
    pendingExternalFile = filePath;
    return;
  }

  try {
    const token = createExternalSession(filePath);
    mainWindow.webContents.send('lattice:open-external-file', token);
  } catch (error) {
    reportExternalMarkdownError(error);
  }
}

function createExternalSession(filePath) {
  const resolvedPath = resolveExternalMarkdown(filePath);
  const token = crypto.randomUUID();
  externalSessions.set(token, {
    token,
    filePath: resolvedPath,
    writeGranted: false,
  });
  // 会话只在打开新文件时增加、从不清理，长期使用会缓慢泄漏；
  // Map 保持插入序，超限时淘汰最早建立的会话
  if (externalSessions.size > 50) {
    const oldest = externalSessions.keys().next().value;
    externalSessions.delete(oldest);
  }
  return token;
}

function getExternalSession(token) {
  if (typeof token !== 'string' || !token.trim()) return null;
  return externalSessions.get(token) ?? null;
}

function externalFileInfo(session) {
  const resolvedPath = resolveExternalMarkdown(session.filePath);
  let stats;
  try {
    stats = fs.statSync(resolvedPath);
  } catch {
    // 文件在会话建立后被移动/删除：裸 ENOENT 对渲染层毫无意义
    throw new Error('文件已被移动或删除，无法读取');
  }
  return {
    fileName: path.basename(resolvedPath),
    modifiedAt: stats.mtimeMs,
    content: readExternalMarkdown(resolvedPath),
    writeGranted: session.writeGranted,
  };
}

function reportExternalMarkdownError(error) {
  console.error('[main] external Markdown open failed', error);
  dialog.showErrorBox('无法打开 Markdown 文件', error?.message ?? String(error));
}

async function ensureVaultSelected() {
  const existing = readVaultDir(userDataDir);
  if (existing && fs.existsSync(existing)) return existing;

  const result = await dialog.showOpenDialog({
    title: '选择知识库文件夹',
    properties: ['openDirectory', 'createDirectory'],
    buttonLabel: '使用此文件夹',
  });
  if (result.canceled || !result.filePaths[0]) {
    throw new Error('未选择知识库文件夹，应用无法启动');
  }
  const selected = path.resolve(result.filePaths[0]);
  writeVaultDir(userDataDir, selected);
  return selected;
}

function registerVaultIpc() {
  ipcMain.removeHandler('vault:info');
  ipcMain.removeHandler('vault:select');
  ipcMain.removeHandler('vault:select-path');
  ipcMain.removeHandler('vault:backup');
  ipcMain.removeHandler('vault:export-static-site');
  ipcMain.removeHandler('vault:reveal');
  ipcMain.removeHandler('vault:reveal-path');
  ipcMain.removeHandler('vault:open-file');
  ipcMain.removeHandler('vault:read-file');
  ipcMain.removeHandler('vault:write-file');
  ipcMain.removeHandler('vault:read-markdown');
  ipcMain.removeHandler('vault:write-markdown');
  ipcMain.removeHandler('vault:move-markdown');
  ipcMain.removeHandler('vault:remove-markdown');
  ipcMain.removeHandler('external:read');
  ipcMain.removeHandler('external:grant-write');
  ipcMain.removeHandler('external:write');

  ipcMain.handle('vault:info', () => ({ path: vaultDir }));
  ipcMain.handle('vault:backup', async () => {
    if (!vaultDir) return { canceled: true };
    const result = await dialog.showOpenDialog({
      title: '选择知识库备份位置',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '保存备份到此处',
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };

    const backup = await copyVaultToBackup(vaultDir, result.filePaths[0]);
    return { canceled: false, ...backup };
  });
  ipcMain.handle('vault:export-static-site', async (_event, files) => {
    if (!Array.isArray(files) || files.length === 0 || files.length > 20_000) throw new Error('静态站点文件清单无效');
    const result = await dialog.showOpenDialog({
      title: '选择静态站点导出目录',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '导出到此处',
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true };

    const exportRoot = path.resolve(result.filePaths[0]);
    let byteCount = 0;
    for (const file of files) {
      const target = resolveStaticExportTarget(exportRoot, file?.path);
      if (!target) throw new Error('静态站点包含无效文件路径');
      const content = typeof file.content === 'string'
        ? Buffer.from(file.content, 'utf8')
        : typeof file.base64 === 'string'
          ? Buffer.from(file.base64, 'base64')
          : null;
      if (!content) throw new Error('静态站点包含无效文件内容');
      byteCount += content.byteLength;
      if (byteCount > 1024 * 1024 * 1024) throw new Error('静态站点超过 1 GB，已停止导出');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    return { canceled: false, exportPath: exportRoot, fileCount: files.length, byteCount };
  });
  ipcMain.handle('vault:select-path', async (_event, nextPath) => {
    if (typeof nextPath !== 'string' || !nextPath.trim()) return { canceled: true, path: vaultDir };
    const selected = path.resolve(nextPath.trim());
    try {
      if (!fs.statSync(selected).isDirectory()) return { canceled: true, path: vaultDir };
    } catch {
      return { canceled: true, path: vaultDir };
    }
    if (selected === vaultDir) return { canceled: false, path: vaultDir, requiresRestart: false };
    vaultDir = selected;
    writeVaultDir(userDataDir, vaultDir);
    setTimeout(() => {
      // app.exit() 不触发 before-quit，必须显式停后端：否则 HTTP 服务与 SQLite
      // 都带着脏状态被硬杀，WAL 不落盘，重启后可能读到回退的数据
      isQuitting = true;
      stopBackendSync();
      app.relaunch();
      app.exit(0);
    }, 250);
    return { canceled: false, path: vaultDir, requiresRestart: true };
  });
  ipcMain.handle('vault:select', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择知识库文件夹',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: '使用此文件夹',
    });
    if (result.canceled || !result.filePaths[0]) return { canceled: true, path: vaultDir };
    vaultDir = path.resolve(result.filePaths[0]);
    writeVaultDir(userDataDir, vaultDir);
    setTimeout(() => {
      isQuitting = true;
      stopBackendSync();
      app.relaunch();
      app.exit(0);
    }, 250);
    return { canceled: false, path: vaultDir, requiresRestart: true };
  });
  ipcMain.handle('vault:reveal', () => {
    if (!vaultDir) return false;
    shell.openPath(vaultDir);
    return true;
  });
  ipcMain.handle('vault:reveal-path', (_event, relativePath) => {
    if (!vaultDir || typeof relativePath !== 'string') return false;
    const root = path.resolve(vaultDir);
    const target = path.resolve(root, relativePath);
    const relative = path.relative(root, target);
    if (!relativePath.trim() || relative.startsWith('..') || path.isAbsolute(relative)) return false;
    if (!fs.existsSync(target)) return false;
    shell.showItemInFolder(target);
    return true;
  });
  ipcMain.handle('vault:open-file', (_event, relativePath) => {
    const target = resolveVaultFile(relativePath, OPENABLE_FILE_EXTENSIONS);
    if (!target || !fs.existsSync(target)) return false;
    shell.openPath(target);
    return true;
  });
  ipcMain.handle('vault:read-file', (_event, relativePath) => {
    const target = resolveVaultFile(relativePath, '.canvas');
    if (!target || !fs.existsSync(target)) return null;
    return fs.readFileSync(target, 'utf8');
  });
  ipcMain.handle('vault:write-file', (_event, relativePath, content) => {
    const target = resolveVaultFile(relativePath, '.canvas');
    if (!target || typeof content !== 'string' || content.length > 2 * 1024 * 1024) return false;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, content, 'utf8');
      fs.renameSync(temporary, target);
      return true;
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  });
  ipcMain.handle('vault:read-markdown', (_event, relativePath) => {
    const target = resolveVaultFile(relativePath, '.md');
    if (!target || !fs.existsSync(target)) return null;
    return fs.readFileSync(target, 'utf8');
  });
  ipcMain.handle('vault:write-markdown', (_event, relativePath, content) => {
    const target = resolveVaultFile(relativePath, '.md');
    if (!target || typeof content !== 'string' || content.length > 2 * 1024 * 1024) return false;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, content, 'utf8');
      fs.renameSync(temporary, target);
      return true;
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  });
  ipcMain.handle('vault:move-markdown', (_event, fromPath, toPath, content) => {
    const source = resolveVaultFile(fromPath, '.md');
    const target = resolveVaultFile(toPath, '.md');
    if (!source || !target || typeof content !== 'string' || content.length > 2 * 1024 * 1024) return false;
    if (source !== target && fs.existsSync(target)) return false;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const temporary = `${target}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, content, 'utf8');
      fs.renameSync(temporary, target);
      if (source !== target) fs.rmSync(source, { force: true });
      return true;
    } finally {
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
    }
  });
  ipcMain.handle('vault:remove-markdown', (_event, relativePath) => {
    const target = resolveVaultFile(relativePath, '.md');
    if (!target) return false;
    fs.rmSync(target, { force: true });
    return true;
  });

  ipcMain.handle('external:read', (_event, token) => {
    const session = getExternalSession(token);
    if (!session) return null;
    return externalFileInfo(session);
  });
  ipcMain.handle('external:grant-write', (_event, token) => {
    const session = getExternalSession(token);
    if (!session) return { granted: false, message: '外部文件会话已失效，请重新打开文件' };

    try {
      const resolvedPath = resolveExternalMarkdown(session.filePath);
      fs.accessSync(resolvedPath, fs.constants.W_OK);
      session.writeGranted = true;
      return { granted: true };
    } catch (error) {
      return {
        granted: false,
        message: error?.code === 'EACCES'
          ? '当前文件没有写入权限，请检查文件属性或安全软件设置'
          : error?.message ?? '无法获取文件写入权限',
      };
    }
  });
  ipcMain.handle('external:write', (_event, token, content) => {
    const session = getExternalSession(token);
    if (!session) throw new Error('外部文件会话已失效，请重新打开文件');
    if (!session.writeGranted) throw new Error('请先点击“获取写权限”');
    if (typeof content !== 'string' || content.length > MAX_MARKDOWN_SIZE) {
      throw new Error('Markdown 文件内容不能超过 2 MB');
    }

    return writeExternalMarkdown(session.filePath, content, { authorized: true });
  });
}

function resolveVaultFile(relativePath, extension) {
  if (!vaultDir || typeof relativePath !== 'string') return null;
  const normalized = relativePath.trim().replaceAll('\\', '/');
  const allowedExtensions = Array.isArray(extension) ? extension : [extension];
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.split('/').some((part) => !part || part === '.' || part === '..' || /[<>:"|?*\u0000]/.test(part)) || !allowedExtensions.some((value) => normalized.toLowerCase().endsWith(value))) return null;
  const root = path.resolve(vaultDir);
  const target = path.resolve(root, normalized);
  const relative = path.relative(root, target);
  return relative.startsWith('..') || path.isAbsolute(relative) ? null : target;
}

function resolveStaticExportTarget(root, relativePath) {
  if (typeof relativePath !== 'string') return null;
  const normalized = relativePath.trim().replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized)) return null;
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[<>:"|?*\u0000]/.test(segment))) return null;
  const target = path.resolve(root, ...segments);
  const relative = path.relative(root, target);
  return relative.startsWith('..') || path.isAbsolute(relative) ? null : target;
}

function createWindow(url, initialExternalToken = null) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    icon: fs.existsSync(ICON_PATH) ? ICON_PATH : undefined,
    backgroundColor: THEME_BACKGROUND.light,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      // 中文笔记场景下系统拼写检查基本只会制造红色波浪线噪音
      spellcheck: false,
    },
  });

  let everShown = false;
  mainWindow.once('ready-to-show', () => {
    everShown = true;
    mainWindow.show();
  });

  // 兜底：万一 ready-to-show 没触发，也要让用户看到窗口而不是干等。
  // 一旦正常显示过就不再干预——否则用户刚把窗口藏进托盘，8 秒后被弹回来
  setTimeout(() => {
    if (!everShown && mainWindow && !mainWindow.isVisible()) mainWindow.show();
  }, 8000);

  // 窗口底色跟随应用内主题，避免深色主题下拖动窗口时闪白边
  mainWindow.webContents.on('dom-ready', () => console.log('[main] DOM 就绪'));
  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[main] 页面加载完成');
    applyRendererTheme();
  });

  // 渲染进程的 console 转发到日志文件 —— 打包后没有控制台，这是唯一的排查入口
  // Electron 36+ 把 level/message 直接挂在事件对象上，不再作为额外参数传入
  mainWindow.webContents.on('console-message', (event) => {
    console.log(`[renderer] ${event.level}: ${event.message} (${event.sourceId}:${event.lineNumber})`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error(`[main] 渲染进程已退出：${details.reason}（exitCode=${details.exitCode}）`);
    handleRendererCrash(details);
  });

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (!isMainFrame) return; // 子框架（iframe 等）加载失败不该弹全局错误框
    if (errorCode === -3) return; // ERR_ABORTED，通常是正常的导航取消
    dialog.showErrorBox('页面加载失败', `无法加载 ${url}\n\n${errorDescription}（${errorCode}）`);
  });

  // 站内导航留在窗口内，外部链接交给系统默认浏览器；scheme 白名单外的链接静默丢弃
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (isInternalUrl(targetUrl, url)) return;
    event.preventDefault();
    if (isSafeExternalUrl(targetUrl)) shell.openExternal(targetUrl);
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    if (isInternalUrl(targetUrl, url)) return { action: 'allow' };
    if (isSafeExternalUrl(targetUrl)) shell.openExternal(targetUrl);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.on('close', (event) => {
    if (isQuitting) return;
    // 托盘不可用时不能「关窗即隐藏」：无 UI 也无图标的进程只能在任务管理器里杀
    if (!tray) return;
    event.preventDefault();
    mainWindow.hide();
  });

  const targetUrl = initialExternalToken
    ? `${url}/?external=${encodeURIComponent(initialExternalToken)}`
    : url;
  // 首屏加载失败会走 did-fail-load 的错误框，这里的 rejection 只需落日志避免未处理
  mainWindow.loadURL(targetUrl).catch((error) => console.error('[main] loadURL 失败', error));

  if (pendingExternalFile) {
    const queuedFile = pendingExternalFile;
    pendingExternalFile = null;
    setTimeout(() => openExternalMarkdown(queuedFile), 0);
  }
}

/**
 * 渲染进程崩溃兜底。
 *
 * 偶发崩溃 Chromium 会自己恢复，不用打扰用户；但反复崩溃时窗口会一直空白，
 * 与其让用户对着白屏发呆，不如明确告诉他发生了什么、日志在哪。
 *
 * 常见成因是当前环境限制了 Chromium 的子进程沙箱（受限沙箱、部分虚拟机与远程会话），
 * 这种情况下 GPU 进程、渲染进程、网络服务会一起被拦掉。
 */
const RENDERER_CRASH_THRESHOLD = 3;
let rendererCrashCount = 0;
let rendererCrashReported = false;

function handleRendererCrash(details) {
  rendererCrashCount += 1;
  if (rendererCrashReported || rendererCrashCount < RENDERER_CRASH_THRESHOLD) return;
  rendererCrashReported = true;

  dialog.showErrorBox(
    `${APP_NAME} 界面无法渲染`,
    [
      `界面进程连续 ${rendererCrashCount} 次异常退出（${details.reason}）。`,
      '',
      '这通常是当前系统环境拦截了 Chromium 的子进程沙箱所致，',
      '常见于受限的虚拟机、远程桌面会话，或安全软件的深度防护。',
      '',
      '可以尝试：把本程序加入安全软件白名单，或改在本机物理桌面会话下运行。',
      '',
      `诊断日志：${path.join(userDataDir, 'logs', 'lattice.log')}`,
    ].join('\n'),
  );
}

async function applyRendererTheme() {
  if (!mainWindow) return;
  try {
    const theme = await mainWindow.webContents.executeJavaScript(
      "document.documentElement.dataset.theme || 'light'",
      true,
    );
    mainWindow.setBackgroundColor(THEME_BACKGROUND[theme] ?? THEME_BACKGROUND.light);
  } catch {
    // 拿不到主题就用默认底色，不值得为此报错
  }
}

function handleFatal(error) {
  console.error('[main] 启动失败', error);
  dialog.showErrorBox(
    `${APP_NAME} 启动失败`,
    `${error && error.message ? error.message : String(error)}\n\n日志：${path.join(userDataDir, 'logs', 'lattice.log')}`,
  );
  app.exit(1);
}
