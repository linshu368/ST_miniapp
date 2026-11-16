import { createJobObservation } from './job-core.js';
import { observation } from './runtime.js';

export const { hasBackgroundOperation, finishBackgroundOperation, runObservedJob } =
  createJobObservation(observation);
