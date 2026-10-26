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

const { upsertVeniceHistory } = vi.hoisted(() => ({
  upsertVeniceHistory: vi.fn(),
}));

const { upsertOpenRouterHistory } = vi.hoisted(() => ({
  upsertOpenRouterHistory: vi.fn(),
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

vi.mock('../../infrastructure/repositories/VeniceChatHistoryRepository.js', () => ({
  VeniceChatHistoryRepository: class {
    upsert = upsertVeniceHistory;
  },
}));

vi.mock('../../infrastructure/repositories/OpenRouterChatHistoryRepository.js', () => ({
  OpenRouterChatHistoryRepository: class {
    upsert = upsertOpenRouterHistory;
  },
}));

vi.mock('./venice-metadata.js', () => ({
  buildVeniceMetadata: async (input: Record<string, unknown>) => ({
    chat_history_id: input.chatHistoryId,
    llm_provider_name: 'venice',
    llm_finish_reason: input.finishReason,
    llm_usage: 0.00014,
  }),
}));

vi.mock('./openrouter-metadata.js', async () => ({
  ...(await vi.importActual<typeof import('./openrouter-metadata.js')>('./openrouter-metadata.js')),
  fetchGenerationDataForSettlement,
}));

vi.mock('../../lib/supabase.js', () => ({
  getDomainDb: () => ({
    rpc: vi.fn(async () => ({ data: [], error: null })),
  }),
}));

const { runSettlement, settleGeneration } = await import('./settle.js');

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
    upsertVeniceHistory.mockReset();
    upsertOpenRouterHistory.mockReset();
    applyLlmCharge.mockResolvedValue({ chargedAmount: 50, calculatedAmount: 50 });
    saveBillingSnapshot.mockResolvedValue(undefined);
    recordBillingOutcome.mockResolvedValue(undefined);
    fetchGenerationDataForSettlement.mockResolvedValue(null);
    upsertVeniceHistory.mockResolvedValue(undefined);
    upsertOpenRouterHistory.mockResolvedValue(undefined);
  });

  it('settles an admitted manual stop without waiting for provider stop metadata', async () => {
    await runSettlement(
      entry({
        status: 'stream_interrupted',
        finish_reason: 'user_cancelled',
        assistant_reply: null,
        generation_id: null,
      }),
      fakeLog()
    );
    expect(fetchGenerationDataForSettlement).not.toHaveBeenCalled();
    expect(applyLlmCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        calculatedAmount: 50,
        finishReason: 'user_cancelled',
        assistantReply: null,
      })
    );
    expect(recordBillingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        finishReason: 'user_cancelled',
        billingSettledAt: expect.any(String),
      })
    );
  });

  it('manual billing retries stay unsettled without delaying an already stopped generation', async () => {
    applyLlmCharge.mockResolvedValueOnce({ pending: true, chargedAmount: 0, calculatedAmount: 50 });
    await expect(
      runSettlement(
        entry({ status: 'stream_interrupted', finish_reason: 'user_cancelled' }),
        fakeLog()
      )
    ).resolves.toBeUndefined();
    expect(recordBillingOutcome.mock.calls.at(-1)?.[0]).not.toHaveProperty('billingSettledAt');
    applyLlmCharge.mockRejectedValueOnce(new Error('wallet DB unavailable'));
    await expect(
      runSettlement(
        entry({ status: 'stream_interrupted', finish_reason: 'user_cancelled' }),
        fakeLog()
      )
    ).resolves.toBeUndefined();
    expect(recordBillingOutcome.mock.calls.at(-1)?.[0]).not.toHaveProperty('billingSettledAt');
    expect(saveBillingSnapshot).toHaveBeenCalledWith(
      'row-1',
      expect.objectContaining({ charge_id: 'charge-1', fixed_deduction: 50 })
    );
  });

  it('manual stop queues the same asynchronous settlement as a standard reply', async () => {
    let finishCharge: (() => void) | undefined;
    applyLlmCharge.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCharge = () => resolve({ pending: false, chargedAmount: 50, calculatedAmount: 50 });
        })
    );
    expect(
      settleGeneration(
        entry({ status: 'stream_interrupted', finish_reason: 'user_cancelled' }),
        fakeLog()
      )
    ).toBeUndefined();
    await vi.waitFor(() => expect(finishCharge).toBeDefined());
    expect(recordBillingOutcome).not.toHaveBeenCalled();
    finishCharge!();
    await vi.waitFor(() =>
      expect(recordBillingOutcome).toHaveBeenCalledWith(
        expect.objectContaining({
          billingSettledAt: expect.any(String),
          finishReason: 'user_cancelled',
        })
      )
    );
  });

  it('keeps a completed server reply unsettled while client display is pending', async () => {
    applyLlmCharge.mockResolvedValueOnce({ pending: true, chargedAmount: 0, calculatedAmount: 50 });
    await runSettlement(entry(), fakeLog());
    expect(recordBillingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ deductionRate: 0 })
    );
    expect(recordBillingOutcome.mock.calls[0]?.[0]).not.toHaveProperty('billingSettledAt');
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
  it('writes Venice response metadata to the provider table, not chat_history metadata columns', async () => {
    await runSettlement(
      entry({
        provider: 'venice',
        provider_model_id: 'venice-model',
        provider_response: {
          usage: { prompt_tokens: 100, completion_tokens: 20 },
          responseMetadata: { id: 'gen-1', model: 'venice-model' },
          latencyMs: 10,
          generationTimeMs: 20,
        },
      }),
      fakeLog()
    );

    expect(upsertVeniceHistory).toHaveBeenCalledWith(
      expect.objectContaining({ chat_history_id: 'row-1', llm_provider_name: 'venice' })
    );
    expect(recordBillingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ historyId: 'row-1', intendedDeduction: 50 })
    );
  });

  it('upstream stop stats cannot replace user cancellation in charge metadata', async () => {
    fetchGenerationDataForSettlement.mockResolvedValue({ finish_reason: 'stop', usage: 0.001 });
    await runSettlement(
      entry({ status: 'stream_interrupted', finish_reason: 'cancelled' }),
      fakeLog()
    );
    expect(applyLlmCharge).toHaveBeenCalledWith(
      expect.objectContaining({
        generationStatus: 'stream_interrupted',
        finishReason: 'cancelled',
      })
    );
    expect(recordBillingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        finishReason: 'cancelled',
      })
    );
    expect(upsertOpenRouterHistory).toHaveBeenCalledWith(
      expect.objectContaining({ finish_reason: 'stop' })
    );
  });

  it('writes OpenRouter raw metadata to the provider table after preserving parent billing facts', async () => {
    fetchGenerationDataForSettlement.mockResolvedValue({
      finish_reason: 'stop',
      usage: 0.001,
      model: 'routed/model',
      provider_name: 'CoreWeave',
    });

    await runSettlement(entry(), fakeLog());

    expect(upsertOpenRouterHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_history_id: 'row-1',
        provider_name: 'CoreWeave',
        llm_generation_id: 'gen-1',
        finish_reason: 'stop',
        usage: 0.001,
      })
    );
    expect(upsertOpenRouterHistory.mock.calls[0]?.[0]).not.toHaveProperty('llm_intended_deduction');
    expect(recordBillingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({
        intendedDeduction: 50,
        finishReason: 'stop',
      })
    );
    expect(recordBillingOutcome.mock.calls[0]?.[0]).not.toHaveProperty('metadata');
    expect(upsertOpenRouterHistory.mock.calls[0]?.[0]).not.toHaveProperty('llm_usage');
  });

  it('keeps free settlement separate from optional OpenRouter statistics', async () => {
    await runSettlement(entry({ fixed_deduction: 0 }), fakeLog());
    expect(fetchGenerationDataForSettlement).not.toHaveBeenCalled();
    expect(upsertOpenRouterHistory).not.toHaveBeenCalled();
    expect(recordBillingOutcome).toHaveBeenCalledWith(
      expect.objectContaining({ intendedDeduction: 0, billingSettledAt: expect.any(String) })
    );
  });
});
