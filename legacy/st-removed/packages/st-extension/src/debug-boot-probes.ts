/**
 * [TEMP DEBUG — iframe-latency] ST 冷启动（DOMContentLoaded → APP_READY）内部粗分探针。
 *
 * ST 主脚本 boot 期间会依次 emit 一批生命周期事件。这里对一组候选事件「按 key 防御式订阅」
 * （运行时 ctx.eventTypes 的 key 比 st-types.ts 的类型子集多；不存在的自动跳过），
 * 每个事件首次触发时打点 ar:<key>，用以把 st_handshake→st_ready 的 ~12s 拆成有序区间，
 * 定位 boot 峰值（settings / characters / 扩展加载 / 载入首个聊天 等）。
 *
 * 移除方式：删除本文件 + entry.ts 的 installBootTimingProbes() 调用。以 [iframe-timing] 标注。
 */

import { stTiming } from './debug-timing.js';
import './st-types.js';

// SillyTavern boot 期已知/候选事件 key（不存在的运行时会被跳过）
const CANDIDATE_EVENT_KEYS = [
  'SETTINGS_LOADED',
  'SETTINGS_UPDATED',
  'EXTENSION_SETTINGS_LOADED',
  'EXTENSIONS_FIRST_LOAD',
  'CHARACTER_PAGE_LOADED',
  'CHAT_COMPLETION_SETTINGS_READY',
  'OAI_PRESET_CHANGED_AFTER',
  'CHAT_CHANGED',
  'MORE_MESSAGES_LOADED',
  'APP_READY',
];

export function installBootTimingProbes(): void {
  try {
    const ctx = SillyTavern.getContext();
    const et = ctx.eventTypes as unknown as Record<string, string>;
    const fired = new Set<string>();

    for (const key of CANDIDATE_EVENT_KEYS) {
      const eventName = et[key];
      if (typeof eventName !== 'string' || !eventName) continue;
      ctx.eventSource.on(eventName, () => {
        if (fired.has(key)) return; // 只记首次
        fired.add(key);
        stTiming(`ar:${key}`);
      });
    }
  } catch {
    /* noop */
  }
}
