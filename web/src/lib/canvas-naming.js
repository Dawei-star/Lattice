const INVALID_CANVAS_NAME = /[<>:"/\\|?*\u0000-\u001f\u007f]/;

export function canvasDisplayName(value) {
  return String(value ?? '').replace(/\.canvas$/i, '');
}

export function toCanvasFileName(value) {
  const candidate = String(value ?? '').trim();
  const baseName = canvasDisplayName(candidate).trim();
  if (!baseName || baseName === '.' || baseName === '..' || INVALID_CANVAS_NAME.test(baseName)) return '';
  return `${baseName}.canvas`;
}
