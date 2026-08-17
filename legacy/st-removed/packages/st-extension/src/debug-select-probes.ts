/**
 * [TEMP DEBUG — iframe-latency] 点卡路径（selectCharacter）细粒度探针。
 *
 * 背景：pro 数据显示点卡→呈现 P50 9~10s 中 selectCharacter 占 7~8s（H3 selectCharacterById ~3s
 * + H2 /newchat ~4s），但 boot 瀑布探针只覆盖到 APP_READY，点卡窗口是盲区。
 * vendor 只读（铁律），无法在 selectCharacterById/doNewChat 内部直接打点，改用三路侧信道还原：
 *
 *   1. sel_wf_N   — 点卡窗口内的资源瀑布（chats/get / chats/save / characters/get /
 *                   tokenize 等请求的 start+dur，偏移相对 sel_start）
 *   2. sel_evt    — 窗口内 ST 生命周期事件序列（CHAT_CHANGED / CHAT_CREATED /
 *                   CHARACTER_MESSAGE_RENDERED / CHAT_LOADED…，含 handler 内手工标记）。
 *                   依 vendor getChat/getChatResult 的 emit 顺序，事件间隔即可分解出
 *                   「chats/get 网络」「printMessages 渲染」「CHAT_CHANGED 扩展 handler」等段
 *   3. sel_longtask_N — 窗口内 >50ms CPU 块（区分网络等待 vs 渲染/脚本执行；iOS WebKit
 *                   不支持 longtask，恒为 (empty)，CPU 块靠瀑布空窗推断）
 *
 * 所有偏移相对 sel_start 时刻（performance.now 基准），与主 beacon 的
 * sel_start/sel_reload_done/sel_selectById_done/sel_newchat_done（Date.now 基准）按
 * 相对偏移直接对齐。
 *
 * 移除方式：删除本文件 + select-character.ts 的 startSelectProbe/markSelectProbe/
 * stopSelectProbe 调用。全部以 [iframe-timing] 标注。
 */

import { stTiming } from './debug-timing.js';
import { shortName, sendChunked } from './debug-boot-waterfall.js';
import './st-types.js';

/** 静态资源（script/css/font/img）纳入瀑布的最小耗时；API 类请求不设门槛 */
const STATIC_MIN_DUR_MS = 50;
/** 瀑布最多上报的条目数 */
const MAX_ENTRIES = 120;
/** 窗口边界余量：捕捉恰在 sel_start 前后启动的请求 */
const WINDOW_SLACK_MS = 25;
/** 事件/长任务记录条数上限（handler 异常路径未 stop 时防止无界累积） */
const MAX_RECORDS = 300;

// 点卡窗口内值得记录的 ST 生命周期事件（key 不存在时运行时自动跳过）。
// 依 vendor script.js getChat/getChatResult 的 emit 顺序：
//   CHAT_CHANGED → (CHAT_CREATED) → MESSAGE_RECEIVED → CHARACTER_MESSAGE_RENDERED → CHAT_LOADED
const EVENT_KEYS = [
  'CHAT_CHANGED',
  'CHAT_CREATED',
  'CHAT_LOADED',
  'MESSAGE_RECEIVED',
  'CHARACTER_MESSAGE_RENDERED',
  'USER_MESSAGE_RENDERED',
];

let installed = false;
let active = false;
let t0 = 0;
let events: string[] = [];
let longTasks: string[] = [];

/** 事件监听与 longtask 观察者只安装一次（STEventSource 无 off，靠 active 开关控制记录窗口） */
function ensureInstalled(): void {
  if (installed) return;
  installed = true;

  try {
    const ctx = SillyTavern.getContext();
    const et = ctx.eventTypes as unknown as Record<string, string>;
    for (const key of EVENT_KEYS) {
      const eventName = et[key];
      if (typeof eventName !== 'string' || !eventName) continue;
      ctx.eventSource.on(eventName, () => {
        if (!active || events.length >= MAX_RECORDS) return;
        events.push(`${key}@+${Math.round(performance.now() - t0)}`);
      });
    }
  } catch {
    /* noop */
  }

  try {
    const observer = new PerformanceObserver((list) => {
      if (!active) return;
      for (const e of list.getEntries()) {
        if (longTasks.length >= MAX_RECORDS) return;
        longTasks.push(`${Math.round(e.startTime - t0)}+${Math.round(e.duration)}`);
      }
    });
    observer.observe({ type: 'longtask' } as PerformanceObserverInit);
  } catch {
    /* longtask 不被支持时静默跳过（iOS WebKit） */
  }
}

/** 在 handleSelectCharacter 的 sel_start 时刻调用，开启记录窗口 */
export function startSelectProbe(): void {
  try {
    ensureInstalled();
    events = [];
    longTasks = [];
    t0 = performance.now();
    active = true;
    // boot 探针已把 resource buffer 扩到 2000；长会话可能已接近打满，这里再抬一档,
    // 保证点卡窗口的请求条目不被丢弃（溢出与否见 sel_evt 的 bufFull 标记）。
    try {
      performance.setResourceTimingBufferSize(4000);
    } catch {
      /* noop */
    }
  } catch {
    /* noop */
  }
}

/** handler 内的边界标记（如 h1_done/h3_done），与 ST 事件按时间交错记入 sel_evt */
export function markSelectProbe(label: string): void {
  if (!active || events.length >= MAX_RECORDS) return;
  try {
    events.push(`${label}@+${Math.round(performance.now() - t0)}`);
  } catch {
    /* noop */
  }
}

/** 在 sel_newchat_done 之后调用，收割并上报三路数据 */
export function stopSelectProbe(): void {
  if (!active) return;
  active = false;
  try {
    harvestAndSend(performance.now());
  } catch {
    /* noop */
  }
}

function harvestAndSend(t1: number): void {
  // 1) 点卡窗口资源瀑布（偏移改写为相对 sel_start）
  const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  const filtered = resources
    .filter((e) => {
      if (e.startTime < t0 - WINDOW_SLACK_MS || e.startTime > t1 + WINDOW_SLACK_MS) return false;
      const isApi =
        e.initiatorType === 'fetch' ||
        e.initiatorType === 'xmlhttprequest' ||
        e.name.includes('/api/');
      return isApi || e.duration >= STATIC_MIN_DUR_MS;
    })
    .sort((a, b) => a.startTime - b.startTime)
    .slice(0, MAX_ENTRIES)
    .map((e) => {
      const tag =
        e.initiatorType === 'fetch' || e.initiatorType === 'xmlhttprequest'
          ? ''
          : `[${e.initiatorType}]`;
      return `${shortName(e.name)}@${Math.round(e.startTime - t0)}+${Math.round(e.duration)}${tag}`;
    });
  sendChunked('sel_wf', filtered);

  // 2) 事件序列（handler 标记 + ST 生命周期事件，已按发生顺序 push）
  const header = `win=${Math.round(t1 - t0)}ms resCount=${resources.length}`;
  stTiming('sel_evt', `${header} | ${events.length > 0 ? events.join(' ') : '(no-events)'}`);

  // 3) CPU 长任务
  sendChunked('sel_longtask', longTasks);
}
