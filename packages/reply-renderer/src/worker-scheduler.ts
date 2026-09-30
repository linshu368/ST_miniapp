import { TEXT_POSTPROCESS_LIMITS } from '@miniapp/shared';

import {
  originalOutcome,
  type WorkerOutcome,
  type WorkerRequest,
  type WorkerResponse,
} from './worker-protocol';

export const POSTPROCESS_TIMEOUT_MS = TEXT_POSTPROCESS_LIMITS.messageBudgetMs;

interface Task {
  jobId: number;
  messageKey: string;
  content: string;
  artifact: unknown;
  timeoutMs: number;
  resolve: (outcome: WorkerOutcome) => void;
}

interface ActiveTask {
  task: Task;
  generation: number;
  timer: ReturnType<typeof setTimeout>;
}

type WorkerFactory = () => Worker;

function defaultWorkerFactory(): Worker {
  return new Worker(new URL('./postprocess.worker.ts', import.meta.url), { type: 'module' });
}

let createWorker: WorkerFactory = defaultWorkerFactory;
let worker: Worker | null = null;
let generation = 0;
let jobSeq = 0;
let users = 0;
let active: ActiveTask | null = null;
const waiting = new Map<string, Task>();

export function setWorkerFactoryForTests(next: WorkerFactory | null): void {
  resetReplyWorkerForTests();
  createWorker = next ?? defaultWorkerFactory;
}

export function resetReplyWorkerForTests(): void {
  const queued = [...waiting.values()];
  waiting.clear();
  const current = active;
  active = null;
  if (current) clearTimeout(current.timer);
  disposeWorker();
  current?.task.resolve(originalOutcome(current.task.content, 'RESET'));
  for (const task of queued) task.resolve(originalOutcome(task.content, 'RESET'));
  users = 0;
}

export function retainReplyWorker(): () => void {
  users += 1;
  return () => {
    users -= 1;
    if (users > 0) return;
    users = 0;
    const queued = [...waiting.values()];
    waiting.clear();
    const current = active;
    active = null;
    if (current) {
      clearTimeout(current.timer);
      current.task.resolve(originalOutcome(current.task.content, 'UNMOUNTED'));
    }
    for (const task of queued) task.resolve(originalOutcome(task.content, 'UNMOUNTED'));
    disposeWorker();
  };
}

/**
 * 同一时刻只跑一个任务。同一消息只保留最新请求；不同消息按挂载顺序排队。
 * 超时、取消和 Worker 错误都会 terminate，下一次任务使用新实例。
 * 成功完成后可以复用。旧 generation 的消息直接丢掉。
 */
export function runReplyPostprocess(input: {
  content: string;
  artifact: unknown;
  messageKey: string;
  timeoutMs?: number;
}): { cancel: () => void; promise: Promise<WorkerOutcome> } {
  const timeoutMs = input.timeoutMs ?? POSTPROCESS_TIMEOUT_MS;
  let resolvePromise: (outcome: WorkerOutcome) => void = () => undefined;
  const promise = new Promise<WorkerOutcome>((resolve) => {
    resolvePromise = resolve;
  });
  const task: Task = {
    jobId: ++jobSeq,
    messageKey: input.messageKey,
    content: input.content,
    artifact: input.artifact,
    timeoutMs,
    resolve: resolvePromise,
  };

  const queued = waiting.get(task.messageKey);
  if (queued) {
    waiting.delete(task.messageKey);
    queued.resolve(originalOutcome(queued.content, 'SUPERSEDED'));
  }

  if (active?.task.messageKey === task.messageKey) {
    const previous = active;
    active = null;
    clearTimeout(previous.timer);
    disposeWorker();
    previous.task.resolve(originalOutcome(previous.task.content, 'SUPERSEDED'));
    start(task);
  } else if (active) {
    waiting.set(task.messageKey, task);
  } else {
    start(task);
  }

  return {
    promise,
    cancel() {
      if (active?.task.jobId === task.jobId) {
        settle(originalOutcome(task.content, 'CANCELLED'), true);
        return;
      }
      const pendingTask = waiting.get(task.messageKey);
      if (pendingTask?.jobId === task.jobId) {
        waiting.delete(task.messageKey);
        pendingTask.resolve(originalOutcome(task.content, 'CANCELLED'));
      }
    },
  };
}

function start(task: Task): void {
  let instance: Worker;
  try {
    instance = ensureWorker();
  } catch {
    task.resolve(originalOutcome(task.content, 'WORKER_UNAVAILABLE'));
    pump();
    return;
  }

  const workerGeneration = generation;
  const timer = setTimeout(() => {
    if (active?.task.jobId !== task.jobId) return;
    settle(originalOutcome(task.content, 'TIMEOUT'), true);
  }, task.timeoutMs);
  active = { task, generation: workerGeneration, timer };

  const request: WorkerRequest = {
    jobId: task.jobId,
    generation: workerGeneration,
    content: task.content,
    artifact: task.artifact,
    messageKey: task.messageKey,
    deadlineAt: Date.now() + task.timeoutMs,
  };

  try {
    instance.postMessage(request);
  } catch {
    if (active?.task.jobId === task.jobId) {
      settle(originalOutcome(task.content, 'WORKER_ERROR'), true);
    }
  }
}

function pump(): void {
  if (active) return;
  const next = waiting.values().next();
  if (next.done || !next.value) {
    if (users === 0) disposeWorker();
    return;
  }
  waiting.delete(next.value.messageKey);
  start(next.value);
}

function settle(outcome: WorkerOutcome, destroyWorker: boolean): void {
  const current = active;
  if (!current) return;
  active = null;
  clearTimeout(current.timer);
  if (destroyWorker) disposeWorker();
  current.task.resolve(outcome);
  pump();
}

function ensureWorker(): Worker {
  if (worker) return worker;
  generation += 1;
  const next = createWorker();
  const workerGeneration = generation;
  next.onmessage = (event: MessageEvent<WorkerResponse>) => {
    if (workerGeneration !== generation || !active) return;
    const response = event.data;
    if (response.jobId !== active.task.jobId || response.generation !== active.generation) return;
    settle({ result: response.result, css: response.css }, false);
  };
  next.onerror = () => {
    if (workerGeneration !== generation || !active) return;
    settle(originalOutcome(active.task.content, 'WORKER_ERROR'), true);
  };
  worker = next;
  return next;
}

function disposeWorker(): void {
  const current = worker;
  worker = null;
  generation += 1;
  current?.terminate();
}
