'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
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
import { BridgeProvider } from '@/components/bridge/bridge-provider';
import { STIframe } from '@/components/bridge/st-iframe';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => getQueryClient());
  const [telegramReady, setTelegramReady] = useState(false);
  const hydrateUserProfile = useUserProfileStore((s) => s.hydrate);
  const hydrateTheme = useThemeStore((s) => s.hydrate);
  const hydrateFontScale = useFontScaleStore((s) => s.hydrate);

  useEffect(() => {
    initTelegramSdk();
    // initTelegramSdk 是同步副作用,initData 在它跑完后立即可读;
    // hydrate 把 telegram first_name + localStorage 覆盖合成 displayName
    hydrateUserProfile();
    // 应用持久化的消息主题(4 轴文本色),覆盖 globals.css 的默认 var
    hydrateTheme();
    // 应用持久化的消息字号倍率
    hydrateFontScale();
    setTelegramReady(true);
  }, [hydrateUserProfile, hydrateTheme, hydrateFontScale]);

  return (
    <QueryClientProvider client={queryClient}>
      {telegramReady ? <PaymentReturnRedirect /> : null}
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

const PAYMENT_RETURN_PREFIX = 'payment_return_';

function PaymentReturnRedirect() {
  const router = useRouter();

  useEffect(() => {
    const startParam = getStartParam();
    if (startParam === 'payment_return') {
      router.replace('/profile/orders?payment=returned');
      return;
    }
    if (!startParam.startsWith(PAYMENT_RETURN_PREFIX)) return;

    const orderId = startParam.slice(PAYMENT_RETURN_PREFIX.length);
    if (!orderId || orderId.length > 200 || !/^[A-Za-z0-9_-]+$/.test(orderId)) return;
    router.replace(`/profile/recharge/${encodeURIComponent(orderId)}?payment=returned`);
  }, [router]);

  return null;
}

function GrowthEntryReporter() {
  useEffect(() => {
    try {
      const rawInitData = getRawInitData();
      console.log('[Growth] rawInitData:', rawInitData);

      // 即使没有 rawInitData，也可以尝试从 URL 中获取 startapp 参数 (本地开发环境)
      const sourceId = getStartParam();
      console.log('[Growth] Extracted sourceId:', sourceId);

      console.log('[Growth] GrowthEntryReporter sourceId:', sourceId);

      if (
        !sourceId ||
        sourceId === 'payment_return' ||
        sourceId.startsWith(PAYMENT_RETURN_PREFIX)
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
  const { data } = useUserSettingsQuery();

  useEffect(() => {
    if (data) {
      applyServerDisplayName(data.settings.display_name);
      applyServerPhotoUrl(data.settings.avatar_url);
    }
  }, [applyServerDisplayName, applyServerPhotoUrl, data]);

  return null;
}
