import pino from 'pino';
import { foundationLoggerOptions } from './logger-options.js';
import { createObserver } from './core.js';

// Foundation events are independent of diagnostic LOG_LEVEL. Railway owns capture/storage.
const output = pino(foundationLoggerOptions());

export const observation = createObserver([
  (event) => {
    // The event already contains its level and safe error; do not serialize it a second time.
    const { level, err, ...fields } = event;
    output[level](
      { ...fields, reqId: event.request_id, ...(err ? { error: err } : {}) },
      event.event
    );
  },
]);
