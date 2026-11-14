import { randomUUID } from 'node:crypto';
import {
  childContext,
  contextLogFields,
  currentContext,
  newContext,
  withContext,
  type ObservationContext,
} from './context.js';
import {
  outcomeLevel,
  safeFields,
  safeName,
  type EventFields,
  type EventLevel,
  type ObservationEvent,
} from './events.js';

export type EventSink = (event: Readonly<ObservationEvent>) => void | Promise<void>;
export interface Operation {
  readonly context: ObservationContext;
  finish(fields?: EventFields, level?: EventLevel): void;
}

/** Outputs are independent; a broken observer cannot alter business execution. */
export function createObserver(sinks: readonly EventSink[]) {
  const health = { output_failures: 0, projection_failures: 0 };
  function emit(
    event: string,
    operation: string,
    fields: EventFields = {},
    level?: EventLevel
  ): void {
    try {
      const projected = safeFields(fields);
      const record: ObservationEvent = Object.freeze({
        ...projected,
        ...contextLogFields(currentContext() ?? newContext()),
        schema_version: 1,
        event_id: randomUUID(),
        event: safeName(event),
        operation: safeName(operation),
        module: safeName(operation.split('.')[0]),
        kind: 'sys',
        level: level ?? outcomeLevel(projected.outcome),
        timestamp: new Date().toISOString(),
      });
      for (const sink of sinks) {
        try {
          const pending = sink(record);
          if (pending)
            void pending.catch(() => {
              health.output_failures++;
            });
        } catch {
          health.output_failures++;
        }
      }
    } catch {
      health.projection_failures++;
    }
  }

  function start(operation: string, fields: EventFields = {}, context = childContext()): Operation {
    const started = performance.now();
    let finished = false;
    withContext(context, () =>
      emit('operation.started', operation, { ...fields, outcome: 'pending' })
    );
    return {
      context,
      finish(result = {}, level) {
        if (finished) return;
        finished = true;
        withContext(context, () =>
          emit(
            'operation.terminal',
            operation,
            {
              ...fields,
              ...result,
              duration_ms: Math.max(0, performance.now() - started),
            },
            level
          )
        );
      },
    };
  }

  function terminal<T>(op: Operation, value: T, summarize?: (value: T) => EventFields): T {
    try {
      op.finish({ outcome: 'succeeded', outcome_known: true, ...summarize?.(value) });
    } catch {
      health.projection_failures++;
      op.finish({
        outcome: 'unknown',
        outcome_known: false,
        error_code: 'OBSERVATION_PROJECTION_FAILED',
      });
    }
    return value;
  }

  function observeSync<T>(name: string, run: () => T, summarize?: (value: T) => EventFields): T {
    const op = start(name);
    return withContext(op.context, () => {
      try {
        return terminal(op, run(), summarize);
      } catch (err) {
        op.finish({ outcome: 'failed', outcome_known: false, err });
        throw err;
      }
    });
  }

  async function observe<T>(
    name: string,
    run: () => PromiseLike<T>,
    summarize?: (value: T) => EventFields
  ): Promise<T> {
    const op = start(name);
    return withContext(op.context, async () => {
      try {
        return terminal(op, await run(), summarize);
      } catch (err) {
        op.finish({ outcome: 'failed', outcome_known: false, err });
        throw err;
      }
    });
  }
  return { emit, start, observe, observeSync, health };
}
