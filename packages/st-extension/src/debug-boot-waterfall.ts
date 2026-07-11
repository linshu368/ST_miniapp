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

let bufferFull = false;

export function installBootWaterfallProbe(): void {
  try {
    // 资源条目缓冲区默认仅 250 条，ST boot 前 ~5s 即打满（pro 实测瀑布在 +4.7s 截断）。
    // 扩展注入是最早可执行点（约 +5s），立刻扩容让此后的条目继续记录；
    // 注入前已溢出丢失的条目无法找回，boot_nav 里带 bufFull/resCount 标记提示。
    try {
      performance.addEventListener('resourcetimingbufferfull', () => {
        bufferFull = true;
      });
      performance.setResourceTimingBufferSize(2000);
    } catch {
      /* noop */
    }

    // longtask 的 buffered 回放窗口有限，扩展 init 时立刻订阅（此刻已错过的早期
    // 长任务靠 buffered:true 尽量找回；找不回的部分用瀑布空窗推断。
    // 注意 iOS WebKit 不支持 longtask，此时 boot_longtask 恒为 (empty)，CPU 块只能靠瀑布空窗推断）
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
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];

  const navInfo =
    (nav
      ? `timeOrigin=${Math.round(performance.timeOrigin)} respEnd=${Math.round(nav.responseEnd)} ` +
        `domInteractive=${Math.round(nav.domInteractive)} DCL=${Math.round(nav.domContentLoadedEventEnd)} ` +
        `loadEnd=${Math.round(nav.loadEventEnd)}`
      : `timeOrigin=${Math.round(performance.timeOrigin)} nav=n/a`) +
    ` resCount=${resources.length} bufFull=${bufferFull ? 1 : 0}`;
  stTiming('boot_nav', navInfo);

  // 2) 资源瀑布：API 类全收，静态资源只收 >=50ms 的
  const filtered = resources
    .filter((e) => {
      const isApi =
        e.initiatorType === 'fetch' ||
        e.initiatorType === 'xmlhttprequest' ||
        e.name.includes('/api/') ||
        e.name.includes('csrf-token') ||
        e.name.includes('/version');
      return isApi || e.duration >= STATIC_MIN_DUR_MS;
    })
    .sort((a, b) => a.startTime - b.startTime);

  // 同名条目连发聚合（pro 实测 <audio> 触发 38 连发 message.mp3，占满条目额度）：
  // 连续同名合并为 name@首start+末end xN
  const picked: string[] = [];
  let i = 0;
  while (i < filtered.length && picked.length < MAX_ENTRIES) {
    const e = filtered[i]!;
    let j = i + 1;
    while (j < filtered.length && filtered[j]!.name === e.name) j += 1;
    const n = j - i;
    const last = filtered[j - 1]!;
    const tag =
      e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest'
        ? ''
        : `[${e.initiatorType}]`;
    if (n === 1) {
      picked.push(
        `${shortName(e.name)}@${Math.round(e.startTime)}+${Math.round(e.duration)}${tag}`
      );
    } else {
      const end = Math.round(last.startTime + last.duration);
      picked.push(`${shortName(e.name)}@${Math.round(e.startTime)}..${end}${tag}x${n}`);
    }
    i = j;
  }

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
