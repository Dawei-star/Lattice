/**
 * 把 jsdom 的浏览器环境安装到 Node 全局对象上。
 * 必须在 import 被测代码之前调用 —— 应用在模块顶层就会读取 document / window。
 */
import { webcrypto } from 'node:crypto';
import { JSDOM } from 'jsdom';

/** jsdom 不实现的部分 API，按应用的实际用法打桩 */
function stubCanvas(window) {
  const context = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    setTransform() {},
    clearRect() {},
    beginPath() {},
    arc() {},
    fill() {},
    stroke() {},
    moveTo() {},
    lineTo() {},
    fillText() {},
    strokeText() {},
    measureText: (text) => ({ width: String(text).length * 7 }),
    save() {},
    restore() {},
    translate() {},
    scale() {},
    closePath() {},
  };

  window.HTMLCanvasElement.prototype.getContext = () => context;
}

/**
 * 注入全局变量。
 * Node 22 里 navigator / location 等是只读访问器，直接赋值会抛错，
 * 因此统一用 defineProperty 覆盖。
 */
function defineGlobal(name, value) {
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
    enumerable: true,
  });
}

export function installDom(baseUrl = 'http://127.0.0.1:5177') {
  const dom = new JSDOM(
    '<!doctype html><html data-theme="light"><head></head><body><div id="root"></div></body></html>',
    { url: baseUrl, pretendToBeVisual: true },
  );

  const { window } = dom;

  for (const [name, value] of Object.entries({
    window,
    document: window.document,
    navigator: window.navigator,
    location: window.location,
    history: window.history,
    localStorage: window.localStorage,
    sessionStorage: window.sessionStorage,
    DOMParser: window.DOMParser,
    HTMLElement: window.HTMLElement,
    HTMLInputElement: window.HTMLInputElement,
    HTMLTextAreaElement: window.HTMLTextAreaElement,
    Element: window.Element,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    Event: window.Event,
    MouseEvent: window.MouseEvent,
    KeyboardEvent: window.KeyboardEvent,
    getComputedStyle: window.getComputedStyle.bind(window),
    requestAnimationFrame: window.requestAnimationFrame.bind(window),
    cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    confirm: () => true,
  })) {
    defineGlobal(name, value);
  }

  if (!globalThis.crypto?.randomUUID) defineGlobal('crypto', webcrypto);

  // jsdom 里所有元素尺寸都是 0，会让依赖容器尺寸的图谱布局永远不建立。
  // 测试环境统一给一个固定视口。
  window.Element.prototype.getBoundingClientRect = function getBoundingClientRect() {
    return { x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 600, width: 1000, height: 600 };
  };

  stubCanvas(window);

  const observers = new Set();
  class ResizeObserverStub {
    constructor(callback) {
      this.callback = callback;
      observers.add(this);
    }

    observe() {}

    unobserve() {}

    disconnect() {
      observers.delete(this);
    }
  }

  globalThis.ResizeObserver = ResizeObserverStub;
  window.ResizeObserver = ResizeObserverStub;

  window.scrollTo = () => {};
  window.Element.prototype.scrollIntoView = () => {};

  return {
    window,
    /** 手动触发所有 ResizeObserver，模拟容器完成首次布局 */
    triggerResize(width = 1000, height = 600) {
      for (const observer of observers) {
        observer.callback([{ contentRect: { width, height } }], observer);
      }
    },
  };
}

/** 等待条件成立，避免依赖固定 sleep 造成偶发失败 */
export async function waitFor(predicate, { timeout = 8000, interval = 50, label = '条件' } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`等待超时：${label}`);
}
