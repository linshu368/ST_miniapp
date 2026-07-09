'use client';

import { useRef, useEffect, useState } from 'react';
import { useBridgeContext } from './bridge-provider';
import { getRawInitData, INIT_DATA_HEADER } from '@/lib/telegram/auth';
import { markTiming } from '@/lib/bridge/iframe-timing'; // [iframe-timing] TEMP DEBUG

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
      onLoad={() => markTiming('iframe_onload')} // [iframe-timing] TEMP DEBUG
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
  // Telegram Mini App 运行在受限/被分区（partitioned）的 WebView / 三方 iframe 上下文
  // （尤其 Telegram Web 把小程序套在 web.telegram.org 的 iframe 里）。此时 SameSite=Lax
  // 的 cookie 会被当作三方 cookie 拦截/隔离，导致 ST iframe(/tavern/) 请求不带 connect.sid
  // → ST 302 到 /login，对话页空白。改用 SameSite=None; Secure 让 cookie 在嵌入上下文也能
  // 携带；Partitioned(CHIPS) 兼容"三方 cookie 分区"的浏览器（不支持该属性的会忽略，
  // 退化为 SameSite=None; Secure，同源请求照常携带，无回归风险）。
  for (const part of cookieHeader.split(';')) {
    const cookie = part.trim();
    if (!cookie || !cookie.includes('=')) continue;
    document.cookie = `${cookie}; Path=/; SameSite=None; Secure; Partitioned`;
  }
}
