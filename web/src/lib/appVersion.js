/**
 * 应用版本的**唯一真源**。
 *
 * 起因（2026-10-02 实测事故）：版本号曾经散落在 5 处，其中 `SettingsModal.jsx`
 * 里是一句硬编码 `const APP_VERSION = '0.1.3'`。改版本号时若正好撞上 vite 的构建窗口，
 * 就会打出「exe 名是新版本、bundle 里嵌的却是旧版本」的包 —— 用户装的是 0.1.3，
 * 设置页却显示 0.1.2，而「包内 dist == 仓库 dist」这类检查照样通过。
 *
 * 现在版本只从构建期注入：
 *   - 正式构建：vite.config.js 的 `define.__APP_VERSION__`（取自 web/package.json）
 *   - jsdom 测试：esbuild 的 `define.__APP_VERSION__`（见 test/*.test.mjs）
 *   - 兜底：`globalThis.__APP_VERSION__`，供不经过打包器的场景使用
 *
 * ⚠️ 刻意**不**提供字面量兜底（如 `?? '0.0.0'`）：那会把「忘记注入」伪装成
 * 「版本是 0.0.0」，让更新检查拿着一个假版本号去比大小。缺失就该显式炸出来。
 */

const injected = typeof __APP_VERSION__ !== 'undefined'
  ? __APP_VERSION__
  : globalThis.__APP_VERSION__;

if (typeof injected !== 'string' || !/^\d+\.\d+\.\d+/.test(injected)) {
  throw new Error(
    `应用版本未注入：拿到 ${JSON.stringify(injected)}。`
    + '构建必须注入 __APP_VERSION__（vite.config.js 的 define，源取 web/package.json 的 version）。'
    + '请不要在这里退回硬编码版本号 —— 那正是 2026-10-02「exe 名新、bundle 内嵌旧」事故的成因。',
  );
}

/** 形如 `0.1.3` 的应用版本号，设置页展示与「检查更新」的比较基准都用它。 */
export const APP_VERSION = injected;
