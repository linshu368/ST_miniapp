'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';

import { INVITE_START_PARAM_PREFIX } from '@miniapp/shared';

import { getQueryClient } from '@/lib/api/query-client';
import { recordMiniappEntry } from '@/lib/api/growth';
import { bindInvite } from '@/lib/api/invite';
import { useUserSettingsQuery } from '@/lib/api/settings';
import { loadSessionReplay, setTelegramUser } from '@/lib/sentry/client';
import { getRawInitData } from '@/lib/telegram/auth';
import { initTelegramSdk } from '@/lib/telegram/init';
import { stripSensitiveTelegramLaunchParamsFromLocation } from '@/lib/telegram/launch-url';
import { parseTelegramUser } from '@/lib/telegram/user';
import { useFontScaleStore } from '@/stores/font-scale-store';
import { useUserProfileStore } from '@/stores/user-profile-store';

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => getQueryClient());
  const [telegramReady, setTelegramReady] = useState(false);
  const hydrateUserProfile = useUserProfileStore((s) => s.hydrate);
  const hydrateFontScale = useFontScaleStore((s) => s.hydrate);

  useEffect(() => {
    initTelegramSdk();
    const telegramUser = parseTelegramUser(getRawInitData());
    setTelegramUser(telegramUser.id);
    stripSensitiveTelegramLaunchParamsFromLocation();
    void loadSessionReplay();
    // initTelegramSdk 是同步副作用,initData 在它跑完后立即可读;
    // hydrate 把 telegram first_name + localStorage 覆盖合成 displayName
    hydrateUserProfile();
    // 应用持久化的消息字号倍率
    hydrateFontScale();
    setTelegramReady(true);
  }, [hydrateUserProfile, hydrateFontScale]);

  return (
    <QueryClientProvider client={queryClient}>
      {telegramReady ? <PaymentReturnRedirect /> : null}
      {telegramReady ? <GrowthEntryReporter /> : null}
      {telegramReady ? <InviteBindReporter /> : null}
      {telegramReady ? <UserSettingsHydrator /> : null}
      {telegramReady ? children : null}
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
    try {
      if (sessionStorage.getItem(INVITE_BIND_DONE_KEY) === '1') return;

      const startParam = getStartParam();
      if (startParam.startsWith(INVITE_START_PARAM_PREFIX)) {
        const code = startParam.slice(INVITE_START_PARAM_PREFIX.length);
        if (INVITE_CODE_RE.test(code)) {
          sessionStorage.setItem(INVITE_BIND_PENDING_KEY, code);
        }
      }

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
