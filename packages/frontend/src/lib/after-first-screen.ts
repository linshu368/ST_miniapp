'use client';

import { useEffect, useState } from 'react';

/** load 后等空闲帧的上限；弱机上 idle 可能迟迟不来，不能让角标和遥测无限推迟。 */
const IDLE_TIMEOUT_MS = 2_000;
/** 首屏图片很慢时 load 事件会被拖住，到点无条件放行。 */
const MAX_WAIT_MS = 4_000;

let firstScreenDone = false;
let firstScreenPromise: Promise<void> | undefined;

/**
 * 整个页面生命周期只结算一次的「首屏结束」信号：load 之后的第一个空闲帧，最迟 4s。
 * 之后的 SPA 导航立即放行，所以只有冷启动那一屏会让非首屏请求和遥测让路。
 */
export function afterFirstScreen(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  firstScreenPromise ??= new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      firstScreenDone = true;
      window.clearTimeout(hardCap);
      window.removeEventListener('load', onLoad);
      resolve();
    };
    const onLoad = () => {
      if (typeof window.requestIdleCallback === 'function') {
        window.requestIdleCallback(finish, { timeout: IDLE_TIMEOUT_MS });
      } else {
        window.setTimeout(finish, 0);
      }
    };
    const hardCap = window.setTimeout(finish, MAX_WAIT_MS);
    if (document.readyState === 'complete') onLoad();
    else window.addEventListener('load', onLoad, { once: true });
  });
  return firstScreenPromise;
}

/** 给 React Query 的 `enabled` 用；首屏结束前返回 false。 */
export function useAfterFirstScreen(): boolean {
  const [done, setDone] = useState(firstScreenDone);
  useEffect(() => {
    if (done) return;
    let active = true;
    void afterFirstScreen().then(() => {
      if (active) setDone(true);
    });
    return () => {
      active = false;
    };
  }, [done]);
  return done;
}
