import type { ActionName } from '@miniapp/bridge-protocol';
import type { HandshakePhase } from '@miniapp/bridge-protocol';
import { BridgeError } from '@miniapp/bridge-protocol';
import { HANDSHAKE_BUFFER_LIMIT } from '@miniapp/bridge-protocol';

export type BufferedRequest = {
  requestId: string;
  action: ActionName;
  payload: unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  requiredPhase: HandshakePhase;
};

export class RequestBuffer {
  private queue: BufferedRequest[] = [];
  private readonly limit = HANDSHAKE_BUFFER_LIMIT;

  enqueue(request: BufferedRequest): void {
    if (this.queue.length >= this.limit) {
      throw new BridgeError(
        'BRIDGE_HANDSHAKE_BUFFER_OVERFLOW',
        `Request buffer overflow: limit ${this.limit} reached`
      );
    }
    this.queue.push(request);
  }

  flush(phase: HandshakePhase): BufferedRequest[] {
    const phaseOrder: Record<HandshakePhase, number> = {
      handshake: 0,
      ready: 1,
    };
    const currentLevel = phaseOrder[phase];
    const flushed: BufferedRequest[] = [];
    const remaining: BufferedRequest[] = [];

    for (const req of this.queue) {
      if (phaseOrder[req.requiredPhase] <= currentLevel) {
        flushed.push(req);
      } else {
        remaining.push(req);
      }
    }
    this.queue = remaining;
    return flushed;
  }

  clear(): void {
    this.queue = [];
  }

  get size(): number {
    return this.queue.length;
  }
}
