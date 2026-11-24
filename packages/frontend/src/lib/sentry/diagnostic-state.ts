/** Bounded in-memory evidence only; never retain errors, URLs, bodies or business identities. */
export type TelegramInitState =
  | 'not_started'
  | 'initializing'
  | 'skipped'
  | 'initialized'
  | 'failed';
export interface RequestFailureDiagnostic {
  api_route: string;
  phase: 'queue' | 'headers' | 'body';
  caller_cancelled: boolean;
  external_aborted: boolean;
  deadline: boolean;
  http_status?: number;
}

let telegramState: TelegramInitState = 'not_started';
let coverResizeCount = 0;
let coverOpen = false;
const requests = new WeakMap<object, RequestFailureDiagnostic>();
const cancellations = new WeakMap<object, AbortSignal>();

export const telegramInitState = () => telegramState;
export function recordTelegramInitState(state: TelegramInitState): void {
  telegramState = state;
}
export function recordCoverResize(open: boolean, resized = false): void {
  coverOpen = open;
  if (resized) coverResizeCount = Math.min(coverResizeCount + 1, 65535);
}
export const coverResizeDiagnostic = () => ({
  cover_open: coverOpen,
  cover_resize_count: coverResizeCount,
});

export function markCallerCancellation(error: unknown, signal: AbortSignal): void {
  if (error !== null && typeof error === 'object') cancellations.set(error, signal);
}
export function isCallerCancellation(error: unknown, signal?: AbortSignal | null): boolean {
  return (
    !!signal?.aborted &&
    error !== null &&
    typeof error === 'object' &&
    cancellations.get(error) === signal
  );
}
export function rememberRequestFailure(error: unknown, diagnostic: RequestFailureDiagnostic): void {
  if (error !== null && typeof error === 'object') requests.set(error, diagnostic);
}
export function requestFailureDiagnostic(error: unknown): RequestFailureDiagnostic | undefined {
  return error !== null && typeof error === 'object' ? requests.get(error) : undefined;
}
