/**
 * VIP 到期提醒的有界执行。
 *
 * 窗口以 Asia/Shanghai 的日历日为准，不读服务器本地时区。真正插入只发生在数据库
 * 锁内：脚本先按上限列出候选人，再逐个调用 insert_due。幂等键由锁定的 valid_until
 * 和提醒类型组成，重跑、并发和超时重试都不会插出第二条。
 */

import { VIP_REMINDERS_ENABLED_CONFIG_KEY } from '@miniapp/shared';

import { getDomainDb } from '../../lib/supabase.js';
import {
  fetchRuntimeConfigEntryStrict,
  type RuntimeConfigEntry,
} from '../../platform/runtime-config.js';

export const VIP_REMINDER_BATCH_LIMIT = 100;
export const VIP_REMINDER_MAX_BATCHES = 20;
export const VIP_REMINDER_DB_TIMEOUT_MS = 8_000;
export const VIP_REMINDER_MAX_ATTEMPTS = 3;

const SHANGHAI_TZ = 'Asia/Shanghai';
const RETRYABLE_SQLSTATES = new Set([
  '57014',
  '55P03',
  '40001',
  '40P01',
  '08006',
  '08001',
  '57P01',
]);

export type VipReminderWindowName = 'expiring_soon' | 'expires_today';
export type VipReminderRunMode = 'dry-run' | 'write';

export interface VipReminderRunSummary {
  scanned: number;
  eligible: number;
  inserted: number;
  skipped: number;
  failed: number;
  dry_run: boolean;
  duration: number;
}

export interface VipReminderLogger {
  info(bindings: Record<string, unknown>, message: string): void;
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export interface VipReminderStore {
  listCandidates(input: { limit: number; afterUserId: string | null }): Promise<string[]>;
  insertDue(userId: string): Promise<unknown>;
}

interface CivilDate {
  year: number;
  month: number;
  day: number;
}

export interface VipReminderArgs {
  mode: VipReminderRunMode;
  limit: number;
}

export function parseVipReminderArgs(argv: readonly string[]): VipReminderArgs {
  let mode: VipReminderRunMode | null = null;
  let limit = VIP_REMINDER_BATCH_LIMIT;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      if (mode === 'write') throw new Error('vip reminder mode is ambiguous');
      mode = 'dry-run';
      continue;
    }
    if (arg === '--write') {
      if (mode === 'dry-run') throw new Error('vip reminder mode is ambiguous');
      mode = 'write';
      continue;
    }
    if (arg === '--limit') {
      const raw = argv[index + 1];
      if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
        throw new Error('vip reminder limit must be an integer 1..100');
      }
      limit = Number(raw);
      if (limit > VIP_REMINDER_BATCH_LIMIT) {
        throw new Error('vip reminder limit must be an integer 1..100');
      }
      index += 1;
      continue;
    }
    throw new Error('vip reminder arguments are invalid');
  }

  return { mode: mode ?? 'dry-run', limit };
}

export function interpretVipRemindersEnabled(entry: { value: unknown } | null): {
  enabled: boolean;
  reason: 'enabled' | 'disabled' | 'missing' | 'invalid';
} {
  if (!entry) return { enabled: false, reason: 'missing' };
  if (entry.value === true) return { enabled: true, reason: 'enabled' };
  if (entry.value === false) return { enabled: false, reason: 'disabled' };
  return { enabled: false, reason: 'invalid' };
}

/** 与数据库 vip_expiry_reminder_window 使用同一套上海日历日规则，供无库回归锁定边界。 */
export function classifyVipExpiryReminderWindow(
  validUntil: Date,
  now: Date
): VipReminderWindowName | null {
  if (Number.isNaN(validUntil.getTime()) || Number.isNaN(now.getTime())) return null;
  const expiry = shanghaiCivilDate(validUntil);
  const today = shanghaiCivilDate(now);
  if (civilDateEqual(expiry, addCivilDays(today, 3))) return 'expiring_soon';
  if (civilDateEqual(expiry, today)) return 'expires_today';
  return null;
}

export function shanghaiUtcOffset(instant: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SHANGHAI_TZ,
    timeZoneName: 'longOffset',
    hour: '2-digit',
  }).formatToParts(instant);
  return parts.find((part) => part.type === 'timeZoneName')?.value ?? '';
}

export async function readVipRemindersConfig(): Promise<RuntimeConfigEntry | null> {
  return fetchRuntimeConfigEntryStrict(VIP_REMINDERS_ENABLED_CONFIG_KEY);
}

interface RpcResult {
  data: unknown;
  error: { message?: string; code?: string } | null;
}

export function createVipReminderStore(): VipReminderStore {
  const db = () => getDomainDb('miniapp_features');
  return {
    async listCandidates(input) {
      const data = await withDeadline(
        db().rpc('list_vip_expiry_reminder_candidates', {
          p_limit: input.limit,
          p_after_user_id: input.afterUserId,
        }) as PromiseLike<RpcResult>,
        VIP_REMINDER_DB_TIMEOUT_MS
      );
      return readCandidateIds(unwrapRpc(data));
    },
    async insertDue(userId) {
      const data = await withDeadline(
        db().rpc('insert_due_vip_expiry_reminder', { p_user_id: userId }) as PromiseLike<RpcResult>,
        VIP_REMINDER_DB_TIMEOUT_MS
      );
      return unwrapRpc(data);
    },
  };
}

export async function runVipExpiryReminders(input: {
  mode: VipReminderRunMode;
  limit: number;
  store: VipReminderStore;
  readConfig: () => Promise<{ value: unknown } | null>;
  log: VipReminderLogger;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<VipReminderRunSummary> {
  const nowMs = input.nowMs ?? Date.now;
  const sleep = input.sleep ?? delay;
  const started = nowMs();
  const summary: VipReminderRunSummary = {
    scanned: 0,
    eligible: 0,
    inserted: 0,
    skipped: 0,
    failed: 0,
    dry_run: input.mode !== 'write',
    duration: 0,
  };

  let writesOpen = false;
  if (input.mode === 'write') {
    try {
      const decision = interpretVipRemindersEnabled(await input.readConfig());
      writesOpen = decision.enabled;
      if (!writesOpen) {
        input.log.warn(
          { event: 'vip.reminder.write_blocked', reason: decision.reason },
          'VIP 到期提醒开关未开启，本次不写入'
        );
      }
    } catch (error) {
      input.log.error(
        { event: 'vip.reminder.config_read_failed', err: error },
        'VIP 到期提醒配置读取失败'
      );
      summary.failed += 1;
      summary.duration = elapsed(started, nowMs);
      return summary;
    }
  }

  let afterUserId: string | null = null;
  for (let batch = 0; batch < VIP_REMINDER_MAX_BATCHES; batch += 1) {
    let candidates: string[];
    try {
      candidates = await withRetry(
        () => input.store.listCandidates({ limit: input.limit, afterUserId }),
        sleep,
        input.log
      );
    } catch (error) {
      input.log.error(
        { event: 'vip.reminder.list_failed', err: error },
        'VIP 到期提醒候选读取失败'
      );
      summary.failed += 1;
      break;
    }

    if (candidates.length === 0) break;
    summary.scanned += candidates.length;
    const cursor = candidates[candidates.length - 1];
    if (!cursor || cursor === afterUserId) {
      summary.failed += 1;
      input.log.error({ event: 'vip.reminder.cursor_stalled' }, 'VIP 到期提醒分页没有前进');
      break;
    }

    for (const userId of candidates) {
      if (!UUID_RE.test(userId)) {
        summary.failed += 1;
        input.log.error({ event: 'vip.reminder.candidate_invalid' }, 'VIP 到期提醒候选人无效');
        continue;
      }
      if (!writesOpen) {
        summary.eligible += 1;
        continue;
      }
      try {
        const result = await withRetry(() => input.store.insertDue(userId), sleep, input.log);
        const status = readStatus(result);
        if (status === 'inserted') {
          summary.inserted += 1;
          summary.eligible += 1;
        } else if (status === 'already_inserted') {
          summary.skipped += 1;
          summary.eligible += 1;
        } else if (
          status === 'skipped_window' ||
          status === 'skipped_missing' ||
          status === 'skipped_stale'
        ) {
          summary.skipped += 1;
        } else {
          summary.failed += 1;
          input.log.error(
            { event: 'vip.reminder.unexpected_status' },
            'VIP 到期提醒返回了未知状态'
          );
        }
      } catch (error) {
        summary.failed += 1;
        input.log.error(
          { event: 'vip.reminder.candidate_failed', err: error },
          'VIP 到期提醒候选人失败'
        );
      }
    }

    afterUserId = cursor;
    if (candidates.length < input.limit) break;
  }

  summary.duration = elapsed(started, nowMs);
  input.log.info({ event: 'vip.reminder.finished', ...summary }, 'VIP 到期提醒批次结束');
  return summary;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function readCandidateIds(data: unknown): string[] {
  if (!Array.isArray(data)) return [];
  return data
    .map((item) => {
      if (typeof item === 'string') return item;
      if (item && typeof item === 'object' && 'user_id' in item) {
        const value = item.user_id;
        return typeof value === 'string' ? value : '';
      }
      return '';
    })
    .filter((id) => id.length > 0);
}

export function isRetryableReminderError(error: unknown): boolean {
  const code = readErrorCode(error);
  if (code && RETRYABLE_SQLSTATES.has(code)) return true;
  if (error instanceof Error && error.name === 'TimeoutError') return true;
  const message = error instanceof Error ? error.message : '';
  return /timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message);
}

async function withRetry<T>(
  work: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
  log: VipReminderLogger
): Promise<T> {
  let delayMs = 200;
  for (let attempt = 1; attempt <= VIP_REMINDER_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (!isRetryableReminderError(error) || attempt === VIP_REMINDER_MAX_ATTEMPTS) throw error;
      log.warn(
        { event: 'vip.reminder.retry', attempt, code: readErrorCode(error) },
        'VIP 到期提醒将重试幂等调用'
      );
      await sleep(delayMs);
      delayMs *= 4;
    }
  }
  throw new Error('vip reminder retry exhausted');
}

async function withDeadline<T>(work: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error('vip reminder database call timed out');
      error.name = 'TimeoutError';
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function unwrapRpc(result: RpcResult): unknown {
  if (result.error) throw result.error;
  return result.data;
}

function readStatus(result: unknown): string | null {
  const record = asRecord(result);
  const status = record?.status;
  return typeof status === 'string' ? status : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown);
    } catch {
      return null;
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function readErrorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  const code = error.code;
  return typeof code === 'string' ? code : null;
}

function elapsed(started: number, nowMs: () => number): number {
  return Math.max(0, nowMs() - started);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function shanghaiCivilDate(instant: Date): CivilDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SHANGHAI_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: read('year'), month: read('month'), day: read('day') };
}

function addCivilDays(date: CivilDate, days: number): CivilDate {
  const shifted = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function civilDateEqual(left: CivilDate, right: CivilDate): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}
