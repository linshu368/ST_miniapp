import { buildWorkerResponse } from './postprocess-job';
import type { WorkerMessage, WorkerRequest } from './worker-protocol';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerMessage) => void;
};

scope.onmessage = (event) => {
  scope.postMessage(buildWorkerResponse(event.data));
};

// 模块下载、解析和 Worker 启动不属于单条消息的正则执行预算。
// 主线程收到 ready 后才发送任务并启动执行计时。
scope.postMessage({ type: 'ready' });
