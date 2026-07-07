'use client';

import { useEffect, useState } from 'react';
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
import { STIframe } from '@/components/bridge/st-iframe';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => getQueryClient());
  const [telegramReady, setTelegramReady] = useState(false);
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
    setTelegramReady(true);
  }, [hydrateUserProfile, hydrateAppearance, hydrateTheme, hydrateFontScale]);

  return (
    <QueryClientProvider client={queryClient}>
      {telegramReady ? <GrowthEntryReporter /> : null}
      {telegramReady ? <UserSettingsHydrator /> : null}
      {telegramReady ? (
        <BridgeProvider>
          {children}
          <STIframe />
        </BridgeProvider>
      ) : null}
      {process.env.NODE_ENV === 'development' ? <ReactQueryDevtools initialIsOpen={false} /> : null}
    </QueryClientProvider>
  );
}

function GrowthEntryReporter() {
  useEffect(() => {
    const rawInitData = getRawInitData();
    if (!rawInitData) return;

    const sourceId = new URLSearchParams(rawInitData).get('start_param')?.trim();
    if (!sourceId) return;

    const key = `growth_entry_reported:${sourceId}`;
    if (sessionStorage.getItem(key) === '1') return;
    sessionStorage.setItem(key, '1');

    recordMiniappEntry(sourceId).catch(() => {
      sessionStorage.removeItem(key);
    });
  }, []);

  return null;
}

function UserSettingsHydrator() {
  const applyServerDisplayName = useUserProfileStore((s) => s.applyServerDisplayName);
  const { data } = useUserSettingsQuery();

  useEffect(() => {
    if (data) {
      applyServerDisplayName(data.settings.display_name);
    }
  }, [applyServerDisplayName, data]);

  return null;
}
