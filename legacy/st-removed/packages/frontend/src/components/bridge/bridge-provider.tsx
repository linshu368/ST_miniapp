'use client';

import { createContext, useContext, useRef, useCallback, useMemo, useEffect } from 'react';
import { BridgeClient, setBridgeClient, getBridgeClientOrNull } from '@/lib/bridge';
import type { BridgeClientOptions } from '@/lib/bridge';
import { usePathname } from 'next/navigation';
import { useSTMirrorStore } from '@/stores/st-mirror';

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

  // StrictMode(dev) 会双调用 useMemo 工厂，若在工厂内 setBridgeClient 会产生两个实例
  // 都写入模块单例，导致 hooks 观察到的实例与被 start() 的实例错配（bridgeStatus 永停 idle）。
  // 工厂只负责构造；注册放到渲染体内（幂等，且早于子组件 effect 调 getBridgeClient），
  // 且永远只注册 React 保留的这个 client 实例。
  const client = useMemo(
    () =>
      new BridgeClient(() => iframeRef.current, { totalTimeout: 60_000 } as BridgeClientOptions),
    []
  );

  if (getBridgeClientOrNull() !== client) {
    setBridgeClient(client);
  }

  useEffect(() => {
    return () => {
      client.stop();
    };
  }, [client]);

  // 把 bridge 的 ST 镜像状态（pong）同步进 mirror store，
  // 供 useSTMirror 消费（模型档位高亮 / 历史当前对话高亮）。
  useEffect(() => {
    const unsub = client.onPong((state) => {
      useSTMirrorStore.getState().updatePartial(state);
    });
    return unsub;
  }, [client]);

  // 点卡即检（安全网 #5）：进入 /tavern/ 时 iframe 转可见，通知 client——
  // 若此刻仍未握手（很可能撞上隐藏预热期停摆），走比 30s 看门狗更早的重载（可见态重载才有效）。
  useEffect(() => {
    if (isVisible) client.onActivated();
  }, [client, isVisible]);

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
