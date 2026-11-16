import { describe, expect, it } from 'vitest';
import { GIVE_UP_MS, planSurplusCosts, type PendingSurplusCall } from './call-cost-plan.js';
import { parseSurplusUsageCsv, type SurplusUsageRow } from './surplus-usage-export.js';

const T0 = Date.parse('2026-11-16T06:00:00Z');
const NOW = T0 + 30 * 60 * 1000;

function bill(
  requestId: string,
  model: string,
  secondsAfterT0: number,
  cost: string,
  inputTokens = 30_000
): SurplusUsageRow {
  return {
    requestId,
    createdAt: T0 + secondsAfterT0 * 1000,
    model,
    inputTokens,
    outputTokens: 3,
    costUsd: cost,
  };
}

function call(id: string, model: string, secondsAfterT0: number, requestId: string | null) {
  return {
    id,
    providerModel: model,
    dispatchedAt: T0 + secondsAfterT0 * 1000,
    requestId,
  } satisfies PendingSurplusCall;
}

describe('planSurplusCosts', () => {
  it('prices calls by request id, and calls cancelled before headers by model and settle time', () => {
    const decisions = planSurplusCosts({
      pending: [
        call('winner', 'deepseek-v4-pro', 0, 'req-win'),
        call('early-cancel', 'deepseek-v4-pro', 10, null),
        call('gemini-cancel', 'gemini-3.8-flash', 12, null),
      ],
      usage: [
        bill('req-win', 'deepseek-v4-pro', 40, '0.001500'),
        // 别的模型、拨测（输入很少）、已归属别处的账单都不能配给它
        bill('req-other-model', 'gemini-3.8-flash', 20, '0.000100'),
        bill('req-probe', 'deepseek-v4-pro', 15, '0.000001', 18),
        bill('req-known', 'deepseek-v4-pro', 16, '0.002000'),
        bill('req-cancelled', 'deepseek-v4-pro', 21, '0.003264'),
      ],
      knownRequestIds: new Set(['req-win', 'req-known']),
      now: NOW,
    });
    expect(decisions).toEqual([
      expect.objectContaining({ id: 'winner', source: 'surplus_bill', costUsd: '0.001500' }),
      expect.objectContaining({
        id: 'early-cancel',
        source: 'surplus_bill_matched',
        requestId: 'req-cancelled',
        costUsd: '0.003264',
      }),
      expect.objectContaining({
        id: 'gemini-cancel',
        source: 'surplus_bill_matched',
        requestId: 'req-other-model',
      }),
    ]);
  });

  it('gives each bill row to one call only, earliest call first', () => {
    const decisions = planSurplusCosts({
      pending: [call('b', 'm', 30, null), call('a', 'm', 0, null)],
      usage: [bill('r2', 'm', 45, '0.2'), bill('r1', 'm', 12, '0.1')],
      knownRequestIds: new Set(),
      now: NOW,
    });
    expect(decisions.map((item) => [item.id, 'requestId' in item && item.requestId])).toEqual([
      ['a', 'r1'],
      ['b', 'r2'],
    ]);
  });

  it('waits for the bill, then gives up and counts the call as unpriced', () => {
    const pending = [call('recent', 'm', 29 * 60 - 60, null), call('missing', 'm', 0, 'req-x')];
    const waiting = planSurplusCosts({ pending, usage: [], knownRequestIds: new Set(), now: NOW });
    // 刚发出的还不核算；有请求号但账单里还没有的继续等
    expect(waiting).toEqual([]);
    const later = planSurplusCosts({
      pending,
      usage: [],
      knownRequestIds: new Set(),
      now: T0 + 29 * 60 * 1000 + GIVE_UP_MS,
    });
    expect(later).toEqual([
      { id: 'missing', source: 'unavailable' },
      { id: 'recent', source: 'unavailable' },
    ]);
  });

  it('never matches a bill settled before the call was sent', () => {
    const decisions = planSurplusCosts({
      pending: [call('late', 'm', 60, null)],
      usage: [bill('r-before', 'm', 30, '0.1')],
      knownRequestIds: new Set(),
      now: NOW,
    });
    expect(decisions).toEqual([]);
  });
});

describe('parseSurplusUsageCsv', () => {
  it('reads the export columns and skips malformed rows', () => {
    const csv = [
      'request_id,created_at,model,input_tokens,output_tokens,buyer_cost_usd,direct_cost_usd,settlement_status,tx_hash',
      '"01M7HKKS01EBASFHWV5QNBE0GT","2026-11-16T07:19:53.941Z","gemini-3-flash-preview","7673","1060","0.000035","0.007017","accrued",""',
      '"bad id!","2026-11-16T07:19:53.941Z","m","1","1","0.1","0.1","accrued",""',
      '"01M7HKKKYT6DDE211KDDDE0BE7","not a date","m","1","1","0.1","0.1","accrued",""',
      '',
    ].join('\r\n');
    expect(parseSurplusUsageCsv(csv)).toEqual([
      {
        requestId: '01M7HKKS01EBASFHWV5QNBE0GT',
        createdAt: Date.parse('2026-11-16T07:19:53.941Z'),
        model: 'gemini-3-flash-preview',
        inputTokens: 7673,
        outputTokens: 1060,
        costUsd: '0.000035',
      },
    ]);
  });

  it('refuses an export without the columns it needs', () => {
    expect(() => parseSurplusUsageCsv('request_id,model\n"a","b"')).toThrow('缺少必需列');
  });
});
