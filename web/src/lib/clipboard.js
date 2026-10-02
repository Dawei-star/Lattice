const EXTENSIONS = Object.freeze({
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
});

/** Return image files from a clipboard payload with stable, filesystem-safe names. */
export function getClipboardImageFiles(clipboardData, timestamp = Date.now()) {
  return Array.from(clipboardData?.items ?? [])
    .map((item) => {
      const file = item?.getAsFile?.();
      return { file, type: normalizeImageMime(item?.type || file?.type) };
    })
    .filter(({ type }) => Boolean(type && EXTENSIONS[type]))
    .map(({ file, type }, index) => {
      return file ? createClipboardImageFile(file, type, timestamp, index) : null;
    })
    .filter(Boolean);
}

export function createClipboardImageFile(file, mimeType = file?.type, timestamp = Date.now(), index = 0) {
  const type = normalizeImageMime(mimeType || file?.type) || 'image/png';
  if (!EXTENSIONS[type]) throw new TypeError(`Unsupported clipboard image type: ${type}`);
  const extension = EXTENSIONS[type] ?? 'png';
  const suffix = index > 0 ? `-${index + 1}` : '';
  const name = `img-${formatTimestamp(timestamp)}${suffix}.${extension}`;
  return new File([file], name, {
    type: type.startsWith('image/') ? type : 'image/png',
    lastModified: file?.lastModified ?? timestamp,
  });
}

function normalizeImageMime(value) {
  const type = String(value ?? '').split(';', 1)[0].trim().toLowerCase();
  return type === 'image/jpg' ? 'image/jpeg' : type;
}

function formatTimestamp(value) {
  const date = new Date(value);
  const parts = [
    date.getFullYear(),
    date.getMonth() + 1,
    date.getDate(),
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ].map((part) => String(part).padStart(2, '0'));
  return parts.join('');
}
