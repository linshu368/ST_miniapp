import { randomUUID } from 'node:crypto';
import { FIRST_TOKEN_FALLBACK_MODEL_ID, type LlmModelProvider } from '@miniapp/shared';
import type { AttemptObservation } from '../../infrastructure/repositories/GenerationObservationRepository.js';
import { createLeadingThinkingSplitter, readExposedReasoning } from './upstream.js';

export interface TransportModel {
  provider: LlmModelProvider;
  providerModelId: string;
}
export interface FirstTokenAttemptStore {
  prepareFallback(attempt: AttemptObservation, triggeredMs: number): Promise<void>;
  observe(attempt: AttemptObservation): Promise<void>;
  selectDelivery(attempt: AttemptObservation): Promise<void>;
}

interface Peeked {
  response: Response;
  observation: AttemptObservation;
  replay(): Response;
  stop(): void;
}

export async function forwardWithFirstTokenFallback(input: {
  primary: TransportModel;
  /** Only reasoning actually enabled for browser display may stop the visible-token deadline. */
  thinkingEnabled?: boolean;
  fallbackModelId?: string;
  primaryAttemptId: string;
  timeoutMs: number;
  remainingObservationMs: number;
  requestStartedAt: number;
  signal: AbortSignal;
  store: FirstTokenAttemptStore;
  forward(model: TransportModel, signal: AbortSignal, onDispatch: () => void): Promise<Response>;
  onObservationError(error: unknown): void;
}): Promise<{
  response: Response;
  model: TransportModel;
  role: 'primary' | 'fallback';
  firstTokenAt: number;
}> {
  const fallbackModelId = input.fallbackModelId ?? FIRST_TOKEN_FALLBACK_MODEL_ID;
  input.signal.throwIfAborted();
  const assertBudget = () => {
    input.signal.throwIfAborted();
  };
  const observationDeadline = AbortSignal.timeout(
    Math.max(1, Math.ceil(input.remainingObservationMs))
  );
  const primaryController = new AbortController();
  const fallbackController = new AbortController();
  const primarySignal = AbortSignal.any([
    input.signal,
    observationDeadline,
    primaryController.signal,
  ]);
  const selectedSignal = (controller: AbortController) =>
    AbortSignal.any([input.signal, controller.signal]);
  let switched = false;
  let selected: Peeked | undefined;
  let primaryResult: Peeked | undefined;

  const peek = async (
    model: TransportModel,
    role: 'primary' | 'fallback',
    id: string,
    signal: AbortSignal
  ): Promise<Peeked> => {
    let started = performance.now();
    const observation: AttemptObservation = {
      id,
      role,
      provider: model.provider,
      model: model.providerModelId,
    };
    // Prepared intent is durable before POST; timing writes never delay the actual network call.
    let writes = Promise.resolve();
    const record = () => {
      const snapshot = { ...observation };
      writes = writes.then(() => input.store.observe(snapshot)).catch(input.onObservationError);
    };
    const onDispatch = () => {
      started = performance.now();
      observation.dispatched_at = new Date().toISOString();
      observation.dispatch_offset_ms = started - input.requestStartedAt;
      record();
    };
    let responseBody: ReadableStream<Uint8Array> | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const stop = () => {
      signal.removeEventListener('abort', stop);
      void (reader ? reader.cancel() : responseBody?.cancel())?.catch(() => undefined);
    };
    try {
      const response = await input.forward(model, signal, onDispatch);
      responseBody = response.body;
      observation.headers_ms = performance.now() - started;
      observation.http_status = response.status;
      observation.generation_id = response.headers.get('x-generation-id');
      record();
      if (!response.ok || !response.body) {
        observation.end_reason = 'upstream_error';
        observation.observed_until_ms = performance.now() - started;
        record();
        return { response, observation, stop, replay: () => response };
      }
      reader = response.body.getReader();
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) {
        stop();
        signal.throwIfAborted();
      }
      const chunks: Uint8Array[] = [];
      const decoder = new TextDecoder();
      let buffer = '';
      let bytes = 0;
      let hasVisibleToken = false;
      const splitter = createLeadingThinkingSplitter({
        onContent: (text) => {
          if (text.trim()) hasVisibleToken = true;
        },
        onReasoning: (text) => {
          if (input.thinkingEnabled !== false && readExposedReasoning({ reasoning: text }).trim())
            hasVisibleToken = true;
        },
      });
      while (true) {
        const item = await reader.read();
        signal.throwIfAborted();
        if (item.done && !buffer) break;
        if (!item.done && observation.first_chunk_ms === undefined)
          observation.first_chunk_ms = performance.now() - started;
        if (!item.done) {
          chunks.push(item.value);
          bytes += item.value.byteLength;
        }
        // Bound a provider that emits endless controls or undisplayed reasoning.
        if (bytes > 2 * 1024 * 1024) throw new Error('First-token prelude exceeded limit');
        buffer += item.done
          ? decoder.decode() + '\n'
          : decoder.decode(item.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        let identityObserved = false;
        for (const raw of lines) {
          const line = raw.trimEnd();
          if (!line.startsWith('data:') || line.slice(5).trim() === '[DONE]') continue;
          let value: Record<string, unknown>;
          try {
            value = JSON.parse(line.slice(5).trim()) as typeof value;
          } catch {
            continue;
          }
          if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
          if (!observation.generation_id && typeof value.id === 'string') {
            observation.generation_id = value.id;
            identityObserved = true;
          }
          const choice = Array.isArray(value.choices) ? value.choices[0] : null;
          const delta = choice && typeof choice === 'object' ? choice.delta : null;
          if (!delta || typeof delta !== 'object' || Array.isArray(delta)) continue;
          if (input.thinkingEnabled !== false && readExposedReasoning(delta).trim())
            hasVisibleToken = true;
          if (typeof delta.content === 'string') splitter.push(delta.content);
        }
        if (identityObserved) record();
        if (item.done) splitter.finish();
        if (!hasVisibleToken) {
          if (item.done) break;
          continue;
        }
        observation.first_token_ms = performance.now() - started;
        observation.observed_until_ms = observation.first_token_ms;
        observation.end_reason = 'first_token_observed';
        record();
        const replay = () => {
          const headers = new Headers(response.headers);
          if (observation.generation_id) headers.set('x-generation-id', observation.generation_id);
          let index = 0;
          const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
              try {
                if (index < chunks.length) {
                  controller.enqueue(chunks[index++]);
                  return;
                }
                if (item.done) {
                  signal.removeEventListener('abort', stop);
                  controller.close();
                  return;
                }
                const next = await reader!.read();
                if (next.done) {
                  signal.removeEventListener('abort', stop);
                  controller.close();
                } else controller.enqueue(next.value);
              } catch (error) {
                controller.error(error);
              }
            },
            cancel() {
              stop();
            },
          });
          return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers,
          });
        };
        return { response, observation, stop, replay };
      }
      observation.end_reason = 'stream_interrupted';
      observation.observed_until_ms = performance.now() - started;
      record();
      signal.removeEventListener('abort', stop);
      const headers = new Headers(response.headers);
      headers.delete('x-generation-id');
      return {
        response,
        observation,
        stop,
        replay: () => new Response(null, { status: response.status, headers }),
      };
    } catch (error) {
      observation.observed_until_ms = performance.now() - started;
      observation.end_reason = input.signal.aborted
        ? 'cancelled'
        : signal.aborted
          ? 'observation_deadline'
          : 'upstream_error';
      record();
      stop();
      throw error;
    }
  };

  let thresholdTimer: ReturnType<typeof setTimeout> | undefined;
  const primaryPromise = peek(input.primary, 'primary', input.primaryAttemptId, primarySignal).then(
    (result) => {
      primaryResult = result;
      if (switched) result.stop();
      return result;
    }
  );
  // A late observer rejection must always have a handler after the fallback takes over.
  void primaryPromise.catch(input.onObservationError);
  const abortSignal = input.signal;
  let removeAbort = () => {};
  const abortPromise = new Promise<never>((_, reject) => {
    const abort = () => reject(abortSignal.reason ?? new DOMException('Aborted', 'AbortError'));
    removeAbort = () => abortSignal.removeEventListener('abort', abort);
    if (abortSignal.aborted) abort();
    else abortSignal.addEventListener('abort', abort, { once: true });
  });
  try {
    const threshold = new Promise<null>((resolve) => {
      thresholdTimer = setTimeout(() => resolve(null), input.timeoutMs);
    });
    // Deep-thinking providers may legitimately stay silent before exposing reasoning or an answer.
    // Keep the selected model in that mode; the conversation lifetime signal remains the hard bound.
    const canFallback =
      input.thinkingEnabled !== true &&
      !(
        input.primary.provider === 'openrouter' && input.primary.providerModelId === fallbackModelId
      );
    const primary = await Promise.race([
      primaryPromise,
      ...(canFallback ? [threshold] : []),
      abortPromise,
    ]);
    const model: TransportModel =
      primary === null
        ? { provider: 'openrouter', providerModelId: fallbackModelId }
        : input.primary;
    const role = primary === null ? 'fallback' : 'primary';
    if (primary === null) {
      switched = true;
      const id = randomUUID();
      const attempt: AttemptObservation = {
        id,
        role: 'fallback',
        provider: 'openrouter',
        model: fallbackModelId,
      };
      assertBudget();
      await Promise.race([
        input.store.prepareFallback(attempt, performance.now() - input.requestStartedAt),
        abortPromise,
      ]);
      selected = await Promise.race([
        peek(model, 'fallback', id, selectedSignal(fallbackController)),
        abortPromise,
      ]);
    } else selected = primary;
    assertBudget();
    if (selected.observation.first_token_ms !== undefined) {
      await Promise.race([input.store.selectDelivery(selected.observation), abortPromise]);
    }
    assertBudget();
    return {
      response: selected.replay(),
      model,
      role,
      firstTokenAt:
        input.requestStartedAt +
        (selected.observation.dispatch_offset_ms ?? 0) +
        (selected.observation.first_token_ms ?? 0),
    };
  } catch (error) {
    primaryController.abort(error);
    fallbackController.abort(error);
    primaryResult?.stop();
    selected?.stop();
    throw error;
  } finally {
    removeAbort();
    clearTimeout(thresholdTimer);
  }
}
