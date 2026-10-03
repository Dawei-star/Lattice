const MAX_DOWNLOAD_NAME_LENGTH = 180;

/** Write a generated site into a File System Access API directory handle. */
export async function writeStaticSiteToDirectory(directoryHandle, files) {
  if (!directoryHandle?.getFileHandle || !Array.isArray(files)) throw new Error('当前浏览器不支持目录写入');

  for (const file of files) {
    const segments = safeSegments(file.path);
    if (!segments.length) continue;
    let directory = directoryHandle;
    for (const segment of segments.slice(0, -1)) directory = await directory.getDirectoryHandle(segment, { create: true });
    const target = await directory.getFileHandle(segments.at(-1), { create: true });
    const writable = await target.createWritable();
    try {
      await writable.write(file.content);
    } finally {
      await writable.close();
    }
  }
}

/** Browser fallback when a directory picker is unavailable. Directory structure cannot be preserved. */
export async function downloadStaticSite(files) {
  for (const file of files ?? []) {
    const blob = new Blob([file.content], { type: file.path.endsWith('.html') ? 'text/html;charset=utf-8' : 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = flattenedDownloadName(file.path);
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

/** Convert binary site entries into a compact IPC-safe payload for Electron. */
export function serializeStaticSiteFiles(files) {
  return (files ?? []).map((file) => ({
    path: file.path,
    content: typeof file.content === 'string' ? file.content : null,
    base64: typeof file.content === 'string' ? null : bytesToBase64(file.content),
  }));
}

function safeSegments(value) {
  return String(value ?? '').replaceAll('\\', '/').split('/').filter((segment) => segment && segment !== '.' && segment !== '..' && !/^[A-Za-z]:$/.test(segment));
}

function flattenedDownloadName(value) {
  const safe = safeSegments(value).join('__').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return (safe || 'lattice-export').slice(0, MAX_DOWNLOAD_NAME_LENGTH);
}

function bytesToBase64(content) {
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content ?? []);
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  const binary = chunks.join('');
  if (typeof btoa === 'function') return btoa(binary);
  if (globalThis.Buffer) return globalThis.Buffer.from(binary, 'binary').toString('base64');
  throw new Error('当前环境不支持二进制导出');
}
