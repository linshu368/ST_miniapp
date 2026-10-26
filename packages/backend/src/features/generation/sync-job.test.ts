import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChargeLlmUsageInput } from '../../infrastructure/repositories/MiniappWalletRepository.js';
import type { LlmBillingSnapshot } from '../../infrastructure/repositories/ConversationHistoryRepository.js';
import type { FastifyBaseLogger } from 'fastify';

const syncMocks = vi.hoisted(() => ({
  keyAvailable: true,
  listRows: vi.fn(),
  staleRows: vi.fn().mockResolvedValue([]),
  recoverStale: vi.fn(),
  pendingRows: vi.fn().mockResolvedValue([]),
  missingRows: vi.fn().mockResolvedValue([]),
  upsert: vi.fn(),
  readGenerationData: vi.fn().mockResolvedValue(null),
  recordBillingOutcome: vi.fn(),
  fetchGenerationData: vi.fn(),
  enrichGeneration: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../infrastructure/repositories/GenerationObservationRepository.js', () => ({
  GenerationObservationRepository: class {
    enrichGeneration = syncMocks.enrichGeneration;
  },
}));

vi.mock('../../infrastructure/repositories/ConversationHistoryRepository.js', () => ({
  ConversationHistoryRepository: class {
    recordBillingOutcome = syncMocks.recordBillingOutcome;
    listStaleStreaming = syncMocks.staleRows;
    recoverStaleStreaming = syncMocks.recoverStale;
    listRowsPendingBilling = syncMocks.pendingRows;
    listRowsMissingProviderIdentity = syncMocks.missingRows;
  },
}));
vi.mock('../../infrastructure/repositories/OpenRouterChatHistoryRepository.js', () => ({
  OpenRouterChatHistoryRepository: class {
    listRowsMissingGenerationData = syncMocks.listRows;
    upsert = syncMocks.upsert;
    readGenerationData = syncMocks.readGenerationData;
  },
}));
vi.mock('./openrouter-metadata.js', async () => ({
  ...(await vi.importActual<typeof import('./openrouter-metadata.js')>('./openrouter-metadata.js')),
  hasOpenRouterKey: () => syncMocks.keyAvailable,
  fetchGenerationData: syncMocks.fetchGenerationData,
}));

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

const { reconcileCharge, startChatHistorySyncJob, stopChatHistorySyncJob } =
  await import('./sync-job.js');

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

function billingSnapshot(overrides: Partial<LlmBillingSnapshot> = {}): LlmBillingSnapshot {
  return {
    charge_id: 'charge-1',
    model_id: 'model-1',
    model_display_name: 'Claude Sonnet 4.5',
    model_markup: 1,
    fixed_deduction: 50,
    fixed_deduction_category: 'premium',
    catalog_version: 12,
    pricing_config_version: 7,
    exchange_rate: 1,
    billing_mode: 'fixed_tier',
    ...overrides,
  };
}

function syncInput(
  overrides: {
    finishReason?: string | null;
    assistantReply?: string | null;
    status?: string;
    genData?: Record<string, unknown>;
    llmChargeId?: string | null;
    snapshot?: LlmBillingSnapshot | null;
  } = {}
) {
  const finishReason = overrides.finishReason === undefined ? 'length' : overrides.finishReason;
  return {
    record: {
      id: 'row-1',
      user_id: 'user-1',
      model: 'anthropic/claude-sonnet-4.5',
      llm_charge_id: overrides.llmChargeId === undefined ? 'charge-1' : overrides.llmChargeId,
      assistant_reply:
        overrides.assistantReply === undefined ? '还没说完' : overrides.assistantReply,
      status: overrides.status ?? 'success',
      llm_billing_snapshot:
        overrides.snapshot === undefined ? billingSnapshot() : overrides.snapshot,
    },
    generationId: 'gen-1',
    genData: {
      usage: 0.01,
      model: 'anthropic/claude-sonnet-4.5',
      finish_reason: finishReason,
      ...(overrides.genData ?? {}),
    },
    finishReason,
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

  it('does not mark recovery settled while a display receipt is still pending', async () => {
    chargeLlmUsage.mockResolvedValueOnce({
      charge: { status: 'pending', charged_amount: 0, calculated_amount: 50 },
    });
    const result = await reconcileCharge(syncInput({ finishReason: 'stop' }));
    expect(result).toEqual({ settled: false, intendedDeduction: 50, deductionRate: 0 });
    expect(finalizePending).not.toHaveBeenCalled();
  });

  it('success + length after sync is incomplete, not the old complete', async () => {
    const input = syncInput({ finishReason: 'length' });
    const result = await reconcileCharge(input);

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
    expect(result).toEqual({
      settled: true,
      intendedDeduction: 50,
      deductionRate: 0,
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
    await reconcileCharge(syncInput({ finishReason: 'stop', snapshot: null }));
    expect(lastCharge().calculatedAmount).toBe(50);
  });

  it('replays the accepted payable snapshot instead of a later catalog price', async () => {
    findLlmUsageCharge.mockResolvedValue(
      pendingFixedCharge({
        metadata: {
          billing_mode: 'fixed_tier',
          fixed_deduction: 999,
          payable_credits: 999,
          fixed_deduction_category: 'premium',
        },
      })
    );
    await reconcileCharge(
      syncInput({
        finishReason: 'stop',
        assistantReply: '完整回复',
        snapshot: billingSnapshot({
          fixed_deduction: 48,
          payable_credits: 48,
          original_credits: 50,
          discount_rate: 0.95,
          wallet_policy: 'main_only',
          vip_active: true,
        }),
      })
    );
    expect(lastCharge().calculatedAmount).toBe(48);
    expect(lastCharge().metadata).toMatchObject({
      payable_credits: 48,
      fixed_deduction: 48,
      wallet_policy: 'main_only',
      original_credits: 50,
    });
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
    const original = { ...input.genData };
    Object.freeze(input.genData);
    const result = await reconcileCharge(input);

    expect(chargeLlmUsage).not.toHaveBeenCalled();
    expect(finalizePending).not.toHaveBeenCalled();
    expect(reconcileLlmUsage).toHaveBeenCalledWith({
      chargeId: 'charge-1',
      usageCostUsd: 0.01,
      calculatedAmount: 6.8,
      metadata: { source: 'chat_history_sync' },
    });
    expect(result).toEqual({
      settled: true,
      intendedDeduction: 6.8,
      deductionRate: 12,
    });
    expect(input.genData).toEqual(original);
  });
});

describe('reconcileCharge (A1 rebuild from snapshot)', () => {
  beforeEach(() => {
    chargeLlmUsage.mockReset();
    finalizePending.mockReset();
    findLlmUsageCharge.mockReset();
    reconcileLlmUsage.mockReset();
    chargeLlmUsage.mockResolvedValue({
      charge: { charged_amount: 50, calculated_amount: 50 },
    });
    finalizePending.mockResolvedValue(null);
    findLlmUsageCharge.mockResolvedValue(null);
  });

  it('rebuilds a missing charge row from the request-time snapshot', async () => {
    const input = syncInput({ finishReason: 'stop', assistantReply: '完整回复' });
    const result = await reconcileCharge(input);

    expect(result).toEqual({ settled: true, intendedDeduction: 50, deductionRate: 50 });
    expect(lastCharge()).toMatchObject({
      chargeId: 'charge-1',
      userId: 'user-1',
      calculatedAmount: 50,
      catalogVersion: 12,
      pricingConfigVersion: 7,
      modelMarkup: 1,
    });
    expect(lastCharge().metadata).toMatchObject({
      billing_mode: 'fixed_tier',
      fixed_deduction: 50,
      source: 'chat_history_sync',
      reply_outcome: 'complete',
    });
    expect(finalizePending).toHaveBeenCalledWith('charge-1', true);
  });

  it('does not reprice when the snapshot amount differs from current catalog', async () => {
    await reconcileCharge(
      syncInput({
        finishReason: 'stop',
        snapshot: billingSnapshot({ fixed_deduction: 30 }),
      })
    );
    expect(lastCharge().calculatedAmount).toBe(30);
  });

  it('cannot rebuild without a snapshot and leaves settlement incomplete', async () => {
    const result = await reconcileCharge(syncInput({ finishReason: 'stop', snapshot: null }));
    expect(result).toEqual({ settled: false });
    expect(chargeLlmUsage).not.toHaveBeenCalled();
    expect(finalizePending).not.toHaveBeenCalled();
  });
});

describe('reconcileCharge (A2 already charged / free)', () => {
  beforeEach(() => {
    chargeLlmUsage.mockReset();
    finalizePending.mockReset();
    findLlmUsageCharge.mockReset();
    reconcileLlmUsage.mockReset();
    finalizePending.mockResolvedValue(null);
  });

  it('free rows still finalize quota and write back the charged amount', async () => {
    findLlmUsageCharge.mockResolvedValue({
      ...pendingFixedCharge(),
      status: 'free',
      charged_amount: 0,
      calculated_amount: 0,
    });
    chargeLlmUsage.mockResolvedValue({
      charge: { charged_amount: 0, calculated_amount: 0 },
      alreadyCharged: true,
    });

    const input = syncInput({ finishReason: 'stop', assistantReply: '完整回复' });
    const result = await reconcileCharge(input);

    expect(result).toEqual({ settled: true, intendedDeduction: 0, deductionRate: 0 });
    expect(chargeLlmUsage).toHaveBeenCalledOnce();
    expect(finalizePending).toHaveBeenCalledWith('charge-1', true);
  });

  it('charged rows still finalize quota and write back the charged amount', async () => {
    findLlmUsageCharge.mockResolvedValue({
      ...pendingFixedCharge(),
      status: 'charged',
      charged_amount: 50,
      calculated_amount: 50,
    });
    chargeLlmUsage.mockResolvedValue({
      charge: { charged_amount: 50, calculated_amount: 50 },
      alreadyCharged: true,
    });

    const input = syncInput({ finishReason: 'stop', assistantReply: '完整回复' });
    const result = await reconcileCharge(input);

    expect(result).toEqual({ settled: true, intendedDeduction: 50, deductionRate: 50 });
    expect(finalizePending).toHaveBeenCalledWith('charge-1', true);
  });

  it('process restart after charge success still closes quota with the same charge_id', async () => {
    findLlmUsageCharge.mockResolvedValue({
      ...pendingFixedCharge(),
      status: 'charged',
      charged_amount: 50,
      calculated_amount: 50,
    });
    chargeLlmUsage.mockResolvedValue({
      charge: { charged_amount: 50, calculated_amount: 50 },
      alreadyCharged: true,
    });

    await reconcileCharge(syncInput({ finishReason: 'stop', assistantReply: '完整回复' }));
    expect(lastCharge().chargeId).toBe('charge-1');
    expect(finalizePending).toHaveBeenCalledWith('charge-1', true);
  });

  it('duplicate execution keeps the snapshot amount and the same charge_id', async () => {
    findLlmUsageCharge.mockResolvedValue({
      ...pendingFixedCharge(),
      status: 'charged',
      charged_amount: 50,
      calculated_amount: 50,
    });
    chargeLlmUsage.mockResolvedValue({
      charge: { charged_amount: 50, calculated_amount: 50 },
      alreadyCharged: true,
    });

    const first = syncInput({ finishReason: 'stop', assistantReply: '完整回复' });
    const second = syncInput({ finishReason: 'stop', assistantReply: '完整回复' });
    const firstResult = await reconcileCharge(first);
    const secondResult = await reconcileCharge(second);

    expect(chargeLlmUsage).toHaveBeenCalledTimes(2);
    expect(lastCharge().chargeId).toBe('charge-1');
    expect(lastCharge().calculatedAmount).toBe(50);
    expect(firstResult.deductionRate).toBe(50);
    expect(secondResult.deductionRate).toBe(50);
  });
});

describe('OpenRouter sync original-field persistence', () => {
  it.each([null, 'cancelled', 'user_cancelled', 'timeout'] as const)(
    'keeps upstream metadata immutable and uses the business finish reason %s for settlement',
    async (businessReason) => {
      vi.useFakeTimers();
      vi.clearAllMocks();
      const input = syncInput({
        finishReason: 'stop',
        status: businessReason ? 'stream_interrupted' : 'success',
      });
      const raw = Object.freeze({
        provider_name: 'Google',
        model: 'routed/model',
        usage: 0.01,
        usage_cache: 0,
        finish_reason: 'stop',
        latency: 10,
        generation_time: 20,
      });
      syncMocks.listRows.mockResolvedValue([
        {
          ...input.record,
          generationId: 'gen-1',
          callProvider: 'openrouter',
          llm_finish_reason: businessReason,
        },
      ]);
      syncMocks.fetchGenerationData.mockResolvedValue(raw);
      syncMocks.recordBillingOutcome.mockResolvedValue(undefined);
      syncMocks.upsert.mockResolvedValue(undefined);
      findLlmUsageCharge.mockResolvedValue(pendingFixedCharge());
      chargeLlmUsage.mockResolvedValue({
        charge: { calculated_amount: 50, charged_amount: businessReason ? 0 : 50 },
      });
      finalizePending.mockResolvedValue(null);
      const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: vi.fn() };
      log.child.mockReturnValue(log);
      try {
        startChatHistorySyncJob(log as unknown as FastifyBaseLogger);
        await vi.advanceTimersByTimeAsync(5_001);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(syncMocks.recordBillingOutcome).toHaveBeenCalledWith(
          expect.objectContaining({
            historyId: 'row-1',
            intendedDeduction: 50,
            deductionRate: businessReason ? 0 : 50,
            finishReason: businessReason ?? 'stop',
            billingSettledAt: expect.any(String),
          })
        );
        expect(syncMocks.upsert).toHaveBeenCalledTimes(2);
        expect(syncMocks.upsert).toHaveBeenCalledWith(
          expect.objectContaining({
            chat_history_id: 'row-1',
            llm_generation_id: 'gen-1',
            usage: 0.01,
            usage_cache: 0,
            provider_name: 'Google',
            finish_reason: 'stop',
          })
        );
        const payload = syncMocks.upsert.mock.calls[0]?.[0] as Record<string, unknown>;
        expect(payload).not.toHaveProperty('llm_usage');
        expect(payload).not.toHaveProperty('llm_intended_deduction');
        expect(payload).not.toHaveProperty('deduction_rate');
        expect(lastCharge()).toMatchObject({ chargeId: 'charge-1', generationId: 'gen-1' });
        expect(lastCharge().metadata).toMatchObject({ finish_reason: businessReason ?? 'stop' });
        expect(raw).not.toHaveProperty('llm_intended_deduction');
      } finally {
        stopChatHistorySyncJob();
        vi.useRealTimers();
      }
    }
  );
});

describe('sync recovery sources', () => {
  it.each(['openrouter', 'venice', 'missing'] as const)(
    'recovers %s independently of incomplete metadata and deduplicates parents',
    async (source) => {
      vi.useFakeTimers();
      vi.clearAllMocks();
      const input = syncInput({
        finishReason: 'stop',
        snapshot: billingSnapshot({ provider: source === 'venice' ? 'venice' : 'openrouter' }),
      });
      const record = {
        ...input.record,
        generationId: 'gen-1',
        callProvider: source === 'venice' ? 'venice' : 'openrouter',
        llm_finish_reason: 'stop',
      };
      if (source === 'openrouter')
        syncMocks.listRows.mockRejectedValue(new Error('metadata scan unavailable'));
      else syncMocks.listRows.mockResolvedValue([]);
      syncMocks.pendingRows.mockResolvedValue(source === 'missing' ? [] : [record]);
      if (source === 'venice')
        syncMocks.missingRows.mockRejectedValue(new Error('detail scan unavailable'));
      else syncMocks.missingRows.mockResolvedValue([record]);
      syncMocks.fetchGenerationData.mockResolvedValue({
        usage: 0.01,
        latency: 1,
        generation_time: 2,
        finish_reason: 'stop',
      });
      syncMocks.recordBillingOutcome.mockResolvedValue(undefined);
      syncMocks.upsert.mockResolvedValue(undefined);
      findLlmUsageCharge.mockResolvedValue(pendingFixedCharge());
      chargeLlmUsage.mockResolvedValue({ charge: { calculated_amount: 50, charged_amount: 50 } });
      finalizePending.mockResolvedValue(null);
      const log = { info: vi.fn(), error: vi.fn(), warn: vi.fn(), child: vi.fn() };
      log.child.mockReturnValue(log);
      try {
        startChatHistorySyncJob(log as unknown as FastifyBaseLogger);
        await vi.advanceTimersByTimeAsync(5_001);
        expect(chargeLlmUsage).toHaveBeenCalledOnce();
        expect(syncMocks.recordBillingOutcome).toHaveBeenCalledWith(
          expect.objectContaining({ historyId: 'row-1', billingSettledAt: expect.any(String) })
        );
        if (source === 'venice') {
          expect(syncMocks.fetchGenerationData).not.toHaveBeenCalled();
          expect(syncMocks.upsert).not.toHaveBeenCalled();
        } else {
          expect(syncMocks.fetchGenerationData).toHaveBeenCalledOnce();
          expect(syncMocks.upsert).toHaveBeenCalledWith(
            expect.objectContaining({
              chat_history_id: 'row-1',
              llm_generation_id: 'gen-1',
              finish_reason: 'stop',
            })
          );
        }
      } finally {
        stopChatHistorySyncJob();
        vi.useRealTimers();
        syncMocks.pendingRows.mockResolvedValue([]);
        syncMocks.missingRows.mockResolvedValue([]);
      }
    }
  );
});

describe('durable recovery without an upstream lookup', () => {
  it.each([false, true])(
    'recovers a stopped terminal quote asynchronously (pending=%s)',
    async (pending) => {
      vi.useFakeTimers();
      vi.clearAllMocks();
      const input = syncInput({
        finishReason: 'user_cancelled',
        status: 'stream_interrupted',
        assistantReply: null,
      });
      syncMocks.pendingRows.mockResolvedValue([]);
      syncMocks.listRows.mockResolvedValue([]);
      syncMocks.staleRows.mockResolvedValue([]);
      syncMocks.missingRows.mockResolvedValue([
        {
          ...input.record,
          llm_finish_reason: 'user_cancelled',
          session_id: 'session-1',
          generationId: null,
          callProvider: 'openrouter',
        },
      ]);
      findLlmUsageCharge.mockResolvedValue(null);
      chargeLlmUsage.mockResolvedValue({
        charge: {
          status: pending ? 'pending' : 'charged',
          charged_amount: pending ? 0 : 50,
          calculated_amount: 50,
          metadata: { delivery_billing_gate: 'user_stopped' },
        },
      });
      finalizePending.mockResolvedValue(null);
      syncMocks.recordBillingOutcome.mockResolvedValue(undefined);
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
      log.child.mockReturnValue(log);
      try {
        startChatHistorySyncJob(log as unknown as FastifyBaseLogger);
        await vi.advanceTimersByTimeAsync(5001);
        expect(lastCharge()).toMatchObject({
          chargeId: 'charge-1',
          generationId: null,
          calculatedAmount: 50,
          metadata: { finish_reason: 'user_cancelled' },
        });
        expect(syncMocks.fetchGenerationData).not.toHaveBeenCalled();
        expect(syncMocks.recoverStale).not.toHaveBeenCalled();
        if (pending) expect(syncMocks.recordBillingOutcome).not.toHaveBeenCalled();
        else {
          expect(finalizePending).toHaveBeenCalledWith('charge-1', true);
          expect(syncMocks.recordBillingOutcome).toHaveBeenCalledWith(
            expect.objectContaining({ billingSettledAt: expect.any(String) })
          );
        }
      } finally {
        stopChatHistorySyncJob();
        syncMocks.missingRows.mockResolvedValue([]);
        vi.useRealTimers();
      }
    }
  );

  it.each(['openrouter', 'venice'] as const)(
    'recovers %s when the OpenRouter key is unavailable',
    async (provider) => {
      vi.useFakeTimers();
      vi.clearAllMocks();
      syncMocks.keyAvailable = false;
      const input = syncInput({ finishReason: 'stop', snapshot: billingSnapshot({ provider }) });
      syncMocks.pendingRows.mockResolvedValue([
        {
          ...input.record,
          generationId: 'stored-id',
          callProvider: provider,
          llm_finish_reason: 'stop',
        },
      ]);
      syncMocks.listRows.mockResolvedValue([]);
      syncMocks.missingRows.mockResolvedValue([]);
      syncMocks.staleRows.mockResolvedValue([]);
      syncMocks.readGenerationData.mockResolvedValue({
        usage: 0,
        latency: 0,
        generation_time: 1,
        finish_reason: 'stop',
      });
      findLlmUsageCharge.mockResolvedValue(pendingFixedCharge());
      chargeLlmUsage.mockResolvedValue({ charge: { charged_amount: 50, calculated_amount: 50 } });
      finalizePending.mockResolvedValue(null);
      const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
      log.child.mockReturnValue(log);
      try {
        startChatHistorySyncJob(log as unknown as FastifyBaseLogger);
        await vi.advanceTimersByTimeAsync(5001);
        expect(chargeLlmUsage).toHaveBeenCalledOnce();
        expect(syncMocks.fetchGenerationData).not.toHaveBeenCalled();
        expect(syncMocks.recordBillingOutcome).toHaveBeenCalledWith(
          expect.objectContaining({ billingSettledAt: expect.any(String) })
        );
        expect(syncMocks.upsert).not.toHaveBeenCalled();
      } finally {
        stopChatHistorySyncJob();
        syncMocks.keyAvailable = true;
        syncMocks.readGenerationData.mockResolvedValue(null);
        vi.useRealTimers();
      }
    }
  );

  it('recovers a stale owner without an ID and leaves successful unknown calls for audit', async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    const input = syncInput();
    syncMocks.pendingRows.mockResolvedValue([]);
    syncMocks.listRows.mockResolvedValue([]);
    syncMocks.missingRows.mockResolvedValue([
      { ...input.record, status: 'success', generationId: null, callProvider: 'openrouter' },
    ]);
    syncMocks.staleRows.mockResolvedValue([
      {
        ...input.record,
        id: 'stale-row',
        status: 'streaming',
        session_id: 'session-1',
        generationId: null,
        callProvider: null,
      },
    ]);
    syncMocks.recoverStale.mockResolvedValue(undefined);
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
    log.child.mockReturnValue(log);
    try {
      startChatHistorySyncJob(log as unknown as FastifyBaseLogger);
      await vi.advanceTimersByTimeAsync(5001);
      expect(syncMocks.recoverStale).toHaveBeenCalledExactlyOnceWith('session-1');
      expect(chargeLlmUsage).not.toHaveBeenCalled();
      expect(syncMocks.fetchGenerationData).not.toHaveBeenCalled();
      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'chathistory_sync.identity_missing' }),
        expect.any(String)
      );
    } finally {
      stopChatHistorySyncJob();
      syncMocks.staleRows.mockResolvedValue([]);
      vi.useRealTimers();
    }
  });
});

it('closes a determined failed fixed-tier call with no generation ID using its original charge key', async () => {
  const input = syncInput({ status: 'stream_interrupted', finishReason: 'cancelled' });
  findLlmUsageCharge.mockResolvedValue(pendingFixedCharge());
  chargeLlmUsage.mockResolvedValue({ charge: { charged_amount: 0, calculated_amount: 50 } });
  finalizePending.mockResolvedValue(null);
  await expect(reconcileCharge({ ...input, generationId: null })).resolves.toMatchObject({
    settled: true,
    deductionRate: 0,
  });
  expect(lastCharge()).toMatchObject({ chargeId: 'charge-1', generationId: null });
  expect(finalizePending).toHaveBeenCalledWith('charge-1', false);
});

it('uses a proven Venice detail source when a legacy snapshot omitted provider', async () => {
  const input = syncInput({ finishReason: 'stop' });
  findLlmUsageCharge.mockResolvedValue(pendingFixedCharge());
  chargeLlmUsage.mockResolvedValue({ charge: { charged_amount: 50, calculated_amount: 50 } });
  finalizePending.mockResolvedValue(null);
  await reconcileCharge({ ...input, record: { ...input.record, callProvider: 'venice' } });
  expect(lastCharge().metadata).toMatchObject({ provider: 'venice' });
});
