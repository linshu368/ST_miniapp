'use client';

import {
  ReportFirstTokenRequestSchema,
  type ReportFirstTokenRequest,
  type ReportFirstTokenData,
} from '@miniapp/shared';
import { getRawInitData } from '@/lib/telegram/auth';
import { parseTelegramUser } from '@/lib/telegram/user';
import { apiClient } from './client';

const PREFIX = 'miniapp:first-token-receipts:v1:';
const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PENDING = 20;
const MAX_ATTEMPTS = 4;
type Pending = {
  sessionId: string;
  body: ReportFirstTokenRequest;
  createdAt: number;
  attempts: number;
};
let loadedOwner: string | undefined;
const pending = new Map<string, Pending>();
const inFlight = new Set<string>();
const confirmed = new Set<string>();
let recovering = false;
let lastRecoveryAt = -Infinity;

function owner(): string {
  const id = parseTelegramUser(getRawInitData()).id;
  return Number.isSafeInteger(id) && id! > 0 ? String(id) : '';
}
function key(item: Pending): string {
  return `${item.sessionId}:${item.body.request_id}`;
}
function prune(): void {
  for (const [id, item] of pending) {
    if (Date.now() - item.createdAt >= TTL_MS || item.attempts >= MAX_ATTEMPTS) pending.delete(id);
  }
  while (pending.size > MAX_PENDING) pending.delete(pending.keys().next().value!);
}
function persist(scope: string): void {
  if (scope !== loadedOwner || !scope || typeof localStorage === 'undefined') return;
  try {
    prune();
    if (pending.size) localStorage.setItem(PREFIX + scope, JSON.stringify([...pending.values()]));
    else localStorage.removeItem(PREFIX + scope);
  } catch {
    /* Storage denial must never interrupt chat; retain the bounded in-memory copy. */
  }
}
function load(scope: string): void {
  if (scope === loadedOwner) {
    prune();
    return;
  }
  loadedOwner = scope;
  pending.clear();
  confirmed.clear();
  if (!scope || typeof localStorage === 'undefined') return;
  try {
    const raw = localStorage.getItem(PREFIX + scope);
    if (!raw || raw.length > 32768) return;
    const values: unknown = JSON.parse(raw);
    if (!Array.isArray(values)) return;
    for (const value of values.slice(-MAX_PENDING)) {
      if (!value || typeof value !== 'object') continue;
      const item = value as Partial<Pending>;
      const parsed = ReportFirstTokenRequestSchema.safeParse(item.body);
      if (
        !parsed.success ||
        typeof item.sessionId !== 'string' ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(item.sessionId) ||
        !Number.isFinite(item.createdAt) ||
        item.createdAt! > Date.now() ||
        !Number.isInteger(item.attempts) ||
        item.attempts! < 0 ||
        item.attempts! >= MAX_ATTEMPTS
      )
        continue;
      const valid: Pending = {
        sessionId: item.sessionId,
        body: parsed.data,
        createdAt: item.createdAt!,
        attempts: item.attempts!,
      };
      pending.set(key(valid), valid);
    }
    prune();
  } catch {
    /* A corrupt local receipt is not evidence of delivery. */
  }
}
const online = () => typeof navigator === 'undefined' || navigator.onLine !== false;

async function send(item: Pending, scope: string, recovery: boolean): Promise<boolean> {
  if (!online() || owner() !== scope || item.attempts >= MAX_ATTEMPTS) return false;
  // Count before sending, so a process exit cannot reset the retry allowance.
  item.attempts += 1;
  persist(scope);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const result = await apiClient<ReportFirstTokenData>(
      `/api/v1/conversations/${encodeURIComponent(item.sessionId)}/first-token`,
      {
        method: 'POST',
        body: JSON.stringify(item.body),
        signal: controller.signal,
        keepalive: true,
        ...(recovery ? { queuePriority: 'background' as const } : {}),
      }
    );
    return result.recorded;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function deliver(item: Pending, scope: string, recovery: boolean): Promise<void> {
  const id = key(item);
  const flightKey = scope + ':' + id;
  if (inFlight.has(flightKey)) return;
  inFlight.add(flightKey);
  try {
    // Existing immediate retries, plus at most one remaining attempt after all three fail.
    for (const delay of recovery ? [0] : [0, 300, 1000]) {
      if (owner() !== scope || !pending.has(id) || !online() || item.attempts >= MAX_ATTEMPTS)
        break;
      if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
      if (await send(item, scope, recovery)) {
        if (loadedOwner === scope) {
          pending.delete(id);
          confirmed.add(id);
          while (confirmed.size > 100) confirmed.delete(confirmed.values().next().value!);
          persist(scope);
        }
        return;
      }
    }
  } finally {
    inFlight.delete(flightKey);
    persist(scope);
  }
}

export async function reportConversationFirstToken(
  sessionId: string,
  body: ReportFirstTokenRequest
): Promise<void> {
  const parsed = ReportFirstTokenRequestSchema.safeParse(body);
  if (!parsed.success) return;
  const scope = owner();
  load(scope);
  const id = `${sessionId}:${body.request_id}`;
  if (confirmed.has(id)) return;
  // The first terminal payload is immutable even across navigation or reconnect.
  const item = pending.get(id) ?? {
    sessionId,
    body: { ...body },
    createdAt: Date.now(),
    attempts: 0,
  };
  pending.set(id, item);
  prune();
  persist(scope);
  await deliver(item, scope, false);
}

export async function recoverPendingFirstTokenReports(): Promise<void> {
  if (
    recovering ||
    !online() ||
    Date.now() - lastRecoveryAt < 30000 ||
    (typeof document !== 'undefined' && document.visibilityState !== 'visible')
  )
    return;
  const scope = owner();
  load(scope);
  recovering = true;
  lastRecoveryAt = Date.now();
  try {
    for (const item of [...pending.values()].slice(0, 4)) {
      if (owner() !== scope) break;
      await deliver(item, scope, true);
    }
  } finally {
    persist(scope);
    recovering = false;
  }
}

/** One app-level listener pair; no polling and no conversation-detail lookup. */
export function bindFirstTokenReportRecovery(): () => void {
  const wake = () => {
    void recoverPendingFirstTokenReports();
  };
  window.addEventListener('online', wake);
  document.addEventListener('visibilitychange', wake);
  wake();
  return () => {
    window.removeEventListener('online', wake);
    document.removeEventListener('visibilitychange', wake);
  };
}

export function __resetFirstTokenReportsForTests(): void {
  loadedOwner = undefined;
  pending.clear();
  inFlight.clear();
  confirmed.clear();
  recovering = false;
  lastRecoveryAt = -Infinity;
}
