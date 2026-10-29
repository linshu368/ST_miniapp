'use client';

import * as Sentry from '@sentry/nextjs';
import { retrieveLaunchParams } from '@telegram-apps/sdk-react';

/**
 * 环境维度：卡顿往往集中在某类 WebView/弱网上，没有这些标签就切不出来。
 * 指标只能用低基数字段；`telegram_user_id` 只放事件，不放指标（见 design §3.4）。
 */
type NetworkInformation = { effectiveType?: string; rtt?: number };

let tgPlatform = 'unknown';
let platformRead = false;
const TELEGRAM_PLATFORMS = new Set([
  'android',
  'android_x',
  'ios',
  'macos',
  'tdesktop',
  'web',
  'weba',
  'webk',
  'unigram',
]);
const NETWORK_TYPES = new Set(['slow-2g', '2g', '3g', '4g']);

function normalizePlatform(value: unknown): string {
  return typeof value === 'string' && TELEGRAM_PLATFORMS.has(value) ? value : 'unknown';
}

function telegramPlatform(): string {
  if (!platformRead) {
    platformRead = true;
    try {
      tgPlatform = normalizePlatform(retrieveLaunchParams().tgWebAppPlatform);
    } catch {
      // Engineering dimensions must also work when Sentry is disabled or outside Telegram.
    }
  }
  return tgPlatform;
}

function connection(): NetworkInformation | undefined {
  if (typeof navigator === 'undefined') return undefined;
  try {
    return (navigator as Navigator & { connection?: NetworkInformation }).connection;
  } catch {
    return undefined;
  }
}

function rttBucket(rtt: number | undefined): string {
  if (rtt === undefined || !Number.isFinite(rtt) || rtt < 0) return 'unknown';
  if (rtt < 100) return 'lt100';
  if (rtt < 300) return '100-300';
  if (rtt < 1000) return '300-1000';
  return 'gte1000';
}

/** 网络状态会变（切 WiFi/蜂窝），每次上报都取当时的值。 */
export function getNetworkTags(): { net_type: string; net_rtt_bucket: string } {
  try {
    const info = connection();
    const effectiveType = info?.effectiveType;
    return {
      net_type: effectiveType && NETWORK_TYPES.has(effectiveType) ? effectiveType : 'unknown',
      net_rtt_bucket: rttBucket(info?.rtt),
    };
  } catch {
    return { net_type: 'unknown', net_rtt_bucket: 'unknown' };
  }
}

/** 指标 attributes：只含低基数维度。 */
export function getMetricDimensions(): { net_type: string; tg_platform: string } {
  return { net_type: getNetworkTags().net_type, tg_platform: telegramPlatform() };
}

/** 只需在启动时调用一次；失败不影响业务（非 Telegram 环境本来就取不到）。 */
export function initEnvTags(): void {
  try {
    const params = retrieveLaunchParams();
    tgPlatform = normalizePlatform(params.tgWebAppPlatform);
    platformRead = true;
    Sentry.setTag('tg_platform', tgPlatform);
    Sentry.setTag('tg_version', String(params.tgWebAppVersion ?? 'unknown'));
  } catch {
    // 普通浏览器/旧客户端：保持 unknown。
  }

  if (typeof navigator === 'undefined') return;
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (nav.deviceMemory) Sentry.setTag('device_memory_gb', String(nav.deviceMemory));
  if (nav.hardwareConcurrency) Sentry.setTag('cpu_cores', String(nav.hardwareConcurrency));
}
