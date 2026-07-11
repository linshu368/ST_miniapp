'use client';

// Telegram SDK 的一次性初始化。
// 说明：
// - 必须在浏览器端调用（SSR 不执行）
// - 非 Telegram 环境会抛错，这里吞掉错误保证开发期可在普通浏览器跑
// - 真机测试必须在 Telegram 客户端内完成
import { init, isTMA } from '@telegram-apps/sdk-react';

let inited = false;

export function initTelegramSdk(): void {
  if (typeof window === 'undefined') return;
  if (inited) return;
  inited = true;

  try {
    // isTMA 判断是否在 Telegram Mini App 环境内
    if (!isTMA()) {
      // 开发期（普通浏览器）直接跳过，不要引入 mock 模块；
      // 需要调试 Telegram 能力时用真机或 Telegram Desktop 预览分支。
      return;
    }
    init();
  } catch {
    // SDK 初始化失败不阻塞业务（如旧版 TG 客户端）
  }
}

/** 进入角色聊天时尽可能占满 Telegram 可用视口；旧客户端安全降级为 expand。 */
export function requestTelegramChatFullscreen(): void {
  if (typeof window === 'undefined') return;
  initTelegramSdk();
  try {
    if (!isTMA()) return;
    const webApp = (
      window as typeof window & {
        Telegram?: {
          WebApp?: {
            expand?: () => void;
            requestFullscreen?: () => void;
          };
        };
      }
    ).Telegram?.WebApp;
    webApp?.expand?.();
    webApp?.requestFullscreen?.();
  } catch {
    // 非 Telegram 环境或旧客户端不阻断进入聊天。
  }
}
