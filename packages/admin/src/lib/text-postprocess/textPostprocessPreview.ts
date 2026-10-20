import {
  CompiledTextPostprocessArtifactSchema,
  TEXT_POSTPROCESS_LIMITS,
  TextPostprocessDiagnosticSchema,
  type CompiledTextPostprocessArtifact,
  type TextPostprocessDiagnostic,
} from '@miniapp/shared';
import { z } from 'zod';

/** 编译另计时间，应用阶段仍使用共享的单条消息预算。超时后终止 Worker。 */
export const PREVIEW_TIMEOUT_MS = TEXT_POSTPROCESS_LIMITS.messageBudgetMs + 500;

const CLIP = 180;

export interface PreviewCapture {
  index: number;
  name: string | null;
  text: string;
}

export interface PreviewRuleStat {
  ruleId: string;
  count: number;
  firstMatch: string | null;
  firstCaptures: PreviewCapture[];
}

export interface PreviewApplySummary {
  status: 'applied' | 'original';
  reason: string | null;
  matches: number;
  elapsedMs: number;
  rules: PreviewRuleStat[];
  skipped: Array<{ ruleId: string; code: string }>;
}

export interface PreviewWorkerRequest {
  jobId: number;
  generation: number;
  source: unknown;
  sample: string;
}

export interface PreviewWorkerResponse {
  jobId: number;
  generation: number;
  compileMs: number;
  diagnostics: TextPostprocessDiagnostic[];
  artifact: unknown;
  apply: PreviewApplySummary | null;
  failure: 'WORKER_EXCEPTION' | null;
}

export interface PreviewViewState {
  ok: boolean;
  failure: 'TIMEOUT' | 'WORKER_UNAVAILABLE' | 'WORKER_CRASH' | 'WORKER_EXCEPTION' | null;
  diagnostics: TextPostprocessDiagnostic[];
  artifact: CompiledTextPostprocessArtifact | null;
  apply: PreviewApplySummary | null;
  elapsedMs: number;
}

export type PreviewRunResult = { ignored: true } | { ignored: false; state: PreviewViewState };

const CaptureSchema = z
  .object({
    index: z.number().int().nonnegative(),
    name: z.string().nullable(),
    text: z.string().max(CLIP),
  })
  .strict();

const ApplySchema = z
  .object({
    status: z.enum(['applied', 'original']),
    reason: z.string().nullable(),
    matches: z.number().int().nonnegative(),
    elapsedMs: z.number().int().nonnegative(),
    rules: z
      .array(
        z
          .object({
            ruleId: z.string(),
            count: z.number().int().nonnegative(),
            firstMatch: z.string().max(CLIP).nullable(),
            firstCaptures: z.array(CaptureSchema).max(32),
          })
          .strict()
      )
      .max(TEXT_POSTPROCESS_LIMITS.maxRules),
    skipped: z
      .array(z.object({ ruleId: z.string(), code: z.string() }).strict())
      .max(TEXT_POSTPROCESS_LIMITS.maxRules),
  })
  .strict();

const WorkerResponseSchema = z
  .object({
    jobId: z.number().int(),
    generation: z.number().int(),
    compileMs: z.number().int().nonnegative(),
    diagnostics: z
      .array(TextPostprocessDiagnosticSchema)
      .max(TEXT_POSTPROCESS_LIMITS.maxDiagnostics),
    artifact: z.unknown().nullable(),
    apply: ApplySchema.nullable(),
    failure: z.literal('WORKER_EXCEPTION').nullable(),
  })
  .strict();

export function previewFailureDiagnostic(failure: string): TextPostprocessDiagnostic {
  const message =
    failure === 'TIMEOUT'
      ? '预览 Worker 超时，已终止。没有在主线程执行正则。'
      : failure === 'WORKER_UNAVAILABLE'
        ? '预览 Worker 不可用。没有在主线程执行正则。'
        : '预览 Worker 失败。没有在主线程执行正则。';
  return {
    code: failure === 'TIMEOUT' ? 'PREVIEW_TIMEOUT' : 'PREVIEW_WORKER_FAILED',
    rule_id: null,
    field: 'source',
    message,
    location: null,
  };
}

export function parsePreviewWorkerResponse(
  data: unknown,
  jobId: number,
  generation: number
): PreviewViewState | null {
  const parsed = WorkerResponseSchema.safeParse(data);
  if (!parsed.success || parsed.data.jobId !== jobId || parsed.data.generation !== generation)
    return null;
  if (parsed.data.failure) {
    return {
      ok: false,
      failure: 'WORKER_EXCEPTION',
      diagnostics: [previewFailureDiagnostic('WORKER_EXCEPTION'), ...parsed.data.diagnostics],
      artifact: null,
      apply: null,
      elapsedMs: parsed.data.compileMs,
    };
  }
  if (parsed.data.artifact === null) {
    return {
      ok: false,
      failure: null,
      diagnostics: parsed.data.diagnostics,
      artifact: null,
      apply: null,
      elapsedMs: parsed.data.compileMs,
    };
  }
  const artifact = CompiledTextPostprocessArtifactSchema.safeParse(parsed.data.artifact);
  if (!artifact.success) {
    return {
      ok: false,
      failure: 'WORKER_CRASH',
      diagnostics: [previewFailureDiagnostic('WORKER_CRASH')],
      artifact: null,
      apply: null,
      elapsedMs: parsed.data.compileMs,
    };
  }
  return {
    ok: parsed.data.diagnostics.length === 0,
    failure: null,
    diagnostics: parsed.data.diagnostics,
    artifact: artifact.data,
    apply: parsed.data.apply,
    elapsedMs: parsed.data.compileMs + (parsed.data.apply?.elapsedMs ?? 0),
  };
}

interface ActiveJob {
  jobId: number;
  generation: number;
  started: number;
  timer: ReturnType<typeof setTimeout>;
  resolve: (result: PreviewRunResult) => void;
}

export function createPreviewRunner(options?: { factory?: () => Worker; timeoutMs?: number }): {
  run(input: { source: unknown; sample: string; generation: number }): Promise<PreviewRunResult>;
  dispose(): void;
} {
  let worker: Worker | null = null;
  let active: ActiveJob | null = null;
  let jobSeq = 0;
  let disposed = false;
  const timeoutMs = options?.timeoutMs ?? PREVIEW_TIMEOUT_MS;

  function finish(result: PreviewRunResult, terminate: boolean): void {
    const current = active;
    active = null;
    if (current) clearTimeout(current.timer);
    if (terminate) {
      worker?.terminate();
      worker = null;
    }
    current?.resolve(result);
  }

  function fail(
    job: { resolve: (result: PreviewRunResult) => void },
    failure: PreviewViewState['failure'],
    elapsedMs: number
  ): void {
    job.resolve({
      ignored: false,
      state: {
        ok: false,
        failure,
        diagnostics: [previewFailureDiagnostic(failure ?? 'WORKER_CRASH')],
        artifact: null,
        apply: null,
        elapsedMs,
      },
    });
  }

  return {
    run(input) {
      return new Promise((resolve) => {
        if (disposed) {
          resolve({ ignored: true });
          return;
        }
        if (active) {
          const previous = active;
          active = null;
          clearTimeout(previous.timer);
          worker?.terminate();
          worker = null;
          previous.resolve({ ignored: true });
        }
        const jobId = ++jobSeq;
        let instance: Worker;
        try {
          instance = (options?.factory ?? defaultPreviewWorker)();
          worker = instance;
        } catch {
          fail({ resolve }, 'WORKER_UNAVAILABLE', 0);
          return;
        }
        const started = Date.now();
        const timer = setTimeout(() => {
          if (active?.jobId !== jobId) return;
          finish(
            {
              ignored: false,
              state: {
                ok: false,
                failure: 'TIMEOUT',
                diagnostics: [previewFailureDiagnostic('TIMEOUT')],
                artifact: null,
                apply: null,
                elapsedMs: Date.now() - started,
              },
            },
            true
          );
        }, timeoutMs);
        active = { jobId, generation: input.generation, started, timer, resolve };
        instance.onmessage = (event: MessageEvent<unknown>) => {
          if (active?.jobId !== jobId) return;
          const state = parsePreviewWorkerResponse(event.data, jobId, input.generation);
          if (!state) {
            finish(
              {
                ignored: false,
                state: {
                  ok: false,
                  failure: 'WORKER_CRASH',
                  diagnostics: [previewFailureDiagnostic('WORKER_CRASH')],
                  artifact: null,
                  apply: null,
                  elapsedMs: Date.now() - started,
                },
              },
              true
            );
            return;
          }
          finish({ ignored: false, state }, false);
        };
        instance.onerror = () => {
          if (active?.jobId !== jobId) return;
          finish(
            {
              ignored: false,
              state: {
                ok: false,
                failure: 'WORKER_CRASH',
                diagnostics: [previewFailureDiagnostic('WORKER_CRASH')],
                artifact: null,
                apply: null,
                elapsedMs: Date.now() - started,
              },
            },
            true
          );
        };
        try {
          const message: PreviewWorkerRequest = {
            jobId,
            generation: input.generation,
            source: input.source,
            sample: input.sample,
          };
          instance.postMessage(message);
        } catch {
          finish(
            {
              ignored: false,
              state: {
                ok: false,
                failure: 'WORKER_UNAVAILABLE',
                diagnostics: [previewFailureDiagnostic('WORKER_UNAVAILABLE')],
                artifact: null,
                apply: null,
                elapsedMs: Date.now() - started,
              },
            },
            true
          );
        }
      });
    },
    dispose() {
      disposed = true;
      if (!active) {
        worker?.terminate();
        worker = null;
        return;
      }
      finish({ ignored: true }, true);
    },
  };
}

function defaultPreviewWorker(): Worker {
  return new Worker(new URL('./textPostprocessPreview.worker.ts', import.meta.url), {
    type: 'module',
  });
}
