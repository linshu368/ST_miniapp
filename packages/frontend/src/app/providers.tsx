'use client';

import { useEffect, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname, useRouter } from 'next/navigation';
import { QueryClientProvider } from '@tanstack/react-query';

import { FavoriteFeedbackNotice } from '@/components/characters/favorite-feedback-notice';

import { EntryShell } from '@/components/nav/entry-shell';
import { afterFirstScreen } from '@/lib/after-first-screen';
import { ensureEntryPhaseWatching, useEntryBackgroundReady } from '@/lib/entry-phase';
import { getQueryClient } from '@/lib/api/query-client';
import { useUserSettingsQuery } from '@/lib/api/settings';
import { PagePerfTracker } from '@/lib/perf/PagePerfTracker';
import { observeStartupShell } from '@/lib/perf/startup-timing';
import { markStartupPhase } from '@/lib/perf/startup-phases';
import { loadDeferredTracing, loadSessionReplay, setTelegramUser } from '@/lib/sentry/client';
import { getRawInitData } from '@/lib/telegram/auth';
import { initTelegramSdk } from '@/lib/telegram/init';
import {
  getTelegramStartParam,
  rememberInviteStartParam,
  PAYMENT_RETURN_PREFIX,
  stripSensitiveTelegramLaunchParamsFromLocation,
} from '@/lib/telegram/launch-url';
import { parseTelegramUser } from '@/lib/telegram/user';
import { useUserProfileStore } from '@/stores/user-profile-store';

const DeferredEntryEffects = dynamic(
  () =>
    import('./deferred-entry-effects')
      .then((module) => module.DeferredEntryEffects)
      .catch(() => {
        console.warn('[Startup] Deferred attribution module unavailable');
        return function DeferredEntryEffectsUnavailable() {
          return null;
        };
      }),
  { ssr: false }
);
const ReactQueryDevtools = dynamic(
  () => import('@tanstack/react-query-devtools').then((module) => module.ReactQueryDevtools),
  { ssr: false }
);

markStartupPhase('providers_loaded');

export function Providers({ children }: { children: React.ReactNode }) {
  markStartupPhase('first_render');
  const [queryClient] = useState(() => getQueryClient());
  const [telegramReady, setTelegramReady] = useState(false);
  const entryStartParam = useRef('');
  const backgroundReady = useEntryBackgroundReady();
  const pathname = usePathname();
  const [entryPathname] = useState(pathname);
  const [showQueryDevtools, setShowQueryDevtools] = useState(false);
  const hydrateUserProfile = useUserProfileStore((s) => s.hydrate);

  useEffect(() => {
    // 调试浮标会挡住手机预览的发送按钮，开发时显式用 ?devtools=1 开启。
    setShowQueryDevtools(
      process.env.NODE_ENV === 'development' &&
        new URLSearchParams(window.location.search).get('devtools') === '1'
    );
    markStartupPhase('init_start');
    initTelegramSdk();
    markStartupPhase('telegram_initialized');
    const rawInitData = getRawInitData();
    entryStartParam.current = getTelegramStartParam(rawInitData);
    rememberInviteStartParam(entryStartParam.current);
    const telegramUser = parseTelegramUser(rawInitData);
    setTelegramUser(telegramUser.id);
    stripSensitiveTelegramLaunchParamsFromLocation();
    // 录屏 SDK 是动态 chunk + 持续 DOM 采集，冷启动时会和首屏图片、列表请求抢带宽与主线程；
    // 等首屏结束（有 4s 硬上限）再加载。采样率不变，只是首屏几秒不在录。
    void afterFirstScreen().then(() => {
      void loadDeferredTracing();
      void loadSessionReplay();
    });
    // 入场分波兜底：无大厅/聊天 mark 时最迟 8s 仍放行 enrich/background。
    ensureEntryPhaseWatching();
    // initTelegramSdk 是同步副作用,initData 在它跑完后立即可读;
    // hydrate 把 telegram first_name + localStorage 覆盖合成 displayName
    hydrateUserProfile();
    markStartupPhase('bootstrap_finished');
    setTelegramReady(true);
  }, [hydrateUserProfile]);

  useEffect(() => {
    if (!telegramReady) return;
    let cancelled = false;
    let cleanup: (() => void) | undefined;
    void afterFirstScreen()
      .then(() => {
        if (cancelled) return;
        return import('@/lib/api/first-token-reports').then(({ bindFirstTokenReportRecovery }) => {
          if (!cancelled) cleanup = bindFirstTokenReportRecovery();
        });
      })
      .catch(() => console.warn('[Startup] Report recovery module unavailable'));
    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [telegramReady]);

  useEffect(() => {
    if (telegramReady) return observeStartupShell(entryPathname);
  }, [telegramReady, entryPathname]);

  return (
    <QueryClientProvider client={queryClient}>
      {telegramReady ? <PaymentReturnRedirect startParam={entryStartParam.current} /> : null}
      {telegramReady && backgroundReady ? (
        <DeferredEntryEffects startParam={entryStartParam.current} />
      ) : null}
      {telegramReady ? <UserSettingsHydrator /> : null}
      {telegramReady ? <PagePerfTracker /> : null}
      <div data-startup-shell className="min-h-screen">
        {telegramReady ? children : <EntryShell pathname={pathname} />}
      </div>
      {telegramReady ? <FavoriteFeedbackNotice /> : null}
      {showQueryDevtools ? <ReactQueryDevtools initialIsOpen={false} /> : null}
    </QueryClientProvider>
  );
}

function PaymentReturnRedirect({ startParam }: { startParam: string }) {
  const router = useRouter();

  useEffect(() => {
    if (startParam === 'payment_return') {
      router.replace('/profile/orders?payment=returned');
    } else if (startParam.startsWith(PAYMENT_RETURN_PREFIX)) {
      const orderId = startParam.slice(PAYMENT_RETURN_PREFIX.length);
      if (orderId && orderId.length <= 200 && /^[A-Za-z0-9_-]+$/.test(orderId)) {
        router.replace(`/profile/recharge/${encodeURIComponent(orderId)}?payment=returned`);
      }
    }
  }, [router, startParam]);

  return null;
}

function UserSettingsHydrator() {
  const pathname = usePathname();
  const applyServerDisplayName = useUserProfileStore((s) => s.applyServerDisplayName);
  const applyServerPhotoUrl = useUserProfileStore((s) => s.applyServerPhotoUrl);
  // 大厅首屏不看服务端 settings；本地 hydrate 够用。进「我的」/聊天等再拉，避免占入场连接。
  // profile / chat 页自己也有 reader；这里只负责写回全局 store。
  const needsServerSettings =
    Boolean(pathname?.startsWith('/profile')) || Boolean(pathname?.startsWith('/chat'));
  const backgroundReady = useEntryBackgroundReady();
  const { data } = useUserSettingsQuery({
    enabled: backgroundReady && needsServerSettings,
  });

  useEffect(() => {
    if (data) {
      applyServerDisplayName(data.settings.display_name);
      applyServerPhotoUrl(data.settings.avatar_url);
    }
  }, [applyServerDisplayName, applyServerPhotoUrl, data]);

  return null;
}
