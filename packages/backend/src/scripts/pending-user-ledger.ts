/**
 * backend / scripts / pending-user-ledger.ts
 *
 * 测试用户的「待清理」落盘登记表。回归与 UAT 两套夹具共用。
 *
 * 解决的问题：脚本被硬杀时，进程内记着的 user id 全丢了，下次开跑要能认领上一轮的残留。
 *
 * 认领**必须是精确匹配**。历史上试过按 tg_id 号段扫（`like('tg_id', '89________')`），
 * 那等于对一整个十亿号段行使删除权——真实 Telegram id 是单调递增的外部序列，本库里
 * 已经出现 8_866_xxx_xxx 量级的真实账号，迟早涨进任何预留段，届时会连人带钱包流水
 * 一起删掉。所以号段只决定「往哪写」，绝不能反过来当「这段里的都是测试数据」。
 *
 * 用法纪律：**建号请求发出之前**同步调用 `record()`。异步写在硬杀时会丢，
 * 那正是这张表要覆盖的场景。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export interface PendingUserLedger {
  /** 同步落盘。必须在建号请求发出前调用。 */
  record(tgId: string): void;
  read(): string[];
  /** 对应 tg_id 已确认清理干净，从登记表划掉。 */
  clear(tgIds: string[]): void;
}

export function createPendingUserLedger(ledgerPath: string): PendingUserLedger {
  function read(): string[] {
    if (!existsSync(ledgerPath)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(ledgerPath, 'utf8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.filter((item): item is string => typeof item === 'string');
    } catch {
      // 登记表损坏时宁可少清一次，也不要让脚本起不来。
      return [];
    }
  }

  function write(tgIds: string[]): void {
    writeFileSync(ledgerPath, `${JSON.stringify(tgIds)}\n`, 'utf8');
  }

  return {
    read,
    record(tgId) {
      const pending = read();
      if (pending.includes(tgId)) return;
      write([...pending, tgId]);
    },
    clear(tgIds) {
      if (tgIds.length === 0) return;
      const done = new Set(tgIds);
      write(read().filter((tgId) => !done.has(tgId)));
    },
  };
}
