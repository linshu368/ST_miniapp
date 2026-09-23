import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import {
  VIP_REMINDER_MAX_ATTEMPTS,
  classifyVipExpiryReminderWindow,
  interpretVipRemindersEnabled,
  isRetryableReminderError,
  parseVipReminderArgs,
  readCandidateIds,
  runVipExpiryReminders,
  shanghaiUtcOffset,
  type VipReminderLogger,
  type VipReminderStore,
} from './vip-expiry-reminder.js';

const USER_A = '00000000-0000-4000-8000-0000000000a1';
const USER_B = '00000000-0000-4000-8000-0000000000b2';

function logger(): VipReminderLogger & { events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  const push = (level: string, bindings: Record<string, unknown>) => {
    events.push({ level, ...bindings });
  };
  return {
    events,
    info: (bindings) => push('info', bindings),
    warn: (bindings) => push('warn', bindings),
    error: (bindings) => push('error', bindings),
  };
}

function store(overrides: Partial<VipReminderStore> = {}): VipReminderStore & {
  list: ReturnType<typeof vi.fn>;
  insert: ReturnType<typeof vi.fn>;
} {
  const list = vi.fn(async () => [USER_A]);
  const insert = vi.fn(async () => ({ status: 'inserted' }));
  return {
    list,
    insert,
    listCandidates: overrides.listCandidates ?? list,
    insertDue: overrides.insertDue ?? insert,
  };
}

describe('vip expiry reminder windows', () => {
  it('uses the Shanghai calendar date across the UTC boundary', () => {
    const now = new Date('2026-09-23T15:30:00.000Z');
    const sameUtcDay = new Date('2026-09-23T16:30:00.000Z');
    expect(classifyVipExpiryReminderWindow(sameUtcDay, now)).toBeNull();
    expect(
      classifyVipExpiryReminderWindow(
        new Date('2026-09-24T02:00:00.000Z'),
        new Date('2026-09-23T16:30:00.000Z')
      )
    ).toBe('expires_today');
    expect(
      classifyVipExpiryReminderWindow(
        new Date('2026-09-27T02:00:00.000Z'),
        new Date('2026-09-23T16:30:00.000Z')
      )
    ).toBe('expiring_soon');
  });

  it('does not send at two or four days, or after expiry', () => {
    const now = new Date('2026-09-23T16:30:00.000Z');
    expect(classifyVipExpiryReminderWindow(new Date('2026-09-26T02:00:00.000Z'), now)).toBeNull();
    expect(classifyVipExpiryReminderWindow(new Date('2026-09-28T02:00:00.000Z'), now)).toBeNull();
    expect(classifyVipExpiryReminderWindow(new Date('2026-09-23T02:00:00.000Z'), now)).toBeNull();
  });

  it('handles leap day, month end and year end', () => {
    expect(
      classifyVipExpiryReminderWindow(
        new Date('2028-02-29T04:00:00.000Z'),
        new Date('2028-02-25T16:00:00.000Z')
      )
    ).toBe('expiring_soon');
    expect(
      classifyVipExpiryReminderWindow(
        new Date('2028-02-29T04:00:00.000Z'),
        new Date('2028-02-26T16:00:00.000Z')
      )
    ).toBeNull();
    expect(
      classifyVipExpiryReminderWindow(
        new Date('2026-02-01T02:00:00.000Z'),
        new Date('2026-01-28T16:00:00.000Z')
      )
    ).toBe('expiring_soon');
    expect(
      classifyVipExpiryReminderWindow(
        new Date('2026-01-31T02:00:00.000Z'),
        new Date('2026-01-28T16:00:00.000Z')
      )
    ).toBeNull();
    expect(
      classifyVipExpiryReminderWindow(
        new Date('2027-01-01T02:00:00.000Z'),
        new Date('2026-12-28T16:00:00.000Z')
      )
    ).toBe('expiring_soon');
    expect(
      classifyVipExpiryReminderWindow(
        new Date('2026-12-31T02:00:00.000Z'),
        new Date('2026-12-28T16:00:00.000Z')
      )
    ).toBeNull();
  });

  it('keeps the Shanghai offset in winter and summer', () => {
    const winter = shanghaiUtcOffset(new Date('2026-01-15T00:00:00.000Z'));
    const summer = shanghaiUtcOffset(new Date('2026-07-15T00:00:00.000Z'));
    expect(winter).toBe(summer);
    expect(winter).toMatch(/8/);
    expect(winter).not.toMatch(/\+7|\+9/);
  });
});

describe('vip expiry reminder runner', () => {
  it('defaults to dry-run and refuses an ambiguous mode', () => {
    expect(parseVipReminderArgs([])).toEqual({ mode: 'dry-run', limit: 100 });
    expect(parseVipReminderArgs(['--dry-run', '--limit', '2'])).toEqual({
      mode: 'dry-run',
      limit: 2,
    });
    expect(() => parseVipReminderArgs(['--write', '--dry-run'])).toThrow(/ambiguous/);
    expect(() => parseVipReminderArgs(['--limit', '101'])).toThrow(/1\.\.100/);
    expect(() => parseVipReminderArgs(['--write-now'])).toThrow(/invalid/);
  });

  it('fails closed unless the switch is exactly true', () => {
    expect(interpretVipRemindersEnabled(null)).toEqual({ enabled: false, reason: 'missing' });
    expect(interpretVipRemindersEnabled({ value: false })).toEqual({
      enabled: false,
      reason: 'disabled',
    });
    expect(interpretVipRemindersEnabled({ value: 1 })).toEqual({
      enabled: false,
      reason: 'invalid',
    });
    expect(interpretVipRemindersEnabled({ value: 'true' })).toEqual({
      enabled: false,
      reason: 'invalid',
    });
    expect(interpretVipRemindersEnabled({ value: true })).toEqual({
      enabled: true,
      reason: 'enabled',
    });
  });

  it('counts a dry-run without writing or reading the switch', async () => {
    const reminders = store();
    const readConfig = vi.fn();
    const summary = await runVipExpiryReminders({
      mode: 'dry-run',
      limit: 10,
      store: reminders,
      readConfig,
      log: logger(),
      nowMs: () => 1_000,
    });
    expect(summary).toMatchObject({
      scanned: 1,
      eligible: 1,
      inserted: 0,
      skipped: 0,
      failed: 0,
      dry_run: true,
      duration: 0,
    });
    expect(reminders.insert).not.toHaveBeenCalled();
    expect(readConfig).not.toHaveBeenCalled();
  });

  it('does not write when the switch is off, missing, invalid, or unreadable', async () => {
    for (const config of [null, { value: false }, { value: 'yes' }]) {
      const reminders = store();
      const summary = await runVipExpiryReminders({
        mode: 'write',
        limit: 10,
        store: reminders,
        readConfig: async () => config,
        log: logger(),
        nowMs: () => 0,
      });
      expect(summary.inserted).toBe(0);
      expect(summary.dry_run).toBe(false);
      expect(reminders.insert).not.toHaveBeenCalled();
    }

    const reminders = store();
    const log = logger();
    const summary = await runVipExpiryReminders({
      mode: 'write',
      limit: 10,
      store: reminders,
      readConfig: async () => {
        throw new Error('config down');
      },
      log,
      nowMs: () => 0,
    });
    expect(summary).toMatchObject({ scanned: 0, inserted: 0, failed: 1, dry_run: false });
    expect(reminders.list).not.toHaveBeenCalled();
    expect(reminders.insert).not.toHaveBeenCalled();
    expect(JSON.stringify(log.events)).not.toContain(USER_A);
    expect(
      log.events.some((event) => event.event === 'vip.reminder.config_read_failed' && event.err)
    ).toBe(true);
  });

  it('writes only when the switch is on and treats a repeat as a skip', async () => {
    const reminders = store({
      insertDue: vi
        .fn()
        .mockResolvedValueOnce({ status: 'inserted' })
        .mockResolvedValueOnce({ status: 'already_inserted' }),
    });
    const log = logger();
    const summary = await runVipExpiryReminders({
      mode: 'write',
      limit: 10,
      store: {
        listCandidates: async () => [USER_A, USER_B],
        insertDue: reminders.insertDue,
      },
      readConfig: async () => ({ value: true }),
      log,
      nowMs: () => 5,
    });
    expect(summary).toMatchObject({
      scanned: 2,
      eligible: 2,
      inserted: 1,
      skipped: 1,
      failed: 0,
      dry_run: false,
    });
    expect(JSON.stringify(log.events)).not.toContain(USER_A);
    expect(JSON.stringify(log.events)).not.toContain('即将到期');
  });

  it('retries a timeout and continues after one candidate fails', async () => {
    const insert = vi
      .fn()
      .mockRejectedValueOnce({
        code: '57014',
        message: 'canceling statement due to statement timeout',
      })
      .mockResolvedValueOnce({ status: 'inserted' })
      .mockRejectedValueOnce(
        Object.assign(new Error('invalid vip reminder input'), { code: '22023' })
      );
    const sleeps: number[] = [];
    const summary = await runVipExpiryReminders({
      mode: 'write',
      limit: 10,
      store: {
        listCandidates: async () => [USER_A, USER_B],
        insertDue: insert,
      },
      readConfig: async () => ({ value: true }),
      log: logger(),
      nowMs: () => 0,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(insert).toHaveBeenCalledTimes(1 + VIP_REMINDER_MAX_ATTEMPTS - 2 + 1);
    expect(sleeps).toEqual([200]);
    expect(summary).toMatchObject({ inserted: 1, failed: 1, scanned: 2 });
    expect(isRetryableReminderError({ code: '57014' })).toBe(true);
    expect(isRetryableReminderError(Object.assign(new Error('bad'), { code: '22023' }))).toBe(
      false
    );
  });

  it('reads candidate ids without accepting a timestamp key from the client', () => {
    expect(readCandidateIds([USER_A, { user_id: USER_B }, { user_id: 1 }, null])).toEqual([
      USER_A,
      USER_B,
    ]);
  });
});

describe('railway vip reminder cron', () => {
  it('configures only the non-production dry-run cron', () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../../../.railway/railway.ts'),
      'utf8'
    );
    const gateAt = source.indexOf('if (!production)');
    const cronAt = source.indexOf('stminiapp-vip-reminder-cron');
    expect(gateAt).toBeGreaterThan(-1);
    expect(cronAt).toBeGreaterThan(gateAt);
    expect(source.slice(0, gateAt)).not.toContain('stminiapp-vip-reminder-cron');
    expect(source).toContain('tsx src/scripts/send-vip-expiry-reminders.ts --dry-run');
    expect(source).not.toContain('--write');
    expect(source).toContain("cronSchedule: '20 * * * *'");
  });
});
