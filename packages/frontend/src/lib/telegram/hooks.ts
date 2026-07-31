'use client';

// 所有业务组件对 Telegram 能力的 hooks 入口。
// 规则：业务组件优先从这里 import，不要直接 import '@telegram-apps/sdk-react'。
// 原因：未来迁移独立 web 时只需替换此文件，业务代码不动。

import { useCallback, useEffect } from 'react';
import { backButton, hapticFeedback, isTMA } from '@telegram-apps/sdk-react';

export {
  useSignal,
  useLaunchParams,
  useRawInitData,
  useRawLaunchParams,
} from '@telegram-apps/sdk-react';

/** 挂载 Telegram 原生返回键，点击时触发 onClick。
 *  非 TMA 环境下静默跳过（开发期浏览器不生效）。
 *  规则：对话页、详情页等"推开一扇门"之后的场景应该挂这个 hook，
 *  而不是在 UI 上画一个返回箭头——Telegram 原生返回键是这个场景的正解。 */
export function useTelegramBackButton(onClick: () => void): void {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      if (!isTMA()) return;
      if (!backButton.isMounted()) backButton.mount();
      backButton.show();
      const off = backButton.onClick(onClick);
      return () => {
        try {
          off();
          backButton.hide();
        } catch {
          // 组件卸载期 SDK 可能已清理，忽略
        }
      };
    } catch {
      // 非 TMA 或旧版客户端，静默
      return;
    }
  }, [onClick]);
}

/**
 * 触觉反馈封装。夜间 + 单手场景下，轻微震动是"情感连接"的低成本信号：
 * - `impact('light')`：用户发出消息时，轻轻一震——"放心，送出去了"
 * - `selection()`：收到 AI 新消息时，极轻的选择感反馈——"她回了"
 *
 * 返回稳定的回调，可安全挂在事件处理器/effect 依赖里。非 TMA 环境 no-op。
 */
type ImpactStyle = 'light' | 'medium' | 'heavy' | 'rigid' | 'soft';

export function useHaptic(): {
  /** 最轻的一档——语义上的"气息感"，用于她回消息这种极克制的场景。
   *  实现上走 selectionChanged（Telegram 三档里最轻的），不要改成 impact。 */
  whisper: () => void;
  impact: (style?: ImpactStyle) => void;
  selection: () => void;
  notification: (type: 'success' | 'warning' | 'error') => void;
} {
  const impact = useCallback((style: ImpactStyle = 'light') => {
    try {
      if (typeof window === 'undefined' || !isTMA()) return;
      if (hapticFeedback.impactOccurred.isAvailable()) {
        hapticFeedback.impactOccurred(style);
      }
    } catch {
      // 静默
    }
  }, []);

  const selection = useCallback(() => {
    try {
      if (typeof window === 'undefined' || !isTMA()) return;
      if (hapticFeedback.selectionChanged.isAvailable()) {
        hapticFeedback.selectionChanged();
      }
    } catch {
      // 静默
    }
  }, []);

  const notification = useCallback((type: 'success' | 'warning' | 'error') => {
    try {
      if (typeof window === 'undefined' || !isTMA()) return;
      if (hapticFeedback.notificationOccurred.isAvailable()) {
        hapticFeedback.notificationOccurred(type);
      }
    } catch {
      // 静默
    }
  }, []);

  // whisper 和 selection 走同一个底层 API，但语义上 whisper 明确"请勿升级为 impact"
  const whisper = selection;

  return { whisper, impact, selection, notification };
}

type TelegramWindow = Window & {
  Telegram?: {
    WebApp?: {
      openLink?: (url: string, options?: { try_instant_view?: boolean }) => void;
    };
  };
};

export function openExternalUrl(url: string): void {
  if (typeof window === 'undefined') return;

  try {
    const webApp = (window as TelegramWindow).Telegram?.WebApp;
    if (webApp?.openLink) {
      webApp.openLink(url, { try_instant_view: false });
      return;
    }
  } catch {
    // 旧版客户端或非 Telegram 环境下走浏览器兜底。
  }

  window.location.assign(url);
}

const PAYMENT_SCHEME_PATTERN = /^(weixin|alipays?):\/\//i;

/**
 * @param url        支付目标：App scheme 或 H5 收银台地址
 * @param fallbackUrl App 未安装时的兜底收银台地址
 *
 * Mini App 的 WebView 分发不了 App scheme，直接 location.assign 只会得到
 * ERR_UNKNOWN_URL_SCHEME，端上表现为「无法加载」。scheme 必须交给 openLink
 * 打开的真实浏览器去唤起，中转页见 public/pay/launch.html。
 */
export function openPaymentUrl(url: string, fallbackUrl?: string): void {
  if (typeof window === 'undefined') return;

  if (PAYMENT_SCHEME_PATTERN.test(url)) {
    const launch = new URL('/pay/launch.html', window.location.origin);
    launch.searchParams.set('scheme', url);
    if (fallbackUrl) launch.searchParams.set('fallback', fallbackUrl);
    openExternalUrl(launch.toString());
    return;
  }

  openExternalUrl(url);
}
