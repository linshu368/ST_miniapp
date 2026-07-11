'use client';

import { useEffect, useState } from 'react';
import dynamic from 'next/dynamic';
import { usePathname } from 'next/navigation';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

import { getQueryClient } from '@/lib/api/query-client';
import { recordMiniappEntry } from '@/lib/api/growth';
import { useUserSettingsQuery } from '@/lib/api/settings';
import { getRawInitData } from '@/lib/telegram/auth';
import { initTelegramSdk } from '@/lib/telegram/init';
import { useFontScaleStore } from '@/stores/font-scale-store';
import { useThemeStore } from '@/stores/theme-store';
import { useUserProfileStore } from '@/stores/user-profile-store';
import { useAppearanceStore } from '@/stores/appearance-store';
import { BridgeProvider } from '@/components/bridge/bridge-provider';

const STIframe = dynamic(
  () => import('@/components/bridge/st-iframe').then((module) => module.STIframe),
  { ssr: false }
);
const LOBBY_CRITICAL_READY_EVENT = 'miniapp:lobby-critical-ready';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => getQueryClient());
  const pathname = usePathname();
  const [bridgeRuntimeReady, setBridgeRuntimeReady] = useState(() =>
    pathname.startsWith('/tavern/')
  );
  const [backgroundTasksReady, setBackgroundTasksReady] = useState(false);
  const hydrateUserProfile = useUserProfileStore((s) => s.hydrate);
  const hydrateAppearance = useAppearanceStore((s) => s.hydrate);
  const hydrateTheme = useThemeStore((s) => s.hydrate);
  const hydrateFontScale = useFontScaleStore((s) => s.hydrate);

  useEffect(() => {
    initTelegramSdk();
    // initTelegramSdk 是同步副作用,initData 在它跑完后立即可读;
    // hydrate 把 telegram first_name + localStorage 覆盖合成 displayName
    hydrateUserProfile();
    // 应用全局亮暗模式
    hydrateAppearance();
    // 应用持久化的消息主题(4 轴文本色),覆盖 globals.css 的默认 var
    hydrateTheme();
    // 应用持久化的消息字号倍率
    hydrateFontScale();
    performance.mark('app_shell_interactive');
    document.documentElement.dataset.appShellInteractive = 'true';
  }, [hydrateUserProfile, hydrateAppearance, hydrateTheme, hydrateFontScale]);

  useEffect(() => {
    const timer = window.setTimeout(() => setBackgroundTasksReady(true), 1_200);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (pathname.startsWith('/tavern/')) {
      setBridgeRuntimeReady(true);
      return;
    }
    if (bridgeRuntimeReady) return;

    const startBridge = () => {
      performance.mark('st_prewarm_start');
      setBridgeRuntimeReady(true);
    };
    if (document.documentElement.dataset.lobbyCriticalReady === 'true') {
      startBridge();
      return;
    }
    window.addEventListener(LOBBY_CRITICAL_READY_EVENT, startBridge, { once: true });
    const fallbackTimer = window.setTimeout(startBridge, 5_000);
    return () => {
      window.removeEventListener(LOBBY_CRITICAL_READY_EVENT, startBridge);
      clearTimeout(fallbackTimer);
    };
  }, [bridgeRuntimeReady, pathname]);

  return (
    <QueryClientProvider client={queryClient}>
      {backgroundTasksReady ? <GrowthEntryReporter /> : null}
      {backgroundTasksReady ? <UserSettingsHydrator /> : null}
      <BridgeProvider active={bridgeRuntimeReady}>
        {children}
        {bridgeRuntimeReady ? <STIframe /> : null}
      </BridgeProvider>
      {process.env.NODE_ENV === 'development' ? <ReactQueryDevtools initialIsOpen={false} /> : null}
    </QueryClientProvider>
  );
}

function GrowthEntryReporter() {
  useEffect(() => {
    try {
      const rawInitData = getRawInitData();

      // 即使没有 rawInitData，也可以尝试从 URL 中获取 startapp 参数 (本地开发环境)
      let sourceId = '';
      if (rawInitData) {
        sourceId = new URLSearchParams(rawInitData).get('start_param')?.trim() || '';
      }

      if (!sourceId && typeof window !== 'undefined') {
        const urlParams = new URLSearchParams(window.location.search);
        sourceId =
          (
            urlParams.get('startapp') ||
            urlParams.get('start_param') ||
            urlParams.get('tgWebAppStartParam')
          )?.trim() || '';
      }

      if (!sourceId) {
        return;
      }

      const key = `growth_entry_reported:${sourceId}`;
      try {
        if (sessionStorage.getItem(key) === '1') {
          return;
        }
        sessionStorage.setItem(key, '1');
      } catch (e) {
        console.warn('[Growth] sessionStorage access failed:', e);
      }

      recordMiniappEntry(sourceId)
        .then(() => {})
        .catch((err) => {
          console.error('[Growth] GrowthEntryReporter failed:', err);
          try {
            sessionStorage.removeItem(key);
          } catch (e) {
            // ignore
          }
        });
    } catch (err) {
      console.error('[Growth] Unhandled error in GrowthEntryReporter:', err);
    }
  }, []);

  return null;
}

function UserSettingsHydrator() {
  const applyServerDisplayName = useUserProfileStore((s) => s.applyServerDisplayName);
  const applyServerPhotoUrl = useUserProfileStore((s) => s.applyServerPhotoUrl);
  const { data } = useUserSettingsQuery();

  useEffect(() => {
    if (data) {
      applyServerDisplayName(data.settings.display_name);
      applyServerPhotoUrl(data.settings.avatar_url);
    }
  }, [applyServerDisplayName, applyServerPhotoUrl, data]);

  return null;
}
