'use client';

import * as Sentry from '@sentry/nextjs';

import { getMetricDimensions, getNetworkTags } from './env-tags';

let installed = false;

function reportAssetFailure(kind: 'script' | 'style' | 'chunk', file: string): void {
  try {
    Sentry.metrics.count('asset.load_failed', 1, {
      attributes: { kind, ...getMetricDimensions() },
    });
    Sentry.withScope((scope) => {
      scope.setLevel('warning');
      // 按类型合并：chunk 文件名每次发版都变，按文件名分组会让 issue 列表爆炸。
      scope.setFingerprint(['asset_load_failed', kind]);
      scope.setTags({ perf_event: 'asset_load_failed', asset_kind: kind, ...getNetworkTags() });
      scope.setContext('asset', { file });
      Sentry.captureMessage('asset_load_failed');
    });
  } catch {
    // 监控自身失败不能影响页面。
  }
}

/** 只保留文件名，不带 query（可能含签名/token）。 */
function fileNameOf(url: string): string {
  try {
    return new URL(url, window.location.href).pathname.split('/').pop() ?? '';
  } catch {
    return '';
  }
}

/**
 * 资源（chunk/脚本/样式）加载失败：用户侧表现是「页面白屏/按钮没反应，重进就好」。
 * 资源加载错误不冒泡，必须在捕获阶段监听。
 */
export function installAssetFailureReporter(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  window.addEventListener(
    'error',
    (event) => {
      const target = event.target;
      if (target instanceof HTMLScriptElement) {
        reportAssetFailure('script', fileNameOf(target.src));
      } else if (target instanceof HTMLLinkElement && target.rel === 'stylesheet') {
        reportAssetFailure('style', fileNameOf(target.href));
      }
    },
    true
  );

  window.addEventListener('unhandledrejection', (event) => {
    const reason: unknown = event.reason;
    if (reason instanceof Error && reason.name === 'ChunkLoadError') {
      reportAssetFailure('chunk', '');
    }
  });
}
