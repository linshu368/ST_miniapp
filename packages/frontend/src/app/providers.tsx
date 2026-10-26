'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

import { INVITE_START_PARAM_PREFIX } from '@miniapp/shared';

import { FavoriteFeedbackNotice } from '@/components/characters/favorite-feedback-notice';

import { LobbyShellSkeleton } from '@/components/characters/lobby-shell-skeleton';
import { afterFirstScreen, useAfterFirstScreen } from '@/lib/after-first-screen';
import { getQueryClient } from '@/lib/api/query-client';
import { recordMiniappEntry } from '@/lib/api/growth';
import { bindInvite } from '@/lib/api/invite';
import { useUserSettingsQuery } from '@/lib/api/settings';
import { observePaymentReturn } from '@/lib/payment/flow-telemetry';
import {
  attachPaymentReturnObserver,
  detachPaymentReturnObserver,
} from '@/lib/payment/return-observer';
import { PagePerfTracker } from '@/lib/perf/PagePerfTracker';
import { loadSessionReplay, setTelegramUser } from '@/lib/sentry/client';
import { initReplayTelemetry, ReplayLifecycleOwner } from '@/lib/telemetry';
import { getRawInitData } from '@/lib/telegram/auth';
import { initTelegramSdk } from '@/lib/telegram/init';
import { stripSensitiveTelegramLaunchParamsFromLocation } from '@/lib/telegram/launch-url';
import { parseTelegramUser } from '@/lib/telegram/user';
import { useUserProfileStore } from '@/stores/user-profile-store';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => getQueryClient());
  const [telegramReady, setTelegramReady] = useState(false);
  // 只有大厅有对应骨架；其他路由就绪前仍然留空，避免闪一下不相干的布局。
  const pathname = usePathname();
  const [showQueryDevtools, setShowQueryDevtools] = useState(false);
  const hydrateUserProfile = useUserProfileStore((s) => s.hydrate);

  useEffect(() => {
    // 调试浮标会挡住手机预览的发送按钮，开发时显式用 ?devtools=1 开启。
    setShowQueryDevtools(
      process.env.NODE_ENV === 'development' &&
        new URLSearchParams(window.location.search).get('devtools') === '1'
    );
    initTelegramSdk();
    const telegramUser = parseTelegramUser(getRawInitData());
    setTelegramUser(telegramUser.id);
    stripSensitiveTelegramLaunchParamsFromLocation();
    // 两套录屏 SDK 都是动态 chunk + 持续 DOM 采集，冷启动时会和首屏图片、列表请求抢带宽与主线程；
    // 等首屏结束（有 4s 硬上限）再加载。采样率不变，只是首屏几秒不在录。
    void afterFirstScreen().then(() => loadSessionReplay());
    void initReplayTelemetry(telegramUser.id, afterFirstScreen);
    // initTelegramSdk 是同步副作用,initData 在它跑完后立即可读;
    // hydrate 把 telegram first_name + localStorage 覆盖合成 displayName
    hydrateUserProfile();
    setTelegramReady(true);
  }, [hydrateUserProfile]);

  return (
    <QueryClientProvider client={queryClient}>
      {telegramReady ? <PaymentReturnRedirect /> : null}
      {telegramReady ? <GrowthEntryReporter /> : null}
      {telegramReady ? <InviteBindReporter /> : null}
      {telegramReady ? <UserSettingsHydrator /> : null}
      {telegramReady ? <ReplayLifecycleOwner /> : null}
      {telegramReady ? <PagePerfTracker /> : null}
      {telegramReady ? children : pathname === '/' ? <LobbyShellSkeleton /> : null}
      {telegramReady ? <FavoriteFeedbackNotice /> : null}
      {showQueryDevtools ? <ReactQueryDevtools initialIsOpen={false} /> : null}
    </QueryClientProvider>
  );
}

const PAYMENT_RETURN_PREFIX = 'payment_return_';

function PaymentReturnRedirect() {
  const router = useRouter();

  useEffect(() => {
    attachPaymentReturnObserver();
    const startParam = getStartParam();
    if (startParam === 'payment_return') {
      observePaymentReturn({
        source: 'start_param',
        orderId: null,
        route: '/profile/orders',
      });
      router.replace('/profile/orders?payment=returned');
    } else if (startParam.startsWith(PAYMENT_RETURN_PREFIX)) {
      const orderId = startParam.slice(PAYMENT_RETURN_PREFIX.length);
      if (orderId && orderId.length <= 200 && /^[A-Za-z0-9_-]+$/.test(orderId)) {
        observePaymentReturn({
          source: 'start_param',
          orderId,
          route: `/profile/recharge/${orderId}`,
        });
        router.replace(`/profile/recharge/${encodeURIComponent(orderId)}?payment=returned`);
      }
    }
    return () => {
      detachPaymentReturnObserver();
    };
  }, [router]);

  return null;
}

function GrowthEntryReporter() {
  useEffect(() => {
    let cancelled = false;
    void afterFirstScreen().then(() => {
      if (cancelled) return;
      try {
        const rawInitData = getRawInitData();
        console.log('[Growth] Telegram initData status:', { available: Boolean(rawInitData) });

        // 即使没有 rawInitData，也可以尝试从 URL 中获取 startapp 参数 (本地开发环境)
        const sourceId = getStartParam();
        console.log('[Growth] Extracted sourceId:', sourceId);

        console.log('[Growth] GrowthEntryReporter sourceId:', sourceId);

        if (
          !sourceId ||
          sourceId === 'payment_return' ||
          sourceId.startsWith(PAYMENT_RETURN_PREFIX) ||
          // 邀请深链不是渠道码：source_id='invite' 由绑定接口守卫式写入（阶段二计划 E2），
          // 走 botlinks 渠道逻辑会互相踩踏。
          sourceId.startsWith(INVITE_START_PARAM_PREFIX)
        ) {
          console.log('[Growth] No sourceId found, skipping report');
          return;
        }

        const key = `growth_entry_reported:${sourceId}`;
        try {
          if (sessionStorage.getItem(key) === '1') {
            console.log('[Growth] GrowthEntryReporter already reported in this session');
            return;
          }
          sessionStorage.setItem(key, '1');
        } catch (e) {
          console.warn('[Growth] sessionStorage access failed:', e);
        }

        console.log(
          '[Growth] GrowthEntryReporter calling recordMiniappEntry with sourceId:',
          sourceId
        );
        recordMiniappEntry(sourceId)
          .then((res) => {
            console.log('[Growth] GrowthEntryReporter success:', res);
          })
          .catch((err) => {
            console.error('[Growth] GrowthEntryReporter failed:', err);
            try {
              sessionStorage.removeItem(key);
            } catch {
              // ignore
            }
          });
      } catch (err) {
        console.error('[Growth] Unhandled error in GrowthEntryReporter:', err);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}

const INVITE_BIND_PENDING_KEY = 'invite_bind_pending';
const INVITE_BIND_DONE_KEY = 'invite_bind_done';
/** 与后端路由的校验一致；大小写在 RPC 内归一。 */
const INVITE_CODE_RE = /^[A-Za-z0-9]{8}$/;

/**
 * 邀请绑定上报（阶段二计划任务二）。
 * inv_ 参数先落 sessionStorage 再上报，网络失败保留待重试（防首开抖动漏归因）；
 * 任何终态（bound / already_bound / self_invite / not_new_user / invalid_code）都视为完成，
 * 不再重复请求。被邀请人侧无感知（E6），结果仅记录在控制台。
 */
function InviteBindReporter() {
  useEffect(() => {
    let cancelled = false;
    // 邀请码仍可先落 sessionStorage；真正打后端放到首屏之后，避免和大厅列表抢连接。
    try {
      const startParam = getStartParam();
      if (startParam.startsWith(INVITE_START_PARAM_PREFIX)) {
        const code = startParam.slice(INVITE_START_PARAM_PREFIX.length);
        if (INVITE_CODE_RE.test(code)) {
          sessionStorage.setItem(INVITE_BIND_PENDING_KEY, code);
        }
      }
    } catch (err) {
      console.error('[Invite] Unhandled error while caching invite code:', err);
    }

    void afterFirstScreen().then(() => {
      if (cancelled) return;
      try {
        if (sessionStorage.getItem(INVITE_BIND_DONE_KEY) === '1') return;

        const pendingCode = sessionStorage.getItem(INVITE_BIND_PENDING_KEY);
        if (!pendingCode) return;

        bindInvite(pendingCode)
          .then((data) => {
            console.log('[Invite] bind result:', data.status);
            sessionStorage.setItem(INVITE_BIND_DONE_KEY, '1');
            sessionStorage.removeItem(INVITE_BIND_PENDING_KEY);
          })
          .catch((err) => {
            // 保留 pending，下次挂载（下次启动）重试。
            console.error('[Invite] bind failed, will retry on next launch:', err);
          });
      } catch (err) {
        console.error('[Invite] Unhandled error in InviteBindReporter:', err);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}

function getStartParam(): string {
  let rawInitData: string | null = null;
  try {
    rawInitData = getRawInitData() ?? null;
  } catch {
    // 非 Telegram 环境下继续读取 URL 查询参数。
  }
  const initDataStartParam = rawInitData
    ? new URLSearchParams(rawInitData).get('start_param')?.trim()
    : null;
  if (initDataStartParam) return initDataStartParam;
  if (typeof window === 'undefined') return '';

  const urlParams = new URLSearchParams(window.location.search);
  return (
    urlParams.get('startapp') ||
    urlParams.get('start_param') ||
    urlParams.get('tgWebAppStartParam') ||
    ''
  ).trim();
}

function UserSettingsHydrator() {
  const applyServerDisplayName = useUserProfileStore((s) => s.applyServerDisplayName);
  const applyServerPhotoUrl = useUserProfileStore((s) => s.applyServerPhotoUrl);
  // 头像/昵称可先用本地 hydrate；服务端 settings 延后到首屏后，少占入场连接。
  const firstScreenDone = useAfterFirstScreen();
  const { data } = useUserSettingsQuery({ enabled: firstScreenDone });

  useEffect(() => {
    if (data) {
      applyServerDisplayName(data.settings.display_name);
      applyServerPhotoUrl(data.settings.avatar_url);
    }
  }, [applyServerDisplayName, applyServerPhotoUrl, data]);

  return null;
}
