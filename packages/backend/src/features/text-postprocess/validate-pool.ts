import { Worker } from 'node:worker_threads';
import {
  TEXT_POSTPROCESS_LIMITS,
  validateCompiledArtifact,
  type CompiledTextPostprocessArtifact,
  type TextPostprocessDiagnostic,
} from '@miniapp/shared';
import {
  TEXT_POSTPROCESS_VALIDATION_QUEUE,
  TEXT_POSTPROCESS_VALIDATION_TIMEOUT_MS,
  TEXT_POSTPROCESS_VALIDATION_WORKERS,
} from './constants.js';

export type ValidationResult =
  | { ok: true; artifact: CompiledTextPostprocessArtifact }
  | { ok: false; reason: 'rejected'; diagnostics: TextPostprocessDiagnostic[] }
  | { ok: false; reason: 'timeout' | 'crashed' | 'queue_full' | 'unavailable' };

interface Job {
  id: number;
  source: unknown;
  timeoutMs: number;
  resolve: (result: ValidationResult) => void;
}

interface Slot {
  worker: Worker;
  job: Job | null;
  timer: ReturnType<typeof setTimeout> | null;
}

type WorkerFactory = () => Worker;

let factory: WorkerFactory = defaultWorkerFactory;
let nextJobId = 0;
const queue: Job[] = [];
const slots: Slot[] = [];
let closed = false;

function defaultWorkerFactory(): Worker {
  return new Worker(new URL('./validate-worker-entry.mjs', import.meta.url), {
    execArgv: [],
  });
}

export function setValidationWorkerFactoryForTests(next: WorkerFactory | null): void {
  shutdownTextPostprocessValidation();
  factory = next ?? defaultWorkerFactory;
  closed = false;
}

export function shutdownTextPostprocessValidation(): void {
  closed = true;
  const pending = queue.splice(0, queue.length);
  for (const job of pending) job.resolve({ ok: false, reason: 'unavailable' });
  for (const slot of slots.splice(0, slots.length)) {
    if (slot.timer) clearTimeout(slot.timer);
    const job = slot.job;
    slot.job = null;
    void slot.worker.terminate();
    job?.resolve({ ok: false, reason: 'unavailable' });
  }
}

/**
 * 在可终止的 worker 中编译 HTML/CSS/正则。队列或 worker 满时立即失败。
 * 超时和崩溃都会 terminate，主线程不执行运营正则。
 */
export function validateTextPostprocessSource(
  source: unknown,
  timeoutMs = TEXT_POSTPROCESS_VALIDATION_TIMEOUT_MS
): Promise<ValidationResult> {
  if (closed) return Promise.resolve({ ok: false, reason: 'unavailable' });
  if (queue.length >= TEXT_POSTPROCESS_VALIDATION_QUEUE) {
    return Promise.resolve({ ok: false, reason: 'queue_full' });
  }
  return new Promise((resolve) => {
    queue.push({ id: ++nextJobId, source, timeoutMs, resolve });
    pump();
  });
}

function pump(): void {
  if (closed) return;
  while (queue.length > 0) {
    const slot = idleSlot();
    if (!slot) {
      if (slots.length === 0) {
        const job = queue.shift();
        job?.resolve({ ok: false, reason: 'unavailable' });
        continue;
      }
      return;
    }
    const job = queue.shift();
    if (!job) return;
    start(slot, job);
  }
}

function idleSlot(): Slot | null {
  const idle = slots.find((slot) => slot.job === null);
  if (idle) return idle;
  if (slots.length >= TEXT_POSTPROCESS_VALIDATION_WORKERS) return null;
  try {
    const worker = factory();
    const slot: Slot = { worker, job: null, timer: null };
    worker.on('message', (message: unknown) => onMessage(slot, message));
    worker.on('error', () => failSlot(slot, 'crashed'));
    worker.on('exit', () => failSlot(slot, 'crashed'));
    slots.push(slot);
    return slot;
  } catch {
    return null;
  }
}

function start(slot: Slot, job: Job): void {
  slot.job = job;
  slot.timer = setTimeout(() => {
    failSlot(slot, 'timeout');
  }, job.timeoutMs);
  try {
    slot.worker.postMessage({ id: job.id, source: job.source });
  } catch {
    failSlot(slot, 'crashed');
  }
}

function onMessage(slot: Slot, message: unknown): void {
  if (!slot.job || !message || typeof message !== 'object') return;
  const record = message as {
    id?: unknown;
    ok?: unknown;
    crashed?: unknown;
    diagnostics?: unknown;
    artifact?: unknown;
  };
  if (record.id !== slot.job.id) return;
  const job = release(slot);
  if (!job) return;
  if (record.crashed === true) {
    disposeWorker(slot);
    job.resolve({ ok: false, reason: 'crashed' });
    pump();
    return;
  }
  if (record.ok === true) {
    const checked = validateCompiledArtifact(record.artifact);
    job.resolve(
      checked.ok ? { ok: true, artifact: checked.artifact } : { ok: false, reason: 'crashed' }
    );
    pump();
    return;
  }
  job.resolve({
    ok: false,
    reason: 'rejected',
    diagnostics: sanitizeDiagnostics(record.diagnostics),
  });
  pump();
}

function failSlot(slot: Slot, reason: 'timeout' | 'crashed'): void {
  const job = release(slot);
  disposeWorker(slot);
  job?.resolve({ ok: false, reason });
  pump();
}

function release(slot: Slot): Job | null {
  if (slot.timer) clearTimeout(slot.timer);
  slot.timer = null;
  const job = slot.job;
  slot.job = null;
  return job;
}

function disposeWorker(slot: Slot): void {
  const index = slots.indexOf(slot);
  if (index >= 0) slots.splice(index, 1);
  void slot.worker.terminate();
}

function sanitizeDiagnostics(value: unknown): TextPostprocessDiagnostic[] {
  if (!Array.isArray(value)) return [];
  const diagnostics: TextPostprocessDiagnostic[] = [];
  for (const item of value) {
    if (diagnostics.length >= TEXT_POSTPROCESS_LIMITS.maxDiagnostics) break;
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const code = typeof record.code === 'string' ? record.code.slice(0, 80) : 'INVALID_SOURCE';
    const rawMessage = typeof record.message === 'string' ? record.message : '';
    const message =
      rawMessage.length > 0 && rawMessage.length <= 240 && !rawMessage.includes('<')
        ? rawMessage
        : 'Validation failed.';
    const ruleId = typeof record.rule_id === 'string' ? record.rule_id : null;
    diagnostics.push({
      code,
      rule_id: ruleId,
      field: diagnosticField(record.field),
      message,
      location: null,
    });
  }
  return diagnostics;
}

function diagnosticField(value: unknown): TextPostprocessDiagnostic['field'] {
  if (
    value === 'id' ||
    value === 'name' ||
    value === 'description' ||
    value === 'enabled' ||
    value === 'pattern' ||
    value === 'flags' ||
    value === 'replacement' ||
    value === 'css' ||
    value === 'notes' ||
    value === 'source' ||
    value === 'version' ||
    value === 'request'
  ) {
    return value;
  }
  return 'source';
}
