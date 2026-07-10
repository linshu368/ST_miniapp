'use client';

import { useRef, useEffect, useState } from 'react';
import { useBridgeContext } from './bridge-provider';
import { getRawInitData, INIT_DATA_HEADER } from '@/lib/telegram/auth';
import { markTiming } from '@/lib/bridge/iframe-timing'; // [iframe-timing] TEMP DEBUG

const ST_IFRAME_URL = '/tavern/';
export const CHAT_INTERACTIVITY_EVENT = 'miniapp:chat-interactivity';

type StSessionResponse = {
  success: boolean;
  data: { st_url: string; st_cookie: string; is_new_user: boolean };
};

function isTextEntryElement(target: EventTarget | null): target is HTMLElement {
  if (!target || typeof target !== 'object' || !('tagName' in target)) return false;
  const element = target as HTMLElement;
  return (
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.isContentEditable === true
  );
}

export function STIframe() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { registerIframe, isVisible } = useBridgeContext();
  const [sessionReady, setSessionReady] = useState(false);
  const [chatInteractive, setChatInteractive] = useState(false);
  const loadCountRef = useRef(0); // [iframe-timing] TEMP DEBUG: 区分首次加载与看门狗/超时重载

  useEffect(() => {
    const handleInteractivity = (event: Event) => {
      const detail = (event as CustomEvent<{ interactive?: boolean }>).detail;
      setChatInteractive(detail?.interactive === true);
    };
    window.addEventListener(CHAT_INTERACTIVITY_EVENT, handleInteractivity);
    return () => window.removeEventListener(CHAT_INTERACTIVITY_EVENT, handleInteractivity);
  }, []);

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

  useEffect(() => {
    if (!sessionReady || chatInteractive) return;
    const iframe = iframeRef.current;
    if (!iframe) return;

    let guardedDocument: Document | null = null;
    let focusHandler: ((event: FocusEvent) => void) | null = null;

    const removeGuard = () => {
      if (guardedDocument && focusHandler) {
        guardedDocument.removeEventListener('focusin', focusHandler, true);
      }
      guardedDocument = null;
      focusHandler = null;
    };

    const installGuard = () => {
      removeGuard();
      try {
        const doc = iframe.contentDocument;
        if (!doc) return;
        guardedDocument = doc;
        focusHandler = (event: FocusEvent) => {
          if (isTextEntryElement(event.target)) {
            event.target.blur();
          }
        };
        doc.addEventListener('focusin', focusHandler, true);

        const active = doc.activeElement;
        if (isTextEntryElement(active)) {
          active.blur();
        }
      } catch {
        // /tavern/ 正常为同源；若部署代理配置异常变成跨域，则安全跳过焦点守卫。
      }
    };

    installGuard();
    iframe.addEventListener('load', installGuard);
    return () => {
      iframe.removeEventListener('load', installGuard);
      removeGuard();
    };
  }, [chatInteractive, sessionReady]);

  if (!sessionReady) return null;

  return (
    <iframe
      ref={iframeRef}
      src={ST_IFRAME_URL}
      // [iframe-timing] TEMP DEBUG: iframe_onload 会被重载覆盖，额外按次打点还原每次 load 时刻
      onLoad={() => {
        loadCountRef.current += 1;
        markTiming('iframe_onload');
        markTiming(`iframe_onload_a${loadCountRef.current}`);
      }}
      // 预热期的隐藏方式：必须保留「非零绘制面积」。
      // 根因（见 docs/iframe-boot-stall-investigation.md）：旧写法 `w-0 h-0 opacity-0` 是 0×0、
      // 零绘制面积，iOS/Telegram WebKit 会把「不产生像素的文档」判为后台文档并降级——节流定时器、
      // 挂起网络请求投递。ST boot 前段 `fetch('/csrf-token')` 发出后，紧接着的 `fetch('/version')`
      // 就因文档被判后台而永远投递不出去（nginx 收不到），boot 楔死、握手永不到达，直到超时重载。
      // 修复：隐藏态改成真实绘制的 1×1px 图层（仍在渲染树 + 参与合成 → WebKit 视为「已渲染」，
      // 不降级），再用极低不透明度 + pointer-events-none + 垫底 z-index 保证用户既看不到也点不到。
      // `visibility:hidden` / `display:none` / 零尺寸都会移出绘制，等价于旧问题，故不可用。
      className={
        isVisible
          ? 'fixed inset-0 z-10 w-full h-full'
          : 'fixed left-0 bottom-0 -z-10 w-px h-px opacity-[0.01] pointer-events-none'
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
