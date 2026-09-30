import { buildWorkerResponse } from './postprocess-job';
import type { WorkerRequest, WorkerResponse } from './worker-protocol';

const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null;
  postMessage: (message: WorkerResponse) => void;
};

scope.onmessage = (event) => {
  scope.postMessage(buildWorkerResponse(event.data));
};
