import { MAX_CONVERSATION_REASONING_LENGTH } from '@miniapp/shared';
import type { ModelBillingContext } from '../../platform/model-tiers.js';
import { SurplusIntelligenceChatHistoryRepository } from '../../infrastructure/repositories/SurplusIntelligenceChatHistoryRepository.js';
import { safeSurplusIdentity } from './surplus-response-schema.js';
import type { FreeQuotaReservation } from './quota.js';
import {
  readExposedReasoning,
  createLeadingThinkingSplitter,
  type SseTapResult,
} from './upstream.js';
import { toError, type SaveHistory } from './generation-settlement.js';
import type {
  GenerationRequest,
  GenerationResult,
  GenerationHooks,
  GenerationLogger,
} from './types.js';

type NonStreamInput = {
  request: GenerationRequest;
  upstreamRes: Response;
  billing: ModelBillingContext;
  chargeId: string | null;
  reservation: FreeQuotaReservation;
  headerGenerationId: string | null;
  saveHistory: SaveHistory;
  hooks?: GenerationHooks;
  log: GenerationLogger;
  upstreamStartedAt: number;
};

export async function consumeNonStream(input: NonStreamInput): Promise<GenerationResult> {
  const { request, upstreamRes, billing, chargeId, reservation, saveHistory, hooks, log } = input;
  let generationId = input.headerGenerationId;

  let responseBody: string;
  try {
    responseBody = await upstreamRes.text();
  } catch (err) {
    await reservation.finalize(false);
    log.sys.error(
      { event: 'llm.upstream.body_read_failed', err, userId: request.userId },
      'failed to read non-streaming upstream response'
    );
    hooks?.onError?.(toError(err));
    return {
      status: 'upstream_error',
      content: '',
      generationId,
      finishReason: null,
      chargeId: null,
      modelId: billing.modelId,
      modelOpenRouterId: billing.openRouterModelId,
    };
  }

  const parsed = parseResponse(
    responseBody,
    request.userId,
    log,
    generationId,
    billing.provider === 'surplus'
  );
  const {
    assistantReply,
    finishReason,
    responseParsed,
    usage,
    responseMetadata,
    exposedReasoning,
  } = parsed;
  generationId = parsed.generationId;

  if (!responseParsed) {
    await reservation.finalize(false);
    saveHistory({
      assistant_reply: null,
      status: 'upstream_error',
      upstream_status: upstreamRes.status,
      generation_id: generationId,
      finish_reason: null,
    });
    return {
      status: 'upstream_error',
      content: '',
      generationId,
      finishReason: null,
      chargeId: null,
      modelId: billing.modelId,
      modelOpenRouterId: billing.openRouterModelId,
      upstreamStatus: upstreamRes.status,
    };
  }

  const identityFailure = await confirmIdentity(input, parsed);
  if (identityFailure) return identityFailure;

  const hasContent = typeof assistantReply === 'string' && assistantReply.trim().length > 0;
  const truncated =
    billing.provider === 'surplus' && upstreamRes.headers.get('x-si-truncated') === '1';
  const delivered = responseParsed && hasContent && !truncated;
  const billable = delivered && finishReason === 'stop';
  const waitingForFinishReason =
    billing.provider === 'openrouter' && delivered && finishReason === null;
  if (!waitingForFinishReason) {
    await reservation.finalize(billable);
  }
  const status =
    delivered && (finishReason === 'stop' || finishReason === null)
      ? 'success'
      : 'stream_interrupted';
  saveHistory({
    assistant_reply: assistantReply,
    status,
    upstream_status: null,
    generation_id: generationId,
    finish_reason: finishReason,
    provider_response:
      billing.provider === 'venice'
        ? {
            usage,
            responseMetadata,
            latencyMs: null,
            generationTimeMs: Math.max(0, Date.now() - input.upstreamStartedAt),
          }
        : undefined,
  });
  const reasoningIsFirstToken =
    request.thinkingEnabled !== false && exposedReasoning.trim().length > 0;
  if (reasoningIsFirstToken) hooks?.onFirstToken?.();
  if (request.thinkingEnabled !== false && exposedReasoning)
    hooks?.onReasoningDelta?.(exposedReasoning);
  if (assistantReply) {
    if (!reasoningIsFirstToken) hooks?.onFirstToken?.();
    hooks?.onDelta?.(assistantReply);
  }
  return {
    status,
    content: assistantReply ?? '',
    generationId,
    finishReason,
    chargeId,
    modelId: billing.modelId,
    modelOpenRouterId: billing.openRouterModelId,
  };
}

function parseResponse(
  responseBody: string,
  userId: string,
  log: GenerationLogger,
  headerGenerationId: string | null,
  surplus: boolean
) {
  let generationId = headerGenerationId;
  let bodyGenerationId: string | null = null;
  let invalidIdentity = false;
  let assistantReply: string | null = null;
  let finishReason: string | null = null;
  let responseParsed = false;
  let usage: Record<string, unknown> | null = null;
  let responseMetadata: Record<string, unknown> = {};
  let exposedReasoning = '';
  try {
    const parsed = JSON.parse(responseBody);
    responseParsed = true;
    if (
      surplus &&
      parsed?.id !== undefined &&
      parsed.id !== null &&
      !safeSurplusIdentity(parsed.id)
    )
      invalidIdentity = true;
    else if (typeof parsed?.id === 'string') bodyGenerationId = parsed.id;
    if (!generationId) generationId = bodyGenerationId;
    const choice = parsed?.choices?.[0];
    if (choice?.message && typeof choice.message === 'object' && !Array.isArray(choice.message)) {
      exposedReasoning = readExposedReasoning(choice.message).slice(
        0,
        MAX_CONVERSATION_REASONING_LENGTH
      );
      const hasStructuredReasoning = exposedReasoning.length > 0;
      if (typeof choice.message.content === 'string') {
        const content: string[] = [];
        const splitter = createLeadingThinkingSplitter({
          onContent: (text) => content.push(text),
          onReasoning: (text) => {
            if (!hasStructuredReasoning)
              exposedReasoning += text.slice(
                0,
                MAX_CONVERSATION_REASONING_LENGTH - exposedReasoning.length
              );
          },
        });
        splitter.push(choice.message.content, !hasStructuredReasoning);
        splitter.finish();
        assistantReply = content.join('');
      }
    }
    if (typeof choice?.finish_reason === 'string') finishReason = choice.finish_reason;
    if (parsed?.usage && typeof parsed.usage === 'object' && !Array.isArray(parsed.usage)) {
      usage = parsed.usage as Record<string, unknown>;
    }
    responseMetadata = Object.fromEntries(
      ['id', 'object', 'created', 'model', 'usage', 'venice_parameters'].flatMap((key) =>
        key in parsed ? [[key, parsed[key]]] : []
      )
    );
  } catch {
    log.sys.warn(
      { event: 'llm.upstream.invalid_non_stream_response', userId: userId },
      'successful upstream response was not valid JSON'
    );
  }

  return {
    assistantReply,
    finishReason,
    responseParsed,
    usage,
    responseMetadata,
    exposedReasoning,
    generationId,
    bodyGenerationId,
    invalidIdentity,
  };
}

async function confirmIdentity(
  input: NonStreamInput,
  parsed: ReturnType<typeof parseResponse>
): Promise<GenerationResult | null> {
  const {
    generationId,
    bodyGenerationId,
    invalidIdentity,
    assistantReply,
    usage,
    responseMetadata,
  } = parsed;
  const { hooks, reservation, saveHistory, billing, chargeId } = input;
  if (
    invalidIdentity ||
    (generationId && (generationId !== input.headerGenerationId || billing.provider === 'surplus'))
  ) {
    try {
      if (invalidIdentity) throw new Error('Surplus response identity is invalid');
      if (billing.provider === 'surplus' && input.request.historyId) {
        if (bodyGenerationId && bodyGenerationId !== generationId)
          throw new Error('Surplus generation identity differs between header and body');
        if (generationId)
          await new SurplusIntelligenceChatHistoryRepository().ensureGenerationId(
            input.request.historyId,
            generationId
          );
      }
      if (generationId) await hooks?.onGenerationId?.(generationId);
    } catch (err) {
      // The complete body has already been read. Preserve it even when identity
      // storage fails; the local failure must not erase an observed response.
      const release = async () => {
        await reservation.finalize(false);
      };
      await release();
      const observed: SseTapResult = {
        completed: false,
        content: assistantReply ?? '',
        deltaCount: assistantReply ? 1 : 0,
        generationId,
        finishReason: 'error',
        usage,
        responseMetadata,
      };
      const outcome = hooks?.onBeforeSettle
        ? await hooks.onBeforeSettle(observed, release)
        : observed;
      saveHistory({
        assistant_reply: outcome.content || null,
        status: 'stream_interrupted',
        upstream_status: null,
        generation_id: generationId,
        finish_reason: outcome.finishReason,
      });
      hooks?.onError?.(toError(err));
      return {
        status: 'stream_interrupted',
        content: outcome.content,
        generationId,
        finishReason: outcome.finishReason,
        chargeId,
        modelId: billing.modelId,
        modelOpenRouterId: billing.openRouterModelId,
      };
    }
  }

  return null;
}
