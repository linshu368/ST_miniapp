import { randomUUID } from 'node:crypto';
import {
  DEFAULT_FALLBACK_TOKEN_TIMEOUT_MS,
  FIRST_TOKEN_FALLBACK_MODEL_ID,
  type LlmModelProvider,
} from '@miniapp/shared';
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

/** Stage and total deadlines are different facts; neither is the response lifetime. */
export class FirstTokenDeadlineError extends Error {
  constructor(readonly stage: 'global' | 'primary' | 'fallback' = 'global') {
    super('这次响应有点慢，请重试。');
    this.name = 'FirstTokenDeadlineError';
  }
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
  deferPersistence?: boolean;
  onReady?: () => void;
  fallbackModelId?: string;
  primaryAttemptId: string;
  timeoutMs: number;
  fallbackTimeoutMs?: number;
  remainingFirstTokenMs: number;
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
  deliveryPersisted: Promise<void>;
}> {
  const fallbackModelId = input.fallbackModelId ?? FIRST_TOKEN_FALLBACK_MODEL_ID;
  input.signal.throwIfAborted();
  if (input.remainingFirstTokenMs <= 0) throw new FirstTokenDeadlineError();
  const deadlineAt = performance.now() + input.remainingFirstTokenMs;
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(
    () => deadline.abort(new FirstTokenDeadlineError()),
    input.remainingFirstTokenMs
  );
  const assertBudget = () => {
    input.signal.throwIfAborted();
    deadline.signal.throwIfAborted();
    if (performance.now() >= deadlineAt) throw new FirstTokenDeadlineError();
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
  let thresholdTimer: ReturnType<typeof setTimeout> | undefined;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  let fallbackDeadlineAt: number | undefined;
  let primaryDeadlineAt: number | undefined;
  let triggerFallback: () => void = () => {};
  const threshold = new Promise<null>((resolve) => {
    triggerFallback = () => resolve(null);
  });
  const canFallback = !(
    input.primary.provider === 'openrouter' && input.primary.providerModelId === fallbackModelId
  );
  let switched = false;
  let selected: Peeked | undefined;
  let primaryResult: Peeked | undefined;
  let fallbackPrepared = Promise.resolve();

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
      writes = writes
        .then(async () => {
          if (role === 'fallback') await fallbackPrepared;
          await input.store.observe(snapshot);
        })
        .catch(input.onObservationError);
    };
    const onDispatch = () => {
      started = performance.now();
      observation.dispatched_at = new Date().toISOString();
      observation.dispatch_offset_ms = started - input.requestStartedAt;
      record();
      // Route lookup is engineering overhead. Model waits begin only at the actual POST.
      if (role === 'primary') {
        const remaining = deadlineAt - started;
        const wait = canFallback
          ? Math.min(
              input.timeoutMs,
              Math.max(
                0,
                remaining - (input.fallbackTimeoutMs ?? DEFAULT_FALLBACK_TOKEN_TIMEOUT_MS)
              )
            )
          : input.timeoutMs;
        primaryDeadlineAt = started + wait;
        thresholdTimer = setTimeout(
          canFallback
            ? triggerFallback
            : () => deadline.abort(new FirstTokenDeadlineError('primary')),
          wait
        );
      } else if (role === 'fallback') {
        const wait = input.fallbackTimeoutMs ?? DEFAULT_FALLBACK_TOKEN_TIMEOUT_MS;
        fallbackDeadlineAt = started + wait;
        fallbackTimer = setTimeout(
          () => fallbackController.abort(new FirstTokenDeadlineError('fallback')),
          wait
        );
      }
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
      let terminal = false;
      let terminalReason: 'upstream_error' | 'stream_interrupted' = 'stream_interrupted';
      let eventType = '';
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
          if (!line) {
            eventType = '';
            continue;
          }
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
            continue;
          }
          if (!line.startsWith('data:')) continue;
          if (eventType === 'error') {
            terminal = true;
            terminalReason = 'upstream_error';
            break;
          }
          if (line.slice(5).trim() === '[DONE]') {
            terminal = true;
            break;
          }
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
          if (value.error != null || choice?.error != null || value.type === 'error') {
            terminal = true;
            terminalReason = 'upstream_error';
            break;
          }
          const delta = choice && typeof choice === 'object' ? choice.delta : null;
          if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
            if (input.thinkingEnabled !== false && readExposedReasoning(delta).trim())
              hasVisibleToken = true;
            if (typeof delta.content === 'string') splitter.push(delta.content);
            if (typeof delta.refusal === 'string' && delta.refusal.trim()) {
              terminal = true;
              terminalReason = 'upstream_error';
            }
          }
          if (typeof choice?.finish_reason === 'string' && choice.finish_reason) terminal = true;
          if (terminal) break;
        }
        if (identityObserved) record();
        if (item.done || terminal) splitter.finish();
        if (!hasVisibleToken) {
          if (item.done || terminal) break;
          continue;
        }
        // Event-loop delay may deliver bytes before an overdue timer callback runs.
        // Compare the absolute stage deadline so late bytes cannot steal delivery.
        if (
          role === 'primary' &&
          primaryDeadlineAt !== undefined &&
          performance.now() >= primaryDeadlineAt
        ) {
          if (canFallback) triggerFallback();
          else throw new FirstTokenDeadlineError('primary');
        }
        if (
          role === 'fallback' &&
          fallbackDeadlineAt !== undefined &&
          performance.now() >= fallbackDeadlineAt
        )
          throw new FirstTokenDeadlineError('fallback');
        if (role === 'fallback') clearTimeout(fallbackTimer);
        else clearTimeout(thresholdTimer);
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
      observation.end_reason = terminalReason;
      observation.observed_until_ms = performance.now() - started;
      record();
      // An explicit terminal frame may arrive long before the provider closes its socket.
      stop();
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
      observation.end_reason =
        error instanceof FirstTokenDeadlineError || signal.reason instanceof FirstTokenDeadlineError
          ? 'first_token_deadline'
          : input.signal.aborted
            ? 'cancelled'
            : signal.aborted
              ? 'observation_deadline'
              : 'upstream_error';
      record();
      stop();
      throw error;
    }
  };

  const skipPrimary =
    canFallback &&
    deadlineAt - performance.now() <=
      (input.fallbackTimeoutMs ?? DEFAULT_FALLBACK_TOKEN_TIMEOUT_MS);
  if (skipPrimary)
    void input.store
      .observe({
        id: input.primaryAttemptId,
        role: 'primary',
        provider: input.primary.provider,
        model: input.primary.providerModelId,
        end_reason: 'budget_skipped',
      })
      .catch(input.onObservationError);
  const primaryPromise: Promise<Peeked | null> = skipPrimary
    ? Promise.resolve(null)
    : peek(input.primary, 'primary', input.primaryAttemptId, primarySignal)
        .then((result) => {
          primaryResult = result;
          if (switched || result.observation.first_token_ms === undefined) result.stop();
          // A failed primary has nothing left worth waiting for. Reuse the single fallback
          // path even when both model IDs match: a known failure permits one bounded retry.
          return result.observation.first_token_ms === undefined ? null : result;
        })
        .catch((error: unknown) => {
          if (
            primarySignal.aborted ||
            deadline.signal.aborted ||
            error instanceof FirstTokenDeadlineError
          )
            throw error;
          return null;
        });
  // A late observer rejection must always have a handler after the fallback takes over.
  void primaryPromise.catch(input.onObservationError);
  const abortSignal = AbortSignal.any([input.signal, deadline.signal, fallbackController.signal]);
  let removeAbort = () => {};
  const abortPromise = new Promise<never>((_, reject) => {
    const abort = () => reject(abortSignal.reason ?? new DOMException('Aborted', 'AbortError'));
    removeAbort = () => abortSignal.removeEventListener('abort', abort);
    if (abortSignal.aborted) abort();
    else abortSignal.addEventListener('abort', abort, { once: true });
  });
  try {
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
      clearTimeout(thresholdTimer);
      const id = randomUUID();
      const attempt: AttemptObservation = {
        id,
        role: 'fallback',
        provider: 'openrouter',
        model: fallbackModelId,
      };
      assertBudget();
      fallbackPrepared = input.store.prepareFallback(
        attempt,
        performance.now() - input.requestStartedAt
      );
      void fallbackPrepared.catch(input.onObservationError);
      if (!input.deferPersistence) await Promise.race([fallbackPrepared, abortPromise]);
      selected = await Promise.race([
        peek(model, 'fallback', id, selectedSignal(fallbackController)),
        abortPromise,
      ]);
    } else selected = primary;
    assertBudget();
    let deliveryPersisted = Promise.resolve();
    if (selected.observation.first_token_ms !== undefined) {
      input.onReady?.();
      // Once a usable token wins within budget, identity storage may not eat its delivery time.
      deliveryPersisted = fallbackPrepared.then(() =>
        input.store.selectDelivery(selected!.observation)
      );
      void deliveryPersisted.catch(input.onObservationError);
      if (!input.deferPersistence) {
        await Promise.race([deliveryPersisted, abortPromise]);
        assertBudget();
      }
    }
    return {
      deliveryPersisted,
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
    clearTimeout(fallbackTimer);
    clearTimeout(deadlineTimer);
  }
}
