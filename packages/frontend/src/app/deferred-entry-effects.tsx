'use client';

import { useEffect } from 'react';
import { afterEntryBackground } from '@/lib/entry-phase';
import { recordMiniappEntry } from '@/lib/api/growth';
import { bindInvite } from '@/lib/api/invite';
import { getRawInitData } from '@/lib/telegram/auth';
import { INVITE_BIND_PENDING_KEY } from '@/lib/telegram/launch-url';

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
    void afterEntryBackground()
      .then(async () => {
        const raw = getRawInitData();
        if (!raw || cancelled) return;
        // A digest isolates sessions and accounts without persisting initData itself.
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
        const key = `growth_entry_ack:${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')}`;
        for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
          try {
            if (sessionStorage.getItem(key) === '1') return;
          } catch {
            /* Storage is optional; server deduplication is authoritative. */
          }
          try {
            const result = await recordMiniappEntry();
            if (result.recorded) {
              try {
                sessionStorage.setItem(key, '1');
              } catch {
                /* optional */
              }
              return;
            }
          } catch {
            /* Attribution failure must not block the product. */
          }
          if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        }
      })
      .catch(() => {
        /* Optional background reporting. */
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
