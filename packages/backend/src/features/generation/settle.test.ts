import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';
import type { GenerationSettlementEntry } from './settle.js';

const { applyLlmCharge } = vi.hoisted(() => ({
  applyLlmCharge: vi.fn(),
}));

const { saveBillingSnapshot, recordBillingOutcome } = vi.hoisted(() => ({
  saveBillingSnapshot: vi.fn(),
  recordBillingOutcome: vi.fn(),
}));

const { fetchGenerationDataForSettlement } = vi.hoisted(() => ({
  fetchGenerationDataForSettlement: vi.fn(),
}));

vi.mock('./apply-charge.js', () => ({
  applyLlmCharge,
}));

vi.mock('../../infrastructure/repositories/ConversationHistoryRepository.js', () => ({
  ConversationHistoryRepository: class {
    saveBillingSnapshot = saveBillingSnapshot;
    recordBillingOutcome = recordBillingOutcome;
  },
}));

vi.mock('./openrouter-metadata.js', () => ({
  fetchGenerationDataForSettlement,
  buildGenerationMetadata: (genData: Record<string, unknown>) => ({
    llm_model: genData.model ?? null,
    llm_usage: genData.usage ?? null,
    llm_finish_reason: genData.finish_reason ?? null,
  }),
}));

vi.mock('../../lib/supabase.js', () => ({
  getDomainDb: () => ({
    rpc: vi.fn(async () => ({ data: [], error: null })),
  }),
}));

const { runSettlement } = await import('./settle.js');

function fakeLog(): FastifyBaseLogger {
  const log = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: () => log,
  };
  return log as unknown as FastifyBaseLogger;
}

function entry(overrides: Partial<GenerationSettlementEntry> = {}): GenerationSettlementEntry {
  return {
    user_id: 'user-1',
    model: 'anthropic/claude-sonnet-4.5',
    charge_id: 'charge-1',
    model_id: 'model-1',
    model_display_name: 'Claude Sonnet 4.5',
    model_markup: 1,
    fixed_deduction: 50,
    fixed_deduction_category: 'premium',
    catalog_version: 12,
    pricing_config_version: 7,
    exchange_rate: 1,
    user_input: '你好',
    assistant_reply: '完整回复',
    history: [],
    history_id: 'row-1',
    status: 'success',
    generation_id: 'gen-1',
    finish_reason: 'stop',
    ...overrides,
  };
}

describe('runSettlement', () => {
  beforeEach(() => {
    applyLlmCharge.mockReset();
    saveBillingSnapshot.mockReset();
    recordBillingOutcome.mockReset();
    fetchGenerationDataForSettlement.mockReset();
    applyLlmCharge.mockResolvedValue({ chargedAmount: 50, calculatedAmount: 50 });
    saveBillingSnapshot.mockResolvedValue(undefined);
    recordBillingOutcome.mockResolvedValue(undefined);
    fetchGenerationDataForSettlement.mockResolvedValue(null);
  });

  it('persists the request-time snapshot before charging and stamps settlement complete', async () => {
    const order: string[] = [];
    saveBillingSnapshot.mockImplementation(async () => {
      order.push('snapshot');
    });
    applyLlmCharge.mockImplementation(async () => {
      order.push('charge');
      return { chargedAmount: 50, calculatedAmount: 50 };
    });

    await runSettlement(entry(), fakeLog());

    expect(order).toEqual(['snapshot', 'charge']);
    expect(saveBillingSnapshot).toHaveBeenCalledWith(
      'row-1',
      expect.objectContaining({
        charge_id: 'charge-1',
        fixed_deduction: 50,
        catalog_version: 12,
        billing_mode: 'fixed_tier',
      })
    );
    expect(recordBillingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        historyId: 'row-1',
        deductionRate: 50,
        billingSettledAt: expect.any(String),
      })
    );
  });

  it('first charge RPC failure still saves snapshot and does not stamp complete', async () => {
    applyLlmCharge.mockRejectedValueOnce(new Error('rpc failed'));

    await runSettlement(entry(), fakeLog());

    expect(saveBillingSnapshot).toHaveBeenCalledOnce();
    expect(recordBillingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        historyId: 'row-1',
        deductionRate: 0,
      })
    );
    expect(recordBillingOutcome.mock.calls[0]?.[0]).not.toHaveProperty('billingSettledAt');
  });

  it('quota finalize failure is treated as unsettled so retry can close reserved', async () => {
    applyLlmCharge.mockRejectedValueOnce(new Error('quota rpc failed'));

    await runSettlement(entry(), fakeLog());

    expect(saveBillingSnapshot).toHaveBeenCalledOnce();
    expect(recordBillingOutcome.mock.calls[0]?.[0]).not.toHaveProperty('billingSettledAt');
  });

  it('amount writeback failure keeps snapshot and leaves settlement incomplete', async () => {
    recordBillingOutcome.mockRejectedValueOnce(new Error('update failed'));

    await runSettlement(entry(), fakeLog());

    expect(saveBillingSnapshot).toHaveBeenCalledOnce();
    expect(applyLlmCharge).toHaveBeenCalledOnce();
    expect(recordBillingOutcome).toHaveBeenCalledOnce();
  });

  it('does not stamp complete while still waiting for finish_reason', async () => {
    await runSettlement(entry({ finish_reason: null }), fakeLog());

    expect(applyLlmCharge).toHaveBeenCalledOnce();
    expect(recordBillingOutcome.mock.calls[0]?.[0]).not.toHaveProperty('billingSettledAt');
  });
});
