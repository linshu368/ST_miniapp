/** SDK extraction candidate: factories/contracts only; no Pino, config, filesystem or app startup. */
export { createObserver } from './core.js';
export type { EventSink, Operation } from './core.js';
export {
  newContext,
  childContext,
  currentContext,
  withContext,
  requestId,
  bindBusinessContext,
  withBusinessContext,
  contextLogFields,
} from './context.js';
export type { ObservationContext } from './context.js';
export { safeError, safeErrorCode, safeFields, safeName } from './events.js';
export type { EventFields, ObservationEvent, Outcome, EventLevel } from './events.js';
export { createObservedFetch } from './fetch-core.js';
export { createJobObservation } from './job-core.js';
export {
  parseLogAlertRules,
  parseLogAlertFile,
  matchesLogRule,
  logAlertRuleSchema,
} from './alert-policy.js';
export type { LogAlertPolicy, LogAlertRule } from './alert-policy.js';
export { createLogAlerts } from './log-alerts.js';
export type {
  AlertLog,
  LogAlertCard,
  LogAlertDelivery,
  LogAlertDeliveryResult,
  LogAlertPresentation,
} from './alert-types.js';
export { buildPinoOptions } from './conventions.js';
export { createLogPresentation } from './presentation.js';
export type { LogPresentation, LogPresentationCatalog } from './presentation.js';
