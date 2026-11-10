import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationLogger, GenerationRequest } from './types.js';
import type { ModelBillingContext } from '../../platform/model-tiers.js';
import type { SseTapResult } from './upstream.js';

const state = vi.hoisted(() => ({
  prepare: vi.fn(),
  saveObservation: vi.fn(),
  ensureGenerationId: vi.fn(),
  settle: vi.fn(),
}));
vi.mock('../../infrastructure/repositories/SurplusIntelligenceChatHistoryRepository.js', () => ({
  SurplusIntelligenceChatHistoryRepository: class {
    prepare = state.prepare;
    saveObservation = state.saveObservation;
    ensureGenerationId = state.ensureGenerationId;
  },
}));
vi.mock('./settle.js', () => ({ settleGeneration: state.settle }));

import { consumeNonStream } from './generation-nonstream.js';
import { consumeStream } from './generation-stream.js';
import { forwardSurplusCall } from './surplus-call-transport.js';

const billing: ModelBillingContext = {
  modelId: 'surplus-model',
  modelDisplayName: 'Surplus Intelligence model',
  provider: 'surplus',
  providerModelId: 'm',
  openRouterModelId: 'm',
  modelTier: 'light',
  catalogVersion: 1,
  isFree: false,
};
const request: GenerationRequest = {
  userId: 'user-1',
  characterId: 'char-1',
  historyId: 'turn-1',
  sessionId: 'session-1',
  model: {
    modelId: 'surplus-model',
    provider: 'surplus',
    providerModelId: 'm',
    openRouterModelId: 'm',
    tier: 'light',
    isFree: false,
    entitlement: { active: false, validUntil: null },
  },
  messages: [{ role: 'user', content: 'private prompt' }],
  sampling: {},
  userInput: 'private prompt',
  stream: false,
  promptCaching: false,
};
const log = {
  sys: { error: vi.fn(), warn: vi.fn() },
  biz: { info: vi.fn(), warn: vi.fn() },
} as unknown as GenerationLogger;

beforeEach(() => {
  vi.clearAllMocks();
  state.prepare.mockResolvedValue(undefined);
  state.saveObservation.mockResolvedValue(undefined);
  state.ensureGenerationId.mockResolvedValue(undefined);
});

describe('Surplus Intelligence non-stream identity failure', () => {
  it('preserves non-stream reply content while removing an invalid credential-shaped body ID', async () => {
    const invalidId = 'inf_sensitive_fixture_value';
    const reply = '完整回复保留';
    const upstreamRes = await forwardSurplusCall({
      request,
      body: { model: 'm', stream: false, messages: request.messages },
      signal: new AbortController().signal,
      log,
      dispatch: async () =>
        Response.json({
          id: invalidId,
          model: 'm',
          choices: [
            { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' },
          ],
        }),
    });
    const finalize = vi.fn(async (_consume: boolean) => null);
    const saveHistory = vi.fn();
    const onError = vi.fn();
    const result = await consumeNonStream({
      request,
      upstreamRes,
      billing,
      chargeId: 'charge-1',
      reservation: { isFreeRound: false, granted: false, finalize },
      headerGenerationId: null,
      saveHistory,
      hooks: { onError },
      log,
      upstreamStartedAt: Date.now(),
    });
    expect(result).toMatchObject({
      status: 'stream_interrupted',
      content: reply,
      generationId: null,
    });
    expect(saveHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        assistant_reply: reply,
        generation_id: null,
        status: 'stream_interrupted',
        finish_reason: 'error',
      })
    );
    expect(finalize).toHaveBeenCalledExactlyOnceWith(false);
    expect(state.ensureGenerationId).not.toHaveBeenCalled();
    expect(
      JSON.stringify([
        result,
        saveHistory.mock.calls,
        state.saveObservation.mock.calls,
        onError.mock.calls,
      ])
    ).not.toContain(invalidId);
    await vi.waitFor(() =>
      expect(state.saveObservation.mock.calls.at(-1)?.[1].call_status).toBe('interrupted')
    );
    const terminal = state.saveObservation.mock.calls.at(-1)?.[1];
    expect(terminal).toMatchObject({
      call_status: 'interrupted',
      response_metadata: {
        capture: { stream_completed: null, identity_conflict: true },
      },
    });
  });

  it('preserves the complete received reply and releases the reservation without a billable outcome', async () => {
    state.ensureGenerationId.mockRejectedValueOnce(new Error('durable identity conflict'));
    const reply = '完整回复仍然保留';
    const upstreamRes = await forwardSurplusCall({
      request,
      body: { model: 'm', stream: false, messages: request.messages },
      signal: new AbortController().signal,
      log,
      dispatch: async () =>
        Response.json({
          id: 'gen-body',
          model: 'm',
          choices: [
            { index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 2, buyer_cost_micro: '0' },
        }),
    });
    const finalize = vi.fn(async () => null);
    const saveHistory = vi.fn();
    const onError = vi.fn();
    const onGenerationId = vi.fn();
    const onBeforeSettle = vi.fn(async (result: SseTapResult) => result);
    const result = await consumeNonStream({
      request,
      upstreamRes,
      billing,
      chargeId: 'charge-1',
      reservation: { isFreeRound: false, granted: false, finalize },
      headerGenerationId: null,
      saveHistory,
      hooks: { onError, onGenerationId, onBeforeSettle },
      log,
      upstreamStartedAt: Date.now(),
    });
    expect(result).toMatchObject({
      status: 'stream_interrupted',
      content: reply,
      finishReason: 'error',
    });
    expect(saveHistory).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        assistant_reply: reply,
        status: 'stream_interrupted',
        finish_reason: 'error',
      })
    );
    expect(onBeforeSettle).toHaveBeenCalledWith(
      expect.objectContaining({
        content: reply,
        completed: false,
        finishReason: 'error',
      }),
      expect.any(Function)
    );
    expect(finalize).toHaveBeenCalledExactlyOnceWith(false);
    expect(onGenerationId).not.toHaveBeenCalled();
    expect(state.settle).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'durable identity conflict' })
    );
    await vi.waitFor(() =>
      expect(state.saveObservation.mock.calls.at(-1)?.[1].call_status).toBe('completed')
    );
    const terminal = state.saveObservation.mock.calls.at(-1)?.[1] as Record<string, unknown>;
    expect(terminal).toMatchObject({
      call_status: 'completed',
      response_metadata: {
        body: { id: 'gen-body' },
        capture: { stream_completed: null },
      },
    });
    expect(JSON.stringify(terminal)).not.toContain(reply);
    expect(JSON.stringify(terminal)).not.toContain('private prompt');
  });
});

describe('Surplus Intelligence diagnostic write isolation', () => {
  it('keeps a valid DONE billable while terminal diagnostics are pending beyond transport EOF', async () => {
    let releaseDiagnostic!: () => void;
    const blockedDiagnostic = new Promise<void>((resolve) => {
      releaseDiagnostic = resolve;
    });
    state.saveObservation.mockImplementationOnce(() => blockedDiagnostic);
    const abort = new AbortController();
    const streamingRequest = { ...request, stream: true };
    const wire =
      'data: {"id":"gen-complete","choices":[{"delta":{"content":"complete reply"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    const upstreamRes = await forwardSurplusCall({
      request: streamingRequest,
      body: { model: 'm', stream: true, messages: request.messages },
      signal: abort.signal,
      log,
      dispatch: async () => new Response(wire),
    });
    const finalize = vi.fn(async (_consume: boolean) => null);
    const saveHistory = vi.fn();
    try {
      const result = await consumeStream({
        request: streamingRequest,
        upstreamRes,
        billing,
        chargeId: 'charge-1',
        reservation: { isFreeRound: false, granted: false, finalize },
        saveHistory,
        log,
        upstreamStartedAt: Date.now(),
        signal: abort.signal,
        deliveryPersisted: Promise.resolve(),
        releaseReservation: async () => {
          await finalize(false);
        },
        headerGenerationId: null,
        observation: {
          startedAt: performance.now(),
          prepared: true,
          directDispatched: false,
          directDispatchedAt: 0,
          provider: 'surplus',
          model: 'm',
        },
      });
      expect(result).toMatchObject({
        status: 'success',
        content: 'complete reply',
        finishReason: 'stop',
      });
      expect(state.saveObservation).toHaveBeenCalledOnce();
      expect(finalize).toHaveBeenCalledExactlyOnceWith(true);
      expect(saveHistory).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          status: 'success',
          assistant_reply: 'complete reply',
          finish_reason: 'stop',
        })
      );
      // The completed transport no longer waits inside the generation deadline for optional metadata.
      abort.abort(new DOMException('later deadline', 'TimeoutError'));
      expect(finalize).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      releaseDiagnostic();
    }
    await vi.waitFor(() =>
      expect(
        state.saveObservation.mock.calls.filter((call) => call[1].call_status === 'completed')
      ).toHaveLength(1)
    );
    expect(state.saveObservation.mock.calls.at(-1)?.[1]).toMatchObject({
      call_status: 'completed',
      response_metadata: { capture: { stream_completed: true } },
    });
  });
});
