import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPendingUserLedger } from './pending-user-ledger.js';

// 收尾只删自己写的那一个文件，不做递归删除：测试里的 rm -r 一旦路径算错，
// 代价是删掉工作区里没被 git 跟踪的东西，救不回来。空目录留给系统清理 /tmp。

/**
 * 这张登记表是**唯一**能认领上一轮残留测试用户的依据
 * （号段推断已被明确禁止，见模块头注释），所以它的读写必须扛得住崩溃与脏文件。
 */
describe('createPendingUserLedger', () => {
  let path: string;

  beforeEach(() => {
    path = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'pending.json');
  });

  afterEach(() => {
    rmSync(path, { force: true });
  });

  it('文件不存在时读成空表，而不是抛错', () => {
    expect(createPendingUserLedger(path).read()).toEqual([]);
  });

  it('record 立即落盘，新实例能读到（模拟进程被杀后重开）', () => {
    createPendingUserLedger(path).record('8900000001');
    expect(createPendingUserLedger(path).read()).toEqual(['8900000001']);
  });

  it('record 幂等，重复登记不会写进两条', () => {
    const ledger = createPendingUserLedger(path);
    ledger.record('8900000001');
    ledger.record('8900000001');
    expect(ledger.read()).toEqual(['8900000001']);
  });

  it('clear 只划掉指定的 tg_id，其余留着等下一轮', () => {
    const ledger = createPendingUserLedger(path);
    ledger.record('1');
    ledger.record('2');
    ledger.record('3');
    ledger.clear(['1', '3']);
    expect(ledger.read()).toEqual(['2']);
  });

  it('clear 空数组是 no-op', () => {
    const ledger = createPendingUserLedger(path);
    ledger.record('1');
    ledger.clear([]);
    expect(ledger.read()).toEqual(['1']);
  });

  it('登记表损坏时读成空表：宁可少清一次，也不要让脚本起不来', () => {
    writeFileSync(path, '{ not json', 'utf8');
    expect(createPendingUserLedger(path).read()).toEqual([]);
  });

  it('内容不是数组、或混入非字符串时只保留字符串项', () => {
    writeFileSync(path, '{"a":1}', 'utf8');
    expect(createPendingUserLedger(path).read()).toEqual([]);

    writeFileSync(path, '["1", 2, null, "3"]', 'utf8');
    expect(createPendingUserLedger(path).read()).toEqual(['1', '3']);
  });
});
