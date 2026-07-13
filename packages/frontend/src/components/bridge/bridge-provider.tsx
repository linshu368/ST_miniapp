'use client';

import {
  createContext,
  useContext,
  useRef,
  useCallback,
  useMemo,
  useEffect,
  useState,
} from 'react';
import { setBridgeClient } from '@/lib/bridge/singleton';
import type { BridgeClient, BridgeClientOptions } from '@/lib/bridge/bridge-client';
import { markTiming } from '@/lib/bridge/iframe-timing';
import { isIOSLikeDevice } from '@/lib/platform';
import { usePathname } from 'next/navigation';
import { useSTMirrorStore } from '@/stores/st-mirror';

const FOREGROUND_BOOT_ENABLED = process.env.NEXT_PUBLIC_FOREGROUND_BOOT === '1';
const FOREGROUND_BOOT_TIMEOUT_MS = 25_000;

type BridgeContextValue = {
  registerIframe: (el: HTMLIFrameElement) => void;
  isVisible: boolean;
  isForegroundBoot: boolean;
};

const BridgeContext = createContext<BridgeContextValue | null>(null);

export function BridgeProvider({
  children,
  active,
}: {
  children: React.ReactNode;
  active: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const clientRef = useRef<BridgeClient | null>(null);
  const clientPromiseRef = useRef<Promise<BridgeClient> | null>(null);
  const mirrorUnsubscribeRef = useRef<(() => void) | null>(null);
  const statusUnsubscribeRef = useRef<(() => void) | null>(null);
  const foregroundBootRef = useRef(false);
  const [foregroundBoot, setForegroundBoot] = useState(false);
  const [iframeRegistered, setIframeRegistered] = useState(false);
  const pathname = usePathname();
  const routeVisible = pathname.startsWith('/tavern/');
  const isVisible = routeVisible || foregroundBoot;

  useEffect(() => {
    if (!active || !FOREGROUND_BOOT_ENABLED || !isIOSLikeDevice()) return;
    markTiming('foreground_boot_start');
    foregroundBootRef.current = true;
    setForegroundBoot(true);
  }, [active]);

  useEffect(() => {
    if (!foregroundBoot) return;
    const timer = window.setTimeout(() => {
      markTiming('foreground_boot_timeout');
      foregroundBootRef.current = false;
      setForegroundBoot(false);
    }, FOREGROUND_BOOT_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [foregroundBoot]);

  const ensureClient = useCallback((): Promise<BridgeClient> => {
    if (clientRef.current) return Promise.resolve(clientRef.current);
    if (clientPromiseRef.current) return clientPromiseRef.current;

    clientPromiseRef.current = import('@/lib/bridge/bridge-client').then(({ BridgeClient }) => {
      const client = new BridgeClient(() => iframeRef.current, {
        totalTimeout: 60_000,
        reconnectTotalTimeout: 60_000,
        readyPhaseTimeout: 20_000,
        iframeLoadTimeout: 20_000,
        handshakeArrivalTimeout: 20_000,
        visibleStallReloadMs: 12_000,
      } as BridgeClientOptions);
      clientRef.current = client;
      setBridgeClient(client);
      statusUnsubscribeRef.current = client.onStatusChange((status) => {
        if ((status === 'interactive' || status === 'ready') && foregroundBootRef.current) {
          markTiming('foreground_boot_end');
          foregroundBootRef.current = false;
          setForegroundBoot(false);
        }
      });
      mirrorUnsubscribeRef.current = client.onPong((state) => {
        useSTMirrorStore.getState().updatePartial(state);
      });
      if (iframeRef.current) client.start();
      return client;
    });
    return clientPromiseRef.current;
  }, []);

  useEffect(() => {
    if (active) void ensureClient();
  }, [active, ensureClient]);

  useEffect(() => {
    return () => {
      statusUnsubscribeRef.current?.();
      mirrorUnsubscribeRef.current?.();
      clientRef.current?.stop();
    };
  }, []);

  // 点卡即检（安全网 #5）：进入 /tavern/ 时 iframe 转可见，通知 client——
  // 若此刻仍未握手（很可能撞上隐藏预热期停摆），走比 30s 看门狗更早的重载（可见态重载才有效）。
  useEffect(() => {
    if (isVisible && active) void ensureClient().then((client) => client.onActivated());
  }, [active, ensureClient, isVisible]);

  const registerIframe = useCallback(
    (el: HTMLIFrameElement) => {
      iframeRef.current = el;
      setIframeRegistered(true);
      if (active) void ensureClient().then((client) => client.start());
    },
    [active, ensureClient]
  );

  const value = useMemo(
    () => ({ registerIframe, isVisible, isForegroundBoot: foregroundBoot }),
    [foregroundBoot, isVisible, registerIframe]
  );

  return (
    <BridgeContext.Provider value={value}>
      {children}
      {foregroundBoot && !iframeRegistered ? (
        <div
          className="fixed inset-0 z-[80] flex items-center justify-center bg-[#090611] text-white"
          aria-live="polite"
          aria-busy="true"
        >
          <div className="flex flex-col items-center gap-4">
            <div className="flex size-16 items-center justify-center rounded-2xl bg-white/10 text-2xl font-semibold shadow-[0_0_48px_rgba(139,92,246,0.28)]">
              蜜
            </div>
            <p className="text-sm font-medium tracking-[0.18em] text-white/80">正在准备聊天</p>
          </div>
        </div>
      ) : null}
    </BridgeContext.Provider>
  );
}

export function useBridgeContext(): BridgeContextValue {
  const ctx = useContext(BridgeContext);
  if (!ctx) throw new Error('useBridgeContext must be used within BridgeProvider');
  return ctx;
}
