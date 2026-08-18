/**
 * st-extension / patches / welcome-screen-suppress.ts
 *
 * 架构铁律：vendor/sillytavern 只读，ST 行为定制从 extension 侧处理。
 *
 * 目的（冷启动优化）：摘除 ST 原生「欢迎屏」在 APP_READY 时机的渲染。
 *
 * 背景：ST 的 welcome-screen（vendor scripts/welcome-screen.js）在 initWelcomeScreen() 里
 * 用 `eventSource.makeFirst(APP_READY, openWelcomeScreen)` 把欢迎屏挂在 APP_READY 事件最前，
 * 且 firstLoadInit 以 `await eventSource.emit(APP_READY)` 触发——openWelcomeScreen 会在
 * APP_READY 完成前串行执行：`getRecentChats()`（打 POST /api/chats/recent，一次跨洲 RTT）
 * + 渲染欢迎面板/assistant 问候。这段落在 boot 收尾关键路径上，且延后了 bridge 的 ready 握手
 * （bridge 的 APP_READY 监听器 append 在 openWelcomeScreen 之后）。
 *
 * 平台侧欢迎屏是纯浪费：冷启动期 ST iframe 全程隐藏，用户点卡后经 bridge forceNewChat 进入
 * 全新对话覆盖 #chat，欢迎面板从不可见；最近聊天列表/assistant 已由自研壳（chat-sidebar）替代。
 *
 * 手段：extension init（firstLoadInit 早于 initWelcomeScreen）时订阅 APP_INITIALIZED
 * （vendor 在 initWelcomeScreen 之后、APP_READY emit 之前触发它，见 script.js firstLoadInit），
 * 在该时机把 APP_READY 监听器里名为 openWelcomeScreen 的项摘掉。仅动 APP_READY，不动
 * CHAT_CHANGED 上的同名监听（保留原生切换聊天语义，虽平台不依赖）。
 *
 * 鲁棒性：若 ST 改名/压缩导致按名匹配不中，则静默 no-op（欢迎屏照常，等价现状，无回归）。
 * 只读式识别 + 精确移除，不影响 PinnedChatsManager.init（它在 initWelcomeScreen 里独立执行）。
 */

const WELCOME_LISTENER_NAME = 'openWelcomeScreen';

export function installWelcomeScreenSuppress(): void {
  try {
    const ctx = SillyTavern.getContext();
    const et = ctx.eventTypes as unknown as Record<string, string>;
    const appInitialized = et.APP_INITIALIZED;
    const appReady = et.APP_READY;
    if (!appInitialized || !appReady) return;

    ctx.eventSource.on(appInitialized, () => {
      try {
        // eventSource.events 是 EventEmitter 的原始监听器表（vendor lib/eventemitter.js）。
        const events = (ctx.eventSource as unknown as { events?: Record<string, unknown[]> })
          .events;
        const listeners = events?.[appReady];
        if (!Array.isArray(listeners)) return;

        for (let i = listeners.length - 1; i >= 0; i--) {
          const fn = listeners[i];
          if (typeof fn === 'function' && fn.name === WELCOME_LISTENER_NAME) {
            listeners.splice(i, 1);
          }
        }
      } catch {
        /* noop：摘除失败则欢迎屏照常，无回归 */
      }
    });
  } catch {
    /* noop */
  }
}
