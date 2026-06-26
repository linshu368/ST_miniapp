'use client';

import { useRef, useEffect, useState } from 'react';
import { useBridgeContext } from './bridge-provider';
import { getRawInitData, INIT_DATA_HEADER } from '@/lib/telegram/auth';

const ST_IFRAME_URL = '/tavern/';

type StSessionResponse = {
  success: boolean;
  data: { st_url: string; st_cookie: string; is_new_user: boolean };
};

export function STIframe() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { registerIframe, isVisible } = useBridgeContext();
  const [sessionReady, setSessionReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function initSession() {
      try {
        const headers: Record<string, string> = {};
        const initData = getRawInitData();
        if (initData) headers[INIT_DATA_HEADER] = initData;

        const res = await fetch('/api/init-st-session', {
          method: 'POST',
          headers,
        });

        if (!res.ok) {
          throw new Error(`init-st-session failed: ${res.status}`);
        }

        const json: StSessionResponse = await res.json();
        if (!json.success || !json.data?.st_cookie) {
          throw new Error('st-session returned no cookie');
        }

        if (cancelled) return;

        writeStCookies(json.data.st_cookie);
        setSessionReady(true);
      } catch (err) {
        console.error('[STIframe] st-session failed:', err);
      }
    }

    initSession();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (sessionReady && iframeRef.current) {
      registerIframe(iframeRef.current);
    }
  }, [registerIframe, sessionReady]);

  if (!sessionReady) return null;

  return (
    <iframe
      ref={iframeRef}
      src={ST_IFRAME_URL}
      className={
        isVisible
          ? 'fixed inset-0 z-10 w-full h-full'
          : 'fixed inset-0 w-0 h-0 opacity-0 pointer-events-none'
      }
      title="SillyTavern"
    />
  );
}

function writeStCookies(cookieHeader: string): void {
  for (const part of cookieHeader.split(';')) {
    const cookie = part.trim();
    if (!cookie || !cookie.includes('=')) continue;
    document.cookie = `${cookie}; Path=/; SameSite=Lax`;
  }
}
