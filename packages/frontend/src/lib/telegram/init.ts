'use client';

// Telegram SDK 的一次性初始化。
// 说明：
// - 必须在浏览器端调用（SSR 不执行）
// - 非 Telegram 环境会抛错，这里吞掉错误保证开发期可在普通浏览器跑
// - 真机测试必须在 Telegram 客户端内完成
import { init, isTMA, miniApp } from '@telegram-apps/sdk-react';

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

/** init() 只建立 SDK 通信；框架提交渲染后还需显式撤下 Telegram 原生启动占位。 */
export function notifyTelegramReady(): 'sent' | 'unavailable' | 'failed' {
  try {
    if (typeof window === 'undefined' || !isTMA() || !miniApp.ready.isAvailable()) {
      return 'unavailable';
    }
    miniApp.ready();
    return 'sent';
  } catch {
    // 旧客户端/桥接异常不能阻塞普通页面，也不能伪造 ready 已发送的指标。
    return 'failed';
  }
}
