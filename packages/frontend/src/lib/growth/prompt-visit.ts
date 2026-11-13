'use client';

import { useSyncExternalStore } from 'react';

/**
 * 本次打开内的增长弹窗状态（不落盘）：
 * - rounds：本次打开新完成的轮数，补上服务端 total_rounds 之后的增量；
 * - slotTaken：本次打开是否已经弹过一个（进群 / VIP / 新人创作邀请共用一个位）。
 */
let rounds = 0;
let slotTaken = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((listener) => listener());

export function noteCompletedRound(): void {
  rounds += 1;
  emit();
}

/** 抢占本次打开唯一的弹窗位；已被占用返回 false。 */
export function claimPromptSlot(): boolean {
  if (slotTaken) return false;
  slotTaken = true;
  emit();
  return true;
}

export function isPromptSlotTaken(): boolean {
  return slotTaken;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRoundsThisVisit(): number {
  return useSyncExternalStore(
    subscribe,
    () => rounds,
    () => 0
  );
}

export function usePromptSlotTaken(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => slotTaken,
    () => false
  );
}
