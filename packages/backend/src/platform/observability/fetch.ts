import { createObservedFetch } from './fetch-core.js';
import { observation } from './runtime.js';
export { createObservedFetch } from './fetch-core.js';

export const observedFetch = createObservedFetch(observation);

/** Explicit client registration, never a global fetch replacement. */
export function clientFetch(operation: string, provider: string): typeof globalThis.fetch {
  return (input, init) => observedFetch(operation, input, init, { provider });
}
