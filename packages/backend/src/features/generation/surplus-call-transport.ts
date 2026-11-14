import type { GenerationLogger, GenerationRequest } from './types.js';
import type { PersistGate } from './first-token-fallback.js';
import type { SurplusReasoningResolution } from './surplus-reasoning.js';
import {
  SurplusIntelligenceChatHistoryRepository,
  type SurplusObservationPatch,
} from '../../infrastructure/repositories/SurplusIntelligenceChatHistoryRepository.js';
import {
  SurplusResponseCapture,
  sanitizeSurplusRequestParameters,
} from './surplus-response-capture.js';

type CallInput = {
  request: GenerationRequest;
  body: Record<string, unknown>;
  signal: AbortSignal;
  log: GenerationLogger;
  dispatch: () => Promise<Response>;
  reasoning?: SurplusReasoningResolution;
  /** 多路主请求时才有：这一轮只有一行 Surplus 调用记录，分出胜负后只写胜出那一路 */
  gate?: PersistGate;
};

type SurplusCallWrites = Pick<
  SurplusIntelligenceChatHistoryRepository,
  'prepare' | 'ensureGenerationId' | 'saveObservation'
>;

/**
 * 多路主请求共用一行调用记录，而记录里的调用 ID 一旦写入就不能改：分出胜负前的写入先排队、
 * 立即返回（不能卡住读流，否则谁都出不了字），定下来后胜出那一路按原顺序补写，其余丢弃。
 * 准备记录（请求参数）每一路都相同、可重复，照常直接写。
 */
function gatedWrites(
  repository: SurplusIntelligenceChatHistoryRepository,
  gate: PersistGate,
  log: GenerationLogger,
  historyId: string
): SurplusCallWrites {
  let chain: Promise<boolean> = gate.owns();
  const later = (write: () => Promise<void>): Promise<void> => {
    chain = chain.then(async (owns) => {
      if (owns)
        await write().catch((err: unknown) =>
          log.sys.error(
            { err, event: 'chathistory.surplus_metadata.failed', historyId },
            'Surplus call metadata could not be confirmed'
          )
        );
      return owns;
    });
    return Promise.resolve();
  };
  return {
    prepare: (input) => repository.prepare(input),
    ensureGenerationId: (id, generationId) =>
      later(() => repository.ensureGenerationId(id, generationId)),
    saveObservation: (id, patch) => later(() => repository.saveObservation(id, patch)),
  };
}

/** Observe the original attempt before the first-token race can cancel a loser.
 * No conversation bytes are persisted here; downstream receives the original bytes. */
export async function forwardSurplusCall(input: CallInput): Promise<Response> {
  if (!input.request.historyId) return input.dispatch();
  const historyId = input.request.historyId;
  const direct = new SurplusIntelligenceChatHistoryRepository();
  const repository: SurplusCallWrites = input.gate
    ? gatedWrites(direct, input.gate, input.log, historyId)
    : direct;
  const capture = new SurplusResponseCapture();
  if (input.reasoning)
    capture.recordReasoningControl({
      ...input.reasoning,
      requestedEnabled: input.request.thinkingEnabled ?? true,
    });
  await repository.prepare({
    historyId,
    attemptId: input.request.firstToken?.primaryAttemptId,
    requestParameters: sanitizeSurplusRequestParameters(input.body),
  });
  input.signal.throwIfAborted();
  const startedAt = performance.now();
  const writes = createObservationQueue(input, repository, historyId);
  writes.queueObservation({ call_status: 'dispatched' });
  let response: Response;
  try {
    response = await input.dispatch();
  } catch (err) {
    capture.unavailable('headers', input.signal.aborted ? 'interrupted' : 'network');
    writes.queueObservation({
      call_status: input.signal.aborted ? 'interrupted' : 'failed',
      ...terminalPatch(capture),
      generation_time_ms: Math.max(0, performance.now() - startedAt),
    });
    await writes.flushObservations();
    throw err;
  }
  capture.headers(response.headers);
  if (!response.ok)
    return observeHttpError({
      ...input,
      ...writes,
      response,
      repository,
      historyId,
      capture,
      startedAt,
    });
  try {
    return await observeResponse({
      ...input,
      ...writes,
      response,
      repository,
      historyId,
      capture,
      startedAt,
    });
  } catch (err) {
    capture.unavailable('headers', 'invalid');
    writes.queueObservation({
      ...terminalPatch(capture),
      call_status: 'failed',
      http_status: response.status,
    });
    await writes.flushObservations();
    throw err;
  }
}

type ObservationInput = CallInput & {
  response: Response;
  repository: SurplusCallWrites;
  historyId: string;
  capture: SurplusResponseCapture;
  startedAt: number;
  queueObservation(patch: SurplusObservationPatch): void;
  flushObservations(): Promise<void>;
};

function createObservationQueue(
  input: Pick<CallInput, 'log'>,
  repository: SurplusCallWrites,
  historyId: string
) {
  let pending = Promise.resolve();
  return {
    queueObservation(patch: SurplusObservationPatch) {
      pending = pending.then(() => saveSafely(input, repository, historyId, patch));
    },
    flushObservations: () => pending,
  };
}

function projectionPatch(capture: SurplusResponseCapture): SurplusObservationPatch {
  const value = capture.projection();
  const metadata = capture.snapshot();
  const status = (metadata.capture as { status?: unknown } | undefined)?.status;
  return {
    generation_id: value.generationId,
    request_id: value.requestId,
    model: value.model,
    provider_name: value.providerName,
    error_code: value.errorCode,
    finish_reason: value.finishReason,
    prompt_tokens: value.promptTokens,
    completion_tokens: value.completionTokens,
    total_tokens: value.totalTokens,
    cached_tokens: value.cachedTokens,
    reasoning_tokens: value.reasoningTokens,
    buyer_cost_micro: value.buyerCostMicro,
    usage_usd: value.usageUsd,
    response_metadata: metadata,
    metadata_capture_status: status === 'complete' || status === 'unavailable' ? status : 'partial',
  };
}

function terminalPatch(capture: SurplusResponseCapture): SurplusObservationPatch {
  const requestId = capture.projection().requestId;
  if (!requestId) capture.unavailable('request_record', 'missing_id');
  return {
    ...projectionPatch(capture),
    request_record_status: requestId ? 'pending' : 'unavailable',
  };
}

async function saveSafely(
  input: Pick<CallInput, 'log'>,
  repository: SurplusCallWrites,
  historyId: string,
  patch: SurplusObservationPatch
): Promise<void> {
  try {
    await repository.saveObservation(historyId, patch);
  } catch (err) {
    // Diagnostic failure never replays a billable POST or changes a delivered reply.
    input.log.sys.error(
      { err, event: 'chathistory.surplus_metadata.failed', historyId },
      'Surplus call metadata could not be confirmed'
    );
  }
}

/** Error callers cancel the body immediately. Capture safe error fields before handing it back. */
async function observeHttpError(input: ObservationInput): Promise<Response> {
  const { response, capture, repository, historyId } = input;
  const reader = response.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let timedOut = false;
    let overLimit = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      void reader.cancel().catch(() => undefined);
    }, 5_000);
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 64 * 1024) {
          overLimit = true;
          break;
        }
        chunks.push(chunk.value);
      }
      if (timedOut || overLimit) capture.unavailable('body', timedOut ? 'timeout' : 'over_limit');
      else {
        try {
          capture.observe(JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')), 'body');
        } catch {
          capture.unavailable('body', 'invalid');
        }
      }
    } catch {
      capture.unavailable('body', 'network');
    } finally {
      clearTimeout(timeout);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  } else capture.unavailable('body', 'http_error');
  const generationId = capture.projection().generationId;
  if (generationId) await repository.ensureGenerationId(historyId, generationId);
  input.queueObservation({
    ...terminalPatch(capture),
    http_status: response.status,
    call_status: 'failed',
    generation_time_ms: Math.max(0, performance.now() - input.startedAt),
  });
  await input.flushObservations();
  return new Response(null, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function confirmHeaders(input: ObservationInput): Promise<string | null> {
  const { response, repository, historyId, capture } = input;
  if (capture.identityConflict) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('Surplus response identity is invalid');
  }
  const headerId = capture.projection().generationId;
  if (headerId) await repository.ensureGenerationId(historyId, headerId);
  // Preserve the request-log identity before a restart can lose an in-flight response.
  input.queueObservation({
    ...projectionPatch(capture),
    http_status: response.status,
    call_status: 'dispatched',
  });
  return headerId;
}

async function observeResponse(input: ObservationInput): Promise<Response> {
  const { response, capture } = input;
  const headerId = await confirmHeaders(input);
  let identity = headerId;
  let identityWork = Promise.resolve();
  let identityError: unknown;
  let ended = false;
  let firstTokenMs: number | null = null;
  let buffered = '';
  let terminal: Promise<void> | undefined;
  const finish = (completed: boolean): Promise<void> => {
    terminal ??= (async () => {
      if (input.request.stream) capture.finish(completed);
      const patch = terminalPatch(capture);
      // Conflicting identity is preserved in controlled evidence, never written over the frozen ID.
      if (identityError) delete patch.generation_id;
      input.queueObservation({
        ...patch,
        http_status: response.status,
        call_status: !response.ok
          ? 'failed'
          : completed && !capture.identityConflict && !capture.projection().truncated
            ? 'completed'
            : 'interrupted',
        latency_ms: firstTokenMs,
        generation_time_ms: Math.max(0, performance.now() - input.startedAt),
      });
      // EOF is a billing fact. Optional diagnostic I/O must not push a received
      // [DONE] beyond the generation deadline; queued writes own their bounded errors.
    })();
    return terminal;
  };
  const observe = async (value: unknown, source: 'stream' | 'body') => {
    capture.observe(value, source);
    if (
      source === 'stream' &&
      (capture.identityConflict || (headerId && capture.projection().generationId !== headerId))
    ) {
      identityError = new Error('Surplus call identity conflict');
      throw identityError;
    }
    const next = capture.projection().generationId;
    // Non-stream text() must finish so its consumer can preserve the full reply on ID failure.
    if (source === 'stream' && next && next !== identity) {
      const firstFrame = projectionPatch(capture);
      identityWork = identityWork.then(() => persistIdentity(input, next, firstFrame));
      // Observe rejection immediately; bytes already received must reach the existing text snapshot first.
      void identityWork.catch((err: unknown) => {
        identityError = err;
      });
      identity = next;
    }
    if (firstTokenMs === null && containsContent(value))
      firstTokenMs = Math.max(0, performance.now() - input.startedAt);
  };
  const consume = async (text: string, flush: boolean) => {
    buffered += text;
    if (buffered.length > 1_048_576) {
      capture.unavailable(input.request.stream ? 'stream' : 'body', 'over_limit');
      buffered = '';
      return;
    }
    if (!input.request.stream || !response.ok) {
      if (flush) {
        try {
          await observe(JSON.parse(buffered), 'body');
          ended = response.ok;
        } catch (err) {
          if (err instanceof SyntaxError) capture.unavailable('body', 'invalid');
          else throw err;
        }
      }
      return;
    }
    const lines = buffered.split('\n');
    buffered = flush ? '' : (lines.pop() ?? '');
    for (const original of lines) {
      const line = original.replace(/\r$/, '');
      if (line.startsWith(':')) capture.comment(line);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        ended = true;
        capture.comment('[DONE]');
      } else if (data) {
        try {
          await observe(JSON.parse(data), 'stream');
        } catch (err) {
          if (err instanceof SyntaxError) capture.unavailable('stream', 'invalid');
          else throw err;
        }
      }
    }
  };
  return observeReader(response, {
    consume,
    confirm: async () => {
      await identityWork;
      if (identityError) throw identityError;
    },
    complete: () => finish(ended),
    interrupt: async () => {
      await finish(false);
    },
  });
}

async function observeReader(
  response: Response,
  callbacks: {
    consume(text: string, flush: boolean): Promise<void>;
    confirm(): Promise<void>;
    complete(): Promise<void>;
    interrupt(err?: unknown): Promise<void>;
  }
): Promise<Response> {
  if (!response.body) {
    await callbacks.interrupt();
    return response;
  }
  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          await callbacks.consume(decoder.decode(), true);
          await callbacks.confirm();
          await callbacks.complete();
          controller.close();
        } else {
          await callbacks.consume(decoder.decode(item.value, { stream: true }), false);
          controller.enqueue(item.value);
          await callbacks.confirm();
        }
      } catch (err) {
        await reader.cancel().catch(() => undefined);
        await callbacks.interrupt(err);
        controller.error(err);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason).catch(() => undefined);
      await callbacks.interrupt(reason);
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

async function persistIdentity(
  input: ObservationInput,
  generationId: string,
  patch: SurplusObservationPatch
): Promise<void> {
  await input.repository.ensureGenerationId(input.historyId, generationId);
  input.queueObservation(patch);
}

function containsContent(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('choices' in value)) return false;
  const choices = value.choices;
  if (!Array.isArray(choices)) return false;
  return choices.some((choice: unknown) => {
    if (!choice || typeof choice !== 'object') return false;
    const message = 'delta' in choice ? choice.delta : 'message' in choice ? choice.message : null;
    return (
      !!message &&
      typeof message === 'object' &&
      'content' in message &&
      typeof message.content === 'string' &&
      message.content.trim().length > 0
    );
  });
}
