'use client';

import { createContext, useContext, useRef, useCallback, useMemo, useEffect } from 'react';
import { BridgeClient, setBridgeClient } from '@/lib/bridge';
import type { BridgeClientOptions } from '@/lib/bridge';
import { usePathname } from 'next/navigation';

type BridgeContextValue = {
  client: BridgeClient;
  registerIframe: (el: HTMLIFrameElement) => void;
  isVisible: boolean;
};

const BridgeContext = createContext<BridgeContextValue | null>(null);

export function BridgeProvider({ children }: { children: React.ReactNode }) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const pathname = usePathname();
  const isVisible = pathname.startsWith('/tavern/');

  const client = useMemo(() => {
    const opts: BridgeClientOptions = { totalTimeout: 60_000 };
    return new BridgeClient(() => iframeRef.current, opts);
  }, []);

  useEffect(() => {
    setBridgeClient(client);
    return () => {
      client.stop();
    };
  }, [client]);

  const registerIframe = useCallback(
    (el: HTMLIFrameElement) => {
      iframeRef.current = el;
      client.start();
    },
    [client]
  );

  const value = useMemo(
    () => ({ client, registerIframe, isVisible }),
    [client, registerIframe, isVisible]
  );

  return <BridgeContext.Provider value={value}>{children}</BridgeContext.Provider>;
}

export function useBridgeContext(): BridgeContextValue {
  const ctx = useContext(BridgeContext);
  if (!ctx) throw new Error('useBridgeContext must be used within BridgeProvider');
  return ctx;
}
