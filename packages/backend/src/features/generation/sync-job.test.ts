import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChargeLlmUsageInput } from '../../infrastructure/repositories/MiniappWalletRepository.js';

const { chargeLlmUsage, finalizePending, findLlmUsageCharge, reconcileLlmUsage } = vi.hoisted(
  () => ({
    chargeLlmUsage: vi.fn(),
    finalizePending: vi.fn(),
    findLlmUsageCharge: vi.fn(),
    reconcileLlmUsage: vi.fn(),
  })
);

vi.mock('../../infrastructure/repositories/MiniappWalletRepository.js', () => ({
  MiniappWalletRepository: class {
    chargeLlmUsage = chargeLlmUsage;
    findLlmUsageCharge = findLlmUsageCharge;
    reconcileLlmUsage = reconcileLlmUsage;
  },
}));

vi.mock('../../infrastructure/repositories/MiniappCharacterFreeQuotaRepository.js', () => ({
  MiniappCharacterFreeQuotaRepository: class {
    finalizePending = finalizePending;
  },
}));

const { reconcileCharge } = await import('./sync-job.js');

function lastCharge(): ChargeLlmUsageInput {
  const input = chargeLlmUsage.mock.calls.at(-1)?.[0] as ChargeLlmUsageInput | undefined;
  if (!input) throw new Error('chargeLlmUsage was not called');
  return input;
}

function pendingFixedCharge(overrides: Record<string, unknown> = {}) {
  return {
    charge_key: 'charge-1',
    user_id: 'user-1',
    model_id: 'model-1',
    model_openrouter_id: 'anthropic/claude-sonnet-4.5',
    model_display_name: 'Claude Sonnet 4.5',
    catalog_version: 12,
    pricing_config_version: 7,
    exchange_rate: 680,
    model_markup: 1,
    calculated_amount: 0,
    status: 'pending',
    metadata: {
      billing_mode: 'fixed_tier',
      requested_model: 'anthropic/claude-sonnet-4.5',
      fixed_deduction: 50,
      fixed_deduction_category: 'premium',
      reply_outcome: 'complete',
    },
    ...overrides,
  };
}

function syncInput(
  overrides: {
    finishReason?: string | null;
    assistantReply?: string | null;
    status?: string;
    genData?: Record<string, unknown>;
  } = {}
) {
  const finishReason = overrides.finishReason === undefined ? 'length' : overrides.finishReason;
  return {
    record: {
      id: 'row-1',
      llm_charge_id: 'charge-1',
      assistant_reply:
        overrides.assistantReply === undefined ? '还没说完' : overrides.assistantReply,
      status: overrides.status ?? 'success',
    },
    generationId: 'gen-1',
    genData: {
      usage: 0.01,
      model: 'anthropic/claude-sonnet-4.5',
      finish_reason: finishReason,
      ...(overrides.genData ?? {}),
    },
    finishReason,
    llmMetadata: {} as Record<string, unknown>,
  };
}

describe('reconcileCharge (fixed_tier pending → applyLlmCharge)', () => {
  beforeEach(() => {
    chargeLlmUsage.mockReset();
    finalizePending.mockReset();
    findLlmUsageCharge.mockReset();
    reconcileLlmUsage.mockReset();
    chargeLlmUsage.mockResolvedValue({
      charge: { charged_amount: 0, calculated_amount: 50 },
    });
    finalizePending.mockResolvedValue(null);
    findLlmUsageCharge.mockResolvedValue(pendingFixedCharge());
  });

  it('success + length after sync is incomplete, not the old complete', async () => {
    const input = syncInput({ finishReason: 'length' });
    await reconcileCharge(input);

    expect(lastCharge().metadata).toMatchObject({
      source: 'chat_history_sync',
      chat_status: 'success',
      generation_status: 'success',
      reply_outcome: 'incomplete',
      finish_reason: 'length',
      billing_gate: 'non_billable',
      billing_mode: 'fixed_tier',
      fixed_deduction: 50,
    });
    expect(input.llmMetadata).toEqual({
      llm_intended_deduction: 50,
      deduction_rate: 0,
    });
    expect(reconcileLlmUsage).not.toHaveBeenCalled();
  });

  it('success + content_filter is also incomplete', async () => {
    await reconcileCharge(syncInput({ finishReason: 'content_filter' }));

    expect(lastCharge().metadata).toMatchObject({
      reply_outcome: 'incomplete',
      chat_status: 'success',
      billing_gate: 'non_billable',
      finish_reason: 'content_filter',
    });
  });

  it('natural stop stays complete and consumes free quota after charge', async () => {
    chargeLlmUsage.mockResolvedValue({
      charge: { charged_amount: 50, calculated_amount: 50 },
    });
    const order: string[] = [];
    chargeLlmUsage.mockImplementation(async (payload: ChargeLlmUsageInput) => {
      order.push('charge');
      return { charge: { charged_amount: 50, calculated_amount: payload.calculatedAmount } };
    });
    finalizePending.mockImplementation(async () => {
      order.push('finalize');
      return null;
    });

    await reconcileCharge(syncInput({ finishReason: 'stop', assistantReply: '完整回复' }));

    expect(lastCharge().metadata).toMatchObject({
      reply_outcome: 'complete',
      chat_status: 'success',
      billing_gate: 'billable',
    });
    expect(finalizePending).toHaveBeenCalledWith('charge-1', true);
    expect(order).toEqual(['charge', 'finalize']);
  });

  it('uses pending row fixed_deduction, not the zero calculated_amount', async () => {
    await reconcileCharge(syncInput({ finishReason: 'stop' }));
    expect(lastCharge().calculatedAmount).toBe(50);
  });

  it('charge failure does not finalize quota (keeps reserved for retry)', async () => {
    chargeLlmUsage.mockRejectedValueOnce(new Error('rpc failed'));
    await expect(reconcileCharge(syncInput({ finishReason: 'stop' }))).rejects.toThrow(
      'rpc failed'
    );
    expect(finalizePending).not.toHaveBeenCalled();
  });

  it('does not charge while finish_reason is still null', async () => {
    await reconcileCharge(syncInput({ finishReason: null }));
    expect(chargeLlmUsage).not.toHaveBeenCalled();
    expect(finalizePending).not.toHaveBeenCalled();
    expect(reconcileLlmUsage).not.toHaveBeenCalled();
  });
});

describe('reconcileCharge (legacy usage branch)', () => {
  beforeEach(() => {
    chargeLlmUsage.mockReset();
    finalizePending.mockReset();
    findLlmUsageCharge.mockReset();
    reconcileLlmUsage.mockReset();
    reconcileLlmUsage.mockResolvedValue({
      charge: { charged_amount: 12, calculated_amount: 12 },
    });
    findLlmUsageCharge.mockResolvedValue({
      ...pendingFixedCharge(),
      status: 'charged',
      calculated_amount: 12,
      metadata: { billing_mode: 'actual_usage' },
    });
  });

  it('still goes through reconcileLlmUsage, not applyLlmCharge', async () => {
    const input = syncInput({ finishReason: 'stop', assistantReply: '完整回复' });
    await reconcileCharge(input);

    expect(chargeLlmUsage).not.toHaveBeenCalled();
    expect(finalizePending).not.toHaveBeenCalled();
    expect(reconcileLlmUsage).toHaveBeenCalledWith({
      chargeId: 'charge-1',
      usageCostUsd: 0.01,
      calculatedAmount: 6.8,
      metadata: { source: 'chat_history_sync' },
    });
    expect(input.llmMetadata).toEqual({
      llm_intended_deduction: 6.8,
      deduction_rate: 12,
    });
  });
});
