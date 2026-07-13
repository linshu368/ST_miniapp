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

async function requestStSession(): Promise<StSessionResponse> {
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

  const json = (await res.json()) as StSessionResponse;
  if (!json.success || !json.data?.st_cookie) {
    throw new Error('st-session returned no cookie');
  }
  return json;
}

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
  const sessionRecoveryRef = useRef(false);
  const sessionRecoveryAttemptsRef = useRef(0);

  useEffect(() => {
    const handleInteractivity = (event: Event) => {
      const detail = (event as CustomEvent<{ interactive?: boolean }>).detail;
      setChatInteractive(detail?.interactive === true);
    };
    window.addEventListener(CHAT_INTERACTIVITY_EVENT, handleInteractivity);
    return () => window.removeEventListener(CHAT_INTERACTIVITY_EVENT, handleInteractivity);
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    const updateViewportSize = () => {
      const height = viewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty(
        '--miniapp-visual-viewport-height',
        `${Math.round(height)}px`
      );
    };

    updateViewportSize();
    viewport?.addEventListener('resize', updateViewportSize);
    viewport?.addEventListener('scroll', updateViewportSize);
    window.addEventListener('resize', updateViewportSize);
    return () => {
      viewport?.removeEventListener('resize', updateViewportSize);
      viewport?.removeEventListener('scroll', updateViewportSize);
      window.removeEventListener('resize', updateViewportSize);
      document.documentElement.style.removeProperty('--miniapp-visual-viewport-height');
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function initSession() {
      try {
        const json = await requestStSession();

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
    <>
      <iframe
        ref={iframeRef}
        src={ST_IFRAME_URL}
        // [iframe-timing] TEMP DEBUG: iframe_onload 会被重载覆盖，额外按次打点还原每次 load 时刻
        onLoad={() => {
          loadCountRef.current += 1;
          markTiming('iframe_onload');
          markTiming(`iframe_onload_a${loadCountRef.current}`);

          // ST 实例重启后，浏览器里仍可能残留旧签名 cookie，/tavern 会被重定向到
          // /login。检测到登录页时主动重新获取 session 并重载 iframe，避免开屏永久等待。
          const iframe = iframeRef.current;
          if (!iframe || sessionRecoveryRef.current) return;
          try {
            if (!iframe.contentWindow?.location.pathname.startsWith('/login')) {
              sessionRecoveryAttemptsRef.current = 0;
              return;
            }
          } catch {
            return;
          }
          if (sessionRecoveryAttemptsRef.current >= 2) return;

          sessionRecoveryRef.current = true;
          sessionRecoveryAttemptsRef.current += 1;
          markTiming('st_session_recovery');
          void requestStSession()
            .then((json) => {
              writeStCookies(json.data.st_cookie);
              iframe.src = ST_IFRAME_URL;
            })
            .catch((err) => {
              console.error('[STIframe] session recovery failed:', err);
            })
            .finally(() => {
              sessionRecoveryRef.current = false;
            });
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
            ? 'fixed left-0 top-0 z-10 h-[var(--miniapp-visual-viewport-height,100dvh)] max-h-[100dvh] w-full'
            : 'fixed left-0 top-0 z-[-20] h-[var(--miniapp-visual-viewport-height,100dvh)] max-h-[100dvh] w-full pointer-events-none'
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
