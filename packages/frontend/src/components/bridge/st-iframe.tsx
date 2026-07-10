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
  const loadCountRef = useRef(0); // [iframe-timing] TEMP DEBUG: 区分首次加载与看门狗/超时重载

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
    <>
      <iframe
        ref={iframeRef}
        src={ST_IFRAME_URL}
        // [iframe-timing] TEMP DEBUG: iframe_onload 会被重载覆盖，额外按次打点还原每次 load 时刻
        onLoad={() => {
          loadCountRef.current += 1;
          markTiming('iframe_onload');
          markTiming(`iframe_onload_a${loadCountRef.current}`);
        }}
        // 预热期隐藏方式：必须让 iframe「全尺寸真实渲染」，不能靠缩小/透明来藏。
        // 根因（见 docs/iframe-boot-stall-investigation.md）：iOS/Telegram WebKit 会把「不产生
        // 可见渲染的文档」判为后台文档并降级——节流定时器、挂起网络请求投递，致 ST boot 前段
        // `/csrf-token` 之后的 `/version` 永远发不出去、boot 楔死、握手永不到达，直到超时重载。
        // pro 实测 0×0 与 1×1px+opacity 都仍被判后台（面积太小/不可见）。故隐藏态改为 full-size、
        // full-opacity、视口内的真实图层（WebKit 视为「正在呈现」、不降级），仅用负 z-index 压到
        // 大厅内容之下、再由下方不透明遮罩挡住 —— 用户看不到 ST，也不阻挡大厅交互（pointer-events-none）。
        // 注意：占用可见区域但被上层遮挡 ≠ 不渲染；而 visibility:hidden/display:none/零尺寸/离屏
        // transform 都会被判不可见，等价旧问题，一律不可用。
        className={
          isVisible
            ? 'fixed inset-0 z-10 w-full h-full'
            : 'fixed inset-0 z-[-20] w-full h-full pointer-events-none'
        }
        title="SillyTavern"
      />
      {/* 预热期不透明遮罩：层级夹在 iframe(z-[-20]) 与大厅内容(普通流,z:auto) 之间(z-[-10])，
          全视口 bg-background。大厅任何透明间隙只会露出它（与 body 同色、无缝），永不露出 ST。 */}
      {!isVisible && (
        <div aria-hidden className="fixed inset-0 z-[-10] bg-background pointer-events-none" />
      )}
    </>
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
