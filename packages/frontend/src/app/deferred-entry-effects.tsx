'use client';

import { useEffect } from 'react';
import { INVITE_START_PARAM_PREFIX } from '@miniapp/shared';
import { afterEntryBackground } from '@/lib/entry-phase';
import { recordMiniappEntry } from '@/lib/api/growth';
import { bindInvite } from '@/lib/api/invite';
import { getRawInitData } from '@/lib/telegram/auth';
import { INVITE_BIND_PENDING_KEY, PAYMENT_RETURN_PREFIX } from '@/lib/telegram/launch-url';

const INVITE_BIND_DONE_KEY = 'invite_bind_done';

/** Only attribution IO moves here; launch context is already retained by Providers. */
export function DeferredEntryEffects({ startParam }: { startParam: string }) {
  return (
    <>
      <GrowthEntryReporter startParam={startParam} />
      <InviteBindReporter />
    </>
  );
}

function GrowthEntryReporter({ startParam }: { startParam: string }) {
  useEffect(() => {
    let cancelled = false;
    void afterEntryBackground().then(() => {
      if (cancelled) return;
      try {
        const rawInitData = getRawInitData();
        console.log('[Growth] Telegram initData status:', { available: Boolean(rawInitData) });

        // 即使没有 rawInitData，也可以尝试从 URL 中获取 startapp 参数 (本地开发环境)
        const sourceId = startParam;
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
  }, [startParam]);

  return null;
}

function InviteBindReporter() {
  useEffect(() => {
    let cancelled = false;
    void afterEntryBackground().then(() => {
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
