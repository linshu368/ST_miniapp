export type BridgeStatus =
  | 'idle'
  | 'loading'
  | 'handshaked'
  | 'interactive'
  | 'ready'
  | 'disconnected';

export type StateMachineEvent =
  | { type: 'IFRAME_LOAD_START' }
  | { type: 'HANDSHAKE_RECEIVED' }
  | { type: 'INTERACTIVE_RECEIVED' }
  | { type: 'READY_RECEIVED' }
  | { type: 'DISCONNECT'; reason?: string };

type StatusChangeCallback = (status: BridgeStatus) => void;

const validTransitions: Record<BridgeStatus, BridgeStatus[]> = {
  idle: ['loading'],
  loading: ['handshaked', 'disconnected'],
  // handshaked → ready 直达必须保留：旧 ST bundle（两段握手）不发 interactive
  handshaked: ['interactive', 'ready', 'disconnected'],
  interactive: ['ready', 'disconnected'],
  ready: ['disconnected'],
  disconnected: ['loading'],
};

export type BridgeStateMachine = {
  getStatus(): BridgeStatus;
  transition(event: StateMachineEvent): void;
  onStatusChange(cb: StatusChangeCallback): () => void;
  reset(): void;
};

export function createStateMachine(): BridgeStateMachine {
  let status: BridgeStatus = 'idle';
  const listeners = new Set<StatusChangeCallback>();

  function setStatus(next: BridgeStatus): void {
    if (next === status) return;
    const allowed = validTransitions[status];
    if (!allowed.includes(next)) return;
    status = next;
    listeners.forEach((cb) => cb(status));
  }

  function transition(event: StateMachineEvent): void {
    switch (event.type) {
      case 'IFRAME_LOAD_START':
        setStatus('loading');
        break;
      case 'HANDSHAKE_RECEIVED':
        setStatus('handshaked');
        break;
      case 'INTERACTIVE_RECEIVED':
        setStatus('interactive');
        break;
      case 'READY_RECEIVED':
        setStatus('ready');
        break;
      case 'DISCONNECT':
        setStatus('disconnected');
        break;
    }
  }

  function onStatusChange(cb: StatusChangeCallback): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  function reset(): void {
    status = 'idle';
    listeners.forEach((cb) => cb(status));
  }

  return { getStatus: () => status, transition, onStatusChange, reset };
}
