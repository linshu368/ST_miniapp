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

/** The total first-token deadline is separate from the selected response's lifetime. */
export class FirstTokenDeadlineError extends Error {
  constructor(readonly stage: 'global' | 'primary' | 'fallback' = 'global') {
    super('这次响应有点慢，请重试。');
    this.name = 'FirstTokenDeadlineError';
  }
}

class LostFirstTokenRace extends Error {}

interface Peeked {
  response: Response;
  observation: AttemptObservation;
  replay(): Response;
}

interface Attempt {
  model: TransportModel;
  observation: AttemptObservation;
  controller: AbortController;
  signal: AbortSignal;
  prepared: Promise<void>;
  startedAt: number;
  finished: boolean;
  recorded: boolean;
  writes: Promise<void>;
  content: string;
  reasoning: string;
  truncated: boolean;
  stop(): void;
}

const DIAGNOSTIC_TEXT_LIMIT = 2048;

export async function forwardWithFirstTokenFallback(input: {
  primary: TransportModel;
  /** Only reasoning enabled for browser display can win delivery. */
  thinkingEnabled?: boolean;
  deferPersistence?: boolean;
  onReady?: () => void;
  fallbackModelId?: string;
  primaryAttemptId: string;
  /** Starts the other attempt; it never expires an already dispatched primary. */
  timeoutMs: number;
  /** Reserve for starting fallback when preparation has used most of the total budget. */
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
  input.signal.throwIfAborted();
  if (input.remainingFirstTokenMs <= 0) throw new FirstTokenDeadlineError();
  const fallbackModelId = input.fallbackModelId ?? FIRST_TOKEN_FALLBACK_MODEL_ID;
  const reserveMs = input.fallbackTimeoutMs ?? DEFAULT_FALLBACK_TOKEN_TIMEOUT_MS;
  const deadlineAt = performance.now() + input.remainingFirstTokenMs;
  const differentModels = !(
    input.primary.provider === 'openrouter' && input.primary.providerModelId === fallbackModelId
  );
  let thresholdTimer: ReturnType<typeof setTimeout> | undefined;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  let primary: Attempt | undefined;
  let fallback: Attempt | undefined;
  let lastFailure: { attempt: Attempt; result?: Peeked; error?: unknown } | undefined;
  let resolveSelected!: (value: { attempt: Attempt; result: Peeked }) => void;
  let rejectSelected!: (reason: unknown) => void;
  const selection = new Promise<{ attempt: Attempt; result: Peeked }>((resolve, reject) => {
    resolveSelected = resolve;
    rejectSelected = reject;
  });
  const clearFirstTokenTimers = () => {
    clearTimeout(thresholdTimer);
    clearTimeout(deadlineTimer);
  };
  const assertBudget = () => {
    input.signal.throwIfAborted();
    if (performance.now() >= deadlineAt) throw new FirstTokenDeadlineError();
  };
  const record = (attempt: Attempt) => {
    const snapshot = { ...attempt.observation };
    attempt.writes = attempt.writes
      .then(async () => {
        await attempt.prepared;
        await input.store.observe(snapshot);
      })
      .catch(input.onObservationError);
  };
  const recordTerminal = (attempt: Attempt, reason: AttemptObservation['end_reason']) => {
    if (attempt.recorded) return;
    attempt.recorded = true;
    attempt.observation.end_reason = reason;
    if (attempt.observation.dispatched_at)
      attempt.observation.observed_until_ms = performance.now() - attempt.startedAt;
    if (attempt.controller.signal.reason instanceof LostFirstTokenRace) {
      attempt.observation.discarded_response = {
        reason: 'race_lost',
        content: attempt.content,
        reasoning: attempt.reasoning,
        truncated: attempt.truncated,
      };
    }
    record(attempt);
  };
  const abortAttempt = (attempt: Attempt | undefined, reason: unknown) => {
    if (!attempt || attempt.controller.signal.aborted) return;
    attempt.controller.abort(reason);
    attempt.stop();
    // A response/header implementation may ignore abort. Record the stop without waiting for it.
    // The microtask also lets an already resolved read preserve its received diagnostic fragment.
    queueMicrotask(() =>
      recordTerminal(
        attempt,
        reason instanceof FirstTokenDeadlineError ? 'first_token_deadline' : 'cancelled'
      )
    );
  };
  const fail = (error: unknown) => {
    if (settled) return;
    settled = true;
    clearFirstTokenTimers();
    abortAttempt(primary, error);
    abortAttempt(fallback, error);
    rejectSelected(error);
  };
  const externalAbort = () => fail(input.signal.reason);
  input.signal.addEventListener('abort', externalAbort, { once: true });
  deadlineTimer = setTimeout(
    () => fail(new FirstTokenDeadlineError()),
    input.remainingFirstTokenMs
  );

  const createAttempt = (
    model: TransportModel,
    role: 'primary' | 'fallback',
    id: string
  ): Attempt => {
    const controller = new AbortController();
    return {
      model,
      observation: { id, role, provider: model.provider, model: model.providerModelId },
      controller,
      signal: AbortSignal.any([input.signal, controller.signal]),
      prepared: Promise.resolve(),
      startedAt: performance.now(),
      finished: false,
      recorded: false,
      writes: Promise.resolve(),
      content: '',
      reasoning: '',
      truncated: false,
      stop: () => {},
    };
  };
  const capture = (attempt: Attempt, kind: 'content' | 'reasoning', text: string) => {
    const remaining = DIAGNOSTIC_TEXT_LIMIT - attempt[kind].length;
    if (text.length > remaining) attempt.truncated = true;
    if (remaining > 0) {
      const fragment = text.slice(0, remaining);
      // JSONB rejects an isolated UTF-16 high surrogate; never split an emoji at the cap.
      const safe = /[\uD800-\uDBFF]$/.test(fragment) ? fragment.slice(0, -1) : fragment;
      if (safe.length !== fragment.length) attempt.truncated = true;
      attempt[kind] += safe;
    }
  };

  const claim = (attempt: Attempt, result: Peeked): void => {
    assertBudget();
    if (settled) return;
    // There is no await between the deadline check, winner lock and cancelling the other request.
    settled = true;
    clearFirstTokenTimers();
    recordTerminal(attempt, 'first_token_observed');
    abortAttempt(attempt === primary ? fallback : primary, new LostFirstTokenRace());
    try {
      input.onReady?.();
      resolveSelected({ attempt, result });
    } catch (error) {
      abortAttempt(attempt, error);
      rejectSelected(error);
    }
  };

  const peek = async (attempt: Attempt): Promise<Peeked> => {
    const { model, signal, observation } = attempt;
    let responseBody: ReadableStream<Uint8Array> | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const stop = () => {
      signal.removeEventListener('abort', stop);
      void (reader ? reader.cancel() : responseBody?.cancel())?.catch(() => undefined);
    };
    attempt.stop = stop;
    const onDispatch = () => {
      assertBudget();
      signal.throwIfAborted();
      attempt.startedAt = performance.now();
      observation.dispatched_at = new Date().toISOString();
      observation.dispatch_offset_ms = attempt.startedAt - input.requestStartedAt;
      record(attempt);
      if (observation.role === 'primary' && differentModels) {
        const wait = Math.min(
          input.timeoutMs,
          Math.max(0, deadlineAt - attempt.startedAt - reserveMs)
        );
        thresholdTimer = setTimeout(startFallback, wait);
      }
    };
    signal.throwIfAborted();
    const response = await input.forward(model, signal, onDispatch);
    responseBody = response.body;
    // Some transports resolve headers after cancellation; never leave that late body open.
    if (signal.aborted) {
      stop();
      signal.throwIfAborted();
    }
    observation.headers_ms = performance.now() - attempt.startedAt;
    observation.http_status = response.status;
    observation.generation_id = response.headers.get('x-generation-id');
    if (!response.ok || !response.body) {
      recordTerminal(attempt, 'upstream_error');
      stop();
      return { response, observation, replay: () => response };
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
        capture(attempt, 'content', text);
        if (text.trim()) hasVisibleToken = true;
      },
      onReasoning: (text) => {
        if (input.thinkingEnabled !== false && readExposedReasoning({ reasoning: text }).trim()) {
          capture(attempt, 'reasoning', text);
          hasVisibleToken = true;
        }
      },
    });
    while (true) {
      const item = await reader.read();
      if (item.done && !buffer) {
        signal.throwIfAborted();
        break;
      }
      if (!item.done && observation.first_chunk_ms === undefined)
        observation.first_chunk_ms = performance.now() - attempt.startedAt;
      if (!item.done) {
        chunks.push(item.value);
        bytes += item.value.byteLength;
      }
      if (bytes > 2 * 1024 * 1024) throw new Error('First-token prelude exceeded limit');
      buffer += item.done ? decoder.decode() + '\n' : decoder.decode(item.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
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
        if (!observation.generation_id && typeof value.id === 'string')
          observation.generation_id = value.id;
        const choice = Array.isArray(value.choices) ? value.choices[0] : null;
        if (value.error != null || choice?.error != null || value.type === 'error') {
          terminal = true;
          terminalReason = 'upstream_error';
          break;
        }
        const delta = choice && typeof choice === 'object' ? choice.delta : null;
        if (delta && typeof delta === 'object' && !Array.isArray(delta)) {
          const reasoning = input.thinkingEnabled !== false ? readExposedReasoning(delta) : '';
          if (reasoning.trim()) {
            capture(attempt, 'reasoning', reasoning);
            hasVisibleToken = true;
          }
          if (typeof delta.content === 'string') splitter.push(delta.content);
          if (typeof delta.refusal === 'string' && delta.refusal.trim()) {
            terminal = true;
            terminalReason = 'upstream_error';
          }
        }
        if (typeof choice?.finish_reason === 'string' && choice.finish_reason) terminal = true;
        if (terminal) break;
      }
      if (item.done || terminal) splitter.finish();
      if (hasVisibleToken && observation.first_token_ms === undefined)
        observation.first_token_ms = performance.now() - attempt.startedAt;
      // Preserve only the chunk already received before abort; never perform another loser read.
      signal.throwIfAborted();
      if (!hasVisibleToken) {
        if (item.done || terminal) break;
        continue;
      }
      assertBudget();
      const replay = () => {
        const headers = new Headers(response.headers);
        if (observation.generation_id) headers.set('x-generation-id', observation.generation_id);
        let index = 0;
        return new Response(
          new ReadableStream<Uint8Array>({
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
            cancel: stop,
          }),
          { status: response.status, statusText: response.statusText, headers }
        );
      };
      const result = { response, observation, replay };
      claim(attempt, result);
      return result;
    }
    recordTerminal(attempt, terminalReason);
    stop();
    const headers = new Headers(response.headers);
    headers.delete('x-generation-id');
    return {
      response,
      observation,
      replay: () => new Response(null, { status: response.status, headers }),
    };
  };

  const runAttempt = async (attempt: Attempt) => {
    let result: Peeked | undefined;
    let error: unknown;
    try {
      if (!input.deferPersistence) await attempt.prepared;
      attempt.signal.throwIfAborted();
      result = await peek(attempt);
    } catch (caught) {
      error = caught;
      recordTerminal(
        attempt,
        caught instanceof FirstTokenDeadlineError ||
          attempt.signal.reason instanceof FirstTokenDeadlineError
          ? 'first_token_deadline'
          : attempt.signal.aborted
            ? 'cancelled'
            : 'upstream_error'
      );
      attempt.stop();
    }
    attempt.finished = true;
    if (settled) return;
    if (input.signal.aborted || error instanceof FirstTokenDeadlineError) {
      fail(input.signal.aborted ? input.signal.reason : error);
      return;
    }
    lastFailure = { attempt, result, error };
    if (attempt === primary) startFallback();
    if (fallback?.finished && (!primary || primary.finished)) {
      settled = true;
      clearFirstTokenTimers();
      if (lastFailure.result)
        resolveSelected({ attempt: lastFailure.attempt, result: lastFailure.result });
      else rejectSelected(lastFailure.error ?? new Error('No model produced a first token'));
    }
  };

  function startFallback(): void {
    if (settled || fallback) return;
    try {
      assertBudget();
      clearTimeout(thresholdTimer);
      fallback = createAttempt(
        { provider: 'openrouter', providerModelId: fallbackModelId },
        'fallback',
        randomUUID()
      );
      const attempt = fallback;
      const intent = { ...attempt.observation };
      const triggeredMs = performance.now() - input.requestStartedAt;
      attempt.prepared = Promise.resolve().then(() =>
        input.store.prepareFallback(intent, triggeredMs)
      );
      void attempt.prepared.catch(input.onObservationError);
      void runAttempt(attempt);
    } catch (error) {
      fail(error);
    }
  }

  const skipPrimary = differentModels && deadlineAt - performance.now() <= reserveMs;
  if (skipPrimary) {
    const skipped = createAttempt(input.primary, 'primary', input.primaryAttemptId);
    recordTerminal(skipped, 'budget_skipped');
    startFallback();
  } else {
    primary = createAttempt(input.primary, 'primary', input.primaryAttemptId);
    void runAttempt(primary);
  }
  try {
    const selected = await selection;
    let deliveryPersisted = Promise.resolve();
    if (selected.result.observation.first_token_ms !== undefined) {
      // A primary win must not wait for an unrelated fallback intent or diagnostic write.
      deliveryPersisted = selected.attempt.prepared.then(() =>
        input.store.selectDelivery(selected.result.observation)
      );
      void deliveryPersisted.catch(input.onObservationError);
      if (!input.deferPersistence) await deliveryPersisted;
    }
    return {
      deliveryPersisted,
      response: selected.result.replay(),
      model: selected.attempt.model,
      role: selected.attempt.observation.role,
      firstTokenAt:
        input.requestStartedAt +
        (selected.result.observation.dispatch_offset_ms ?? 0) +
        (selected.result.observation.first_token_ms ?? 0),
    };
  } catch (error) {
    abortAttempt(primary, error);
    abortAttempt(fallback, error);
    throw error;
  } finally {
    input.signal.removeEventListener('abort', externalAbort);
    clearFirstTokenTimers();
  }
}
