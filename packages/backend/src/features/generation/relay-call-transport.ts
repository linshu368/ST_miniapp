import { randomUUID } from 'node:crypto';
import { RelayProviderSchema } from '@miniapp/shared';
import { isRelayRecord } from '../../infrastructure/relay-provider-client.js';
import { writeRelayCall, type RelayCallObservation } from './relay-call-ledger.js';
import { relayIdentity } from './relay-usage.js';
import type { GenerationRequest, GenerationLogger } from './types.js';

/** Observes exactly the bytes consumed by existing arbitration/transport. Never drains cancelled losers. */
export async function forwardRelayCall(input: {
  request: GenerationRequest;
  signal: AbortSignal;
  log: GenerationLogger;
  dispatch(): Promise<Response>;
}): Promise<Response> {
  const { request, signal, log } = input;
  const provider = RelayProviderSchema.parse(request.model.provider);
  if (!request.historyId) return input.dispatch();
  const started = performance.now();
  const observation: RelayCallObservation = {
    id: request.firstToken?.primaryAttemptId ?? randomUUID(),
    attemptId: request.firstToken?.primaryAttemptId ?? null,
    historyId: request.historyId,
    provider,
    model: request.model.providerModelId,
    lane: request.model.billingContext?.freeZone ? 'free_zone' : 'chat',
    candidateId: request.model.billingContext?.freeZone?.candidateId ?? null,
    dispatchedAt: new Date(),
    requestId: null,
    generationId: null,
    httpStatus: null,
    finishReason: null,
    status: 'unknown',
    usage: null,
    durationMs: null,
  };
  let writes = Promise.resolve();
  let validPayload = false;
  let providerError = false;
  const persist = () => {
    const snapshot = { ...observation };
    writes = writes
      .then(() => writeRelayCall(snapshot))
      .catch((err: unknown) => {
        log.sys.warn(
          { err, event: 'llm.call_record_failed', provider, historyId: observation.historyId },
          '中转平台调用观测写入失败'
        );
      });
  };
  const capture = (value: unknown) => {
    if (!isRelayRecord(value)) return;
    validPayload = true;
    if (value.error) providerError = true;
    observation.generationId ??= relayIdentity(value.id);
    observation.requestId ??= relayIdentity(value.request_id);
    if (isRelayRecord(value.usage)) observation.usage = value.usage;
    const choice =
      Array.isArray(value.choices) && isRelayRecord(value.choices[0]) ? value.choices[0] : null;
    const reason = relayIdentity(choice?.finish_reason);
    if (reason) observation.finishReason = reason.slice(0, 128);
  };
  persist();
  let finalized = false;
  const finish = (status: RelayCallObservation['status']) => {
    if (finalized) return;
    finalized = true;
    signal.removeEventListener('abort', aborted);
    observation.status = status;
    observation.durationMs = Math.max(0, performance.now() - started);
    persist();
    log.biz.info(
      {
        event: 'llm.call_record_completed',
        provider,
        attemptId: observation.attemptId,
        outcome: status,
        historyId: observation.historyId,
        durationMs: observation.durationMs,
      },
      '中转平台调用观测结束'
    );
  };
  const aborted = () => finish('cancelled');
  try {
    const response = await input.dispatch();
    observation.httpStatus = response.status;
    observation.requestId = relayIdentity(
      response.headers.get('x-request-id') ?? response.headers.get('request-id')
    );
    if (!response.ok || !response.body) {
      finish(response.ok ? 'interrupted' : 'failed');
      return response;
    }
    if (signal.aborted) {
      finish('cancelled');
      return response;
    }
    signal.addEventListener('abort', aborted, { once: true });
    return observeRelayBody({
      request,
      response,
      signal,
      capture,
      finish,
      failed: () => providerError || (!request.stream && !validPayload),
    });
  } catch (err) {
    finish(signal.aborted ? 'cancelled' : 'failed');
    throw err;
  }
}

function observeRelayBody({
  request,
  response,
  signal,
  capture,
  finish,
  failed,
}: {
  request: Pick<GenerationRequest, 'stream'>;
  response: Response;
  signal: AbortSignal;
  capture(value: unknown): void;
  finish(status: RelayCallObservation['status']): void;
  failed(): boolean;
}): Response {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let oversized = false;
  let done = false;
  const parse = (text: string) => {
    try {
      capture(JSON.parse(text));
    } catch {
      /* Other SSE events are not usage. */
    }
  };
  const body = new ReadableStream<Uint8Array>(
    {
      async pull(controller) {
        try {
          const part = await reader.read();
          if (part.done) {
            pending += decoder.decode();
            if (!request.stream && !oversized) parse(pending);
            finish(failed() ? 'failed' : !request.stream || done ? 'succeeded' : 'interrupted');
            controller.close();
            reader.releaseLock();
            return;
          }
          pending += decoder.decode(part.value, { stream: true });
          if (request.stream) {
            const lines = pending.split('\n');
            pending = lines.pop() ?? '';
            for (const line of lines)
              if (line.startsWith('data:')) {
                const data = line.slice(5).trim();
                if (data === '[DONE]') done = true;
                else if (data.length <= 32_768) parse(data);
              }
          }
          if (pending.length > (request.stream ? 65_536 : 1_048_576)) {
            oversized = true;
            pending = '';
          }
          controller.enqueue(part.value);
        } catch (err) {
          finish(signal.aborted ? 'cancelled' : 'interrupted');
          controller.error(err);
        }
      },
      async cancel(reason) {
        finish(signal.aborted ? 'cancelled' : 'interrupted');
        await reader.cancel(reason);
      },
    },
    { highWaterMark: 0 }
  );
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
