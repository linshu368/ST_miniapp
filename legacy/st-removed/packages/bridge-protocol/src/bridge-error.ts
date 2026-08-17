import type { BridgeErrorCode, BridgeErrorPayload } from './errors.js';

export interface BridgeErrorOptions {
  requestId?: string;
  context?: Record<string, string | number | boolean>;
}

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly context?: Record<string, string | number | boolean>;
  readonly requestId?: string;

  constructor(code: BridgeErrorCode, message: string, opts?: BridgeErrorOptions) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.requestId = opts?.requestId;
    this.context = opts?.context;
  }

  toPayload(): BridgeErrorPayload {
    return {
      code: this.code,
      message: this.message,
      ...(this.requestId !== undefined && { requestId: this.requestId }),
      ...(this.context !== undefined && { context: this.context }),
    };
  }
}
