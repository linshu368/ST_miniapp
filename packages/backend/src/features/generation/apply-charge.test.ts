import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChargeLlmUsageInput } from '../../infrastructure/repositories/MiniappWalletRepository.js';

const { chargeLlmUsage, finalizePending } = vi.hoisted(() => ({
  chargeLlmUsage: vi.fn(),
  finalizePending: vi.fn(),
}));

vi.mock('../../infrastructure/repositories/MiniappWalletRepository.js', () => ({
  MiniappWalletRepository: class {
    chargeLlmUsage = chargeLlmUsage;
  },
}));

vi.mock('../../infrastructure/repositories/MiniappCharacterFreeQuotaRepository.js', () => ({
  MiniappCharacterFreeQuotaRepository: class {
    finalizePending = finalizePending;
  },
}));

const { applyLlmCharge, resolveBillingChatStatus, resolveReplyOutcome } =
  await import('./apply-charge.js');

function lastCharge(): ChargeLlmUsageInput {
  const input = chargeLlmUsage.mock.calls.at(-1)?.[0] as ChargeLlmUsageInput | undefined;
  if (!input) throw new Error('chargeLlmUsage was not called');
  return input;
}

function command(overrides: Partial<Parameters<typeof applyLlmCharge>[0]> = {}) {
  return {
    chargeId: 'charge-1',
    generationId: 'gen-1',
    userId: 'user-1',
    modelId: 'model-1',
    requestedModel: 'anthropic/claude-sonnet-4.5',
    observedModel: null,
    requestedDisplayName: 'Claude Sonnet 4.5',
    catalogVersion: 12,
    pricingConfigVersion: 7,
    usageCostUsd: 0.01,
    exchangeRate: 680,
    modelMarkup: 1,
    calculatedAmount: 50,
    fallbackUsed: false,
    generationStatus: 'success',
    finishReason: 'stop' as string | null,
    assistantReply: '完整回复',
    baseMetadata: {
      requested_model: 'anthropic/claude-sonnet-4.5',
      billing_mode: 'fixed_tier',
      fixed_deduction_category: 'premium',
      fixed_deduction: 50,
    },
    ...overrides,
  };
}

describe('resolveReplyOutcome', () => {
  it('empty when there is no visible reply', () => {
    expect(
      resolveReplyOutcome({
        assistantReply: '   ',
        generationStatus: 'success',
        finishReason: 'stop',
      })
    ).toBe('empty');
  });

  it('complete when success and finish_reason is stop or still null', () => {
    expect(
      resolveReplyOutcome({
        assistantReply: '你好',
        generationStatus: 'success',
        finishReason: 'stop',
      })
    ).toBe('complete');
    expect(
      resolveReplyOutcome({
        assistantReply: '你好',
        generationStatus: 'success',
        finishReason: null,
      })
    ).toBe('complete');
  });

  it('incomplete for length / interrupted / upstream_error with content', () => {
    expect(
      resolveReplyOutcome({
        assistantReply: '还没说完',
        generationStatus: 'success',
        finishReason: 'length',
      })
    ).toBe('incomplete');
    expect(
      resolveReplyOutcome({
        assistantReply: '还没说完',
        generationStatus: 'stream_interrupted',
        finishReason: 'stop',
      })
    ).toBe('incomplete');
  });
});

describe('resolveBillingChatStatus', () => {
  it('keeps HEAD settle formula: pending finish_reason with generation_id reports success', () => {
    expect(
      resolveBillingChatStatus({
        generationStatus: 'stream_interrupted',
        finishReason: null,
        generationId: 'gen-1',
      })
    ).toBe('success');
  });

  it('uses generationStatus when finish_reason is already known', () => {
    expect(
      resolveBillingChatStatus({
        generationStatus: 'success',
        finishReason: 'length',
        generationId: 'gen-1',
      })
    ).toBe('success');
    expect(
      resolveBillingChatStatus({
        generationStatus: 'stream_interrupted',
        finishReason: 'length',
        generationId: 'gen-1',
      })
    ).toBe('stream_interrupted');
    expect(
      resolveBillingChatStatus({
        generationStatus: 'upstream_error',
        finishReason: 'stop',
        generationId: 'gen-1',
      })
    ).toBe('upstream_error');
  });

  it('uses generationStatus when finish_reason is null and generation_id is missing', () => {
    expect(
      resolveBillingChatStatus({
        generationStatus: 'stream_interrupted',
        finishReason: null,
        generationId: null,
      })
    ).toBe('stream_interrupted');
  });
});

describe('applyLlmCharge', () => {
  beforeEach(() => {
    chargeLlmUsage.mockReset();
    finalizePending.mockReset();
    chargeLlmUsage.mockResolvedValue({
      charge: { charged_amount: 50, calculated_amount: 50 },
    });
    finalizePending.mockResolvedValue(null);
  });

  it('natural stop: complete + chat_status success, consumes free quota', async () => {
    const result = await applyLlmCharge(command());

    expect(result).toEqual({
      replyOutcome: 'complete',
      billingChatStatus: 'success',
      chargedAmount: 50,
      calculatedAmount: 50,
    });
    expect(lastCharge().metadata).toMatchObject({
      chat_status: 'success',
      generation_status: 'success',
      reply_outcome: 'complete',
      reply_char_count: '完整回复'.length,
      finish_reason: 'stop',
      billing_gate: 'billable',
      billing_mode: 'fixed_tier',
      requested_model: 'anthropic/claude-sonnet-4.5',
      fixed_deduction: 50,
    });
    expect(finalizePending).toHaveBeenCalledWith('charge-1', true);
  });

  it('finish_reason still null: chat_status success, does not finalize quota', async () => {
    const result = await applyLlmCharge(command({ finishReason: null }));

    expect(result.replyOutcome).toBe('complete');
    expect(result.billingChatStatus).toBe('success');
    expect(lastCharge().metadata).toMatchObject({
      chat_status: 'success',
      billing_gate: 'pending_finish_reason',
      finish_reason: null,
    });
    expect(finalizePending).not.toHaveBeenCalled();
  });

  it('success + length keeps chat_status success (HEAD settle, not stream_interrupted)', async () => {
    const result = await applyLlmCharge(command({ finishReason: 'length' }));

    expect(result.replyOutcome).toBe('incomplete');
    expect(result.billingChatStatus).toBe('success');
    expect(lastCharge().metadata).toMatchObject({
      chat_status: 'success',
      reply_outcome: 'incomplete',
      billing_gate: 'non_billable',
      finish_reason: 'length',
    });
    expect(finalizePending).toHaveBeenCalledWith('charge-1', false);
  });

  it('empty reply is labeled empty and still records a charge', async () => {
    const result = await applyLlmCharge(command({ assistantReply: '  ' }));

    expect(result.replyOutcome).toBe('empty');
    expect(result.billingChatStatus).toBe('success');
    expect(lastCharge().metadata).toMatchObject({
      reply_outcome: 'empty',
      reply_char_count: 2,
    });
    expect(finalizePending).toHaveBeenCalledWith('charge-1', false);
  });

  it('upstream_error keeps chat_status and does not bill', async () => {
    const result = await applyLlmCharge(
      command({ generationStatus: 'upstream_error', finishReason: null, generationId: null })
    );

    expect(result.billingChatStatus).toBe('upstream_error');
    expect(lastCharge().metadata).toMatchObject({
      chat_status: 'upstream_error',
      billing_gate: 'non_billable',
    });
    expect(finalizePending).not.toHaveBeenCalled();
  });

  it('routes display name to the observed model when upstream switched providers', async () => {
    await applyLlmCharge(command({ observedModel: 'openai/gpt-5' }));

    expect(lastCharge()).toMatchObject({
      modelOpenRouterId: 'openai/gpt-5',
      modelDisplayName: 'openai/gpt-5',
    });
  });

  it('rethrows charge failures for settle to swallow', async () => {
    chargeLlmUsage.mockRejectedValueOnce(new Error('rpc failed'));
    await expect(applyLlmCharge(command())).rejects.toThrow('rpc failed');
    expect(finalizePending).not.toHaveBeenCalled();
  });
});
