'use strict';

function isInternalUrl(targetUrl, appUrl) {
  try {
    return new URL(targetUrl).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

/**
 * 交给系统浏览器打开的外链只放行 http/https。
 *
 * openExternal 会把任意 scheme 递给操作系统：file:// 能直接打开本地文件，
 * ms-msdownload:/vbscript: 等冷门 scheme 历史上多次成为提权入口。笔记正文里
 * 的链接是不可信输入，因此白名单之外一律静默丢弃，而不是弹窗确认。
 */
function isSafeExternalUrl(targetUrl) {
  try {
    const protocol = new URL(targetUrl).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

module.exports = { isInternalUrl, isSafeExternalUrl };
