'use client';

let activeBootSessionId: string | undefined;

export function createBootSessionId(): string {
  const value =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  activeBootSessionId = `boot_${value}`;
  return activeBootSessionId;
}

export function getActiveBootSessionId(): string | undefined {
  return activeBootSessionId;
}
