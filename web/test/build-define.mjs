/**
 * jsdom 冒烟测试用 esbuild 打包 App 时要注入的常量。
 *
 * 这些测试**不走 vite**，因此拿不到 `vite.config.js` 里的 `define.__APP_VERSION__`；
 * 而 `src/lib/appVersion.js` 在拿不到注入时会**显式抛错**（刻意不兜底字面量版本号，
 * 详见该文件注释）。所以每个 esbuild 调用点都必须经由这里取同一个值。
 *
 * 值统一从 `web/package.json` 读，与 vite 的注入源保持一致 —— 测试与产物同源，
 * 不会出现「测试里是 0.1.3、包里是别的」这种测不出问题的偏差。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { version } = require('../package.json');

/** esbuild `define` 的值必须是**代码字面量**，故用 JSON.stringify 序列化。 */
export const APP_VERSION_DEFINE = JSON.stringify(version);

/**
 * 构造一个测试用的 esbuild `define`，省得每个调用点各写一份。
 * @param {'development' | 'test' | 'production'} [nodeEnv] 注入的 NODE_ENV
 */
export function testDefine(nodeEnv = 'development') {
  return {
    'process.env.NODE_ENV': JSON.stringify(nodeEnv),
    __APP_VERSION__: APP_VERSION_DEFINE,
  };
}
