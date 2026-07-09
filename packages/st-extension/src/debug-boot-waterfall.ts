/**
 * [TEMP DEBUG — iframe-latency] ST 冷启动资源瀑布 + CPU 长任务收割探针。
 *
 * 背景：miniapp-bridge 由 getSettings→activateExtensions 动态注入，注入时 boot 前段
 * （脚本解析 + firstLoadInit 串行网络调用）已经跑完，无法在 vendor 内直接打点（铁律）。
 * 但浏览器 Performance API 从 iframe 导航起点就在记录：
 *   - resource entries：boot 全程每个网络请求的 startTime/duration（相对 timeOrigin）
 *   - longtask entries（buffered）：>50ms 的 CPU 占用块（脚本解析/执行）
 *   - navigation entry：domInteractive / DCL / loadEventEnd
 * APP_READY 时一次性收割并经 debug-timing 通道上报，即可把「iframe_onload→APP_READY」
 * 整段还原成带时间轴的瀑布，判断耗时是单点大头还是碎片囤积。
 *
 * 移除方式：删除本文件 + entry.ts 的 installBootWaterfallProbe() 调用。以 [iframe-timing] 标注。
 */

import { stTiming } from './debug-timing.js';
import './st-types.js';

/** 单条 info 字符串上限（postMessage/日志行安全余量） */
const INFO_CHUNK_CHARS = 3200;
/** 静态资源（script/css/font/img）纳入瀑布的最小耗时；API 类请求不设门槛 */
const STATIC_MIN_DUR_MS = 50;
/** 瀑布最多上报的条目数 */
const MAX_ENTRIES = 160;

let longTaskBuffer: Array<{ start: number; dur: number }> = [];
let longTaskObserver: PerformanceObserver | null = null;

export function installBootWaterfallProbe(): void {
  try {
    // longtask 的 buffered 回放窗口有限，扩展 init 时立刻订阅（此刻已错过的早期
    // 长任务靠 buffered:true 尽量找回；找不回的部分用瀑布空窗推断）
    try {
      longTaskObserver = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          longTaskBuffer.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
        }
      });
      longTaskObserver.observe({ type: 'longtask', buffered: true } as PerformanceObserverInit);
    } catch {
      /* longtask 不被支持时静默跳过（WebView 内核差异） */
    }

    const ctx = SillyTavern.getContext();
    ctx.eventSource.on(ctx.eventTypes.APP_READY, () => {
      // 让 APP_READY 同帧的收尾请求也进入 performance buffer
      setTimeout(() => {
        try {
          harvestAndSend();
        } catch {
          /* noop */
        }
      }, 100);
    });
  } catch {
    /* noop */
  }
}

function shortName(url: string): string {
  let s = url;
  const origin = window.location.origin;
  if (s.startsWith(origin)) s = s.slice(origin.length);
  // 保留 query 里的类型标记（如 thumbnail type），去掉冗长参数值
  const qIdx = s.indexOf('?');
  if (qIdx >= 0) s = s.slice(0, qIdx + 1) + '…';
  // 常见长前缀压缩
  s = s.replace('/scripts/extensions/third-party/', '~3p/');
  s = s.replace('/scripts/extensions/', '~ext/');
  s = s.replace('/scripts/', '~s/');
  if (s.length > 72) s = s.slice(0, 69) + '…';
  return s;
}

function harvestAndSend(): void {
  const nav = performance.getEntriesByType('navigation')[0] as
    | PerformanceNavigationTiming
    | undefined;

  // 1) 导航段：文档请求与解析里程碑（相对 timeOrigin，单位 ms）
  const navInfo = nav
    ? `timeOrigin=${Math.round(performance.timeOrigin)} respEnd=${Math.round(nav.responseEnd)} ` +
      `domInteractive=${Math.round(nav.domInteractive)} DCL=${Math.round(nav.domContentLoadedEventEnd)} ` +
      `loadEnd=${Math.round(nav.loadEventEnd)}`
    : `timeOrigin=${Math.round(performance.timeOrigin)} nav=n/a`;
  stTiming('boot_nav', navInfo);

  // 2) 资源瀑布：API 类全收，静态资源只收 >=50ms 的
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  const picked = resources
    .filter((e) => {
      const isApi =
        e.initiatorType === 'fetch' ||
        e.initiatorType === 'xmlhttprequest' ||
        e.name.includes('/api/') ||
        e.name.includes('csrf-token') ||
        e.name.includes('/version');
      return isApi || e.duration >= STATIC_MIN_DUR_MS;
    })
    .sort((a, b) => a.startTime - b.startTime)
    .slice(0, MAX_ENTRIES)
    .map(
      (e) =>
        `${shortName(e.name)}@${Math.round(e.startTime)}+${Math.round(e.duration)}` +
        (e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest'
          ? ''
          : `[${e.initiatorType}]`)
    );

  sendChunked('boot_wf', picked);

  // 3) CPU 长任务（>50ms 的主线程占用块）
  const tasks = longTaskBuffer.sort((a, b) => a.start - b.start).map((t) => `${t.start}+${t.dur}`);
  sendChunked('boot_longtask', tasks);

  // 收割完毕，释放观察者
  try {
    longTaskObserver?.disconnect();
  } catch {
    /* noop */
  }
  longTaskObserver = null;
  longTaskBuffer = [];
}

/** 把条目列表按 INFO_CHUNK_CHARS 切成 name_1 / name_2 … 多条 debug-timing 消息 */
function sendChunked(name: string, items: string[]): void {
  if (items.length === 0) {
    stTiming(`${name}_1`, '(empty)');
    return;
  }
  let chunk: string[] = [];
  let size = 0;
  let idx = 1;
  for (const item of items) {
    if (size + item.length + 1 > INFO_CHUNK_CHARS && chunk.length > 0) {
      stTiming(`${name}_${idx}`, chunk.join(' '));
      idx += 1;
      chunk = [];
      size = 0;
    }
    chunk.push(item);
    size += item.length + 1;
  }
  if (chunk.length > 0) stTiming(`${name}_${idx}`, chunk.join(' '));
}
