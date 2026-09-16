import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { markExternalPaymentOpened, resetPaymentFlowTelemetryForTests } from './flow-telemetry';
import {
  attachPaymentReturnObserver,
  configurePaymentReturnObserverForTests,
  detachPaymentReturnObserver,
} from './return-observer';
import { setReplaySessionStorageForTests } from './session-storage';

const capture = vi.fn();
const getSnapshot = vi.fn(() => ({
  state: 'external_payment_pending' as const,
  replayContextId: '11111111-1111-4111-8111-111111111111',
  telemetryReady: true,
  streaming: false,
}));

vi.mock('@/lib/telemetry', () => ({
  getReplayLifecycle: () => ({
    capture,
    getSnapshot,
    enterPaywallFollowup: vi.fn(),
  }),
}));

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear() {
      map.clear();
    },
    getItem(key: string) {
      return map.get(key) ?? null;
    },
    key(index: number) {
      return [...map.keys()][index] ?? null;
    },
    removeItem(key: string) {
      map.delete(key);
    },
    setItem(key: string, value: string) {
      map.set(key, String(value));
    },
  };
}

describe('payment return observer', () => {
  const windowListeners = new Map<string, EventListener>();
  const documentListeners = new Map<string, EventListener>();
  let pathname = '/profile/orders';
  let visibility: DocumentVisibilityState = 'visible';

  beforeEach(() => {
    capture.mockClear();
    pathname = '/profile/orders';
    visibility = 'visible';
    windowListeners.clear();
    documentListeners.clear();
    setReplaySessionStorageForTests(memoryStorage());
    resetPaymentFlowTelemetryForTests();
    configurePaymentReturnObserverForTests({
      getPathname: () => pathname,
      getVisibilityState: () => visibility,
      addWindowListener: (type, listener) => {
        windowListeners.set(type, listener);
      },
      removeWindowListener: (type) => {
        windowListeners.delete(type);
      },
      addDocumentListener: (type, listener) => {
        documentListeners.set(type, listener);
      },
      removeDocumentListener: (type) => {
        documentListeners.delete(type);
      },
    });
    attachPaymentReturnObserver();
  });

  afterEach(() => {
    detachPaymentReturnObserver();
    configurePaymentReturnObserverForTests();
    resetPaymentFlowTelemetryForTests();
    setReplaySessionStorageForTests(undefined);
  });

  it('emits payment_return_observed on visibility resume after opening external payment', () => {
    markExternalPaymentOpened({ orderId: 'TG_1', paymentType: 'wxpay', now: Date.now() });
    visibility = 'hidden';
    documentListeners.get('visibilitychange')?.(new Event('visibilitychange'));
    visibility = 'visible';
    pathname = '/profile/orders';
    documentListeners.get('visibilitychange')?.(new Event('visibilitychange'));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[0]).toMatchObject({
      event: 'payment_return_observed',
      order_id: 'TG_1',
      return_source: 'webview_resume',
      return_surface: 'orders_list',
      return_route: '/profile/orders',
    });
  });

  it('does not emit on ordinary visibility or focus without an open request', () => {
    visibility = 'hidden';
    documentListeners.get('visibilitychange')?.(new Event('visibilitychange'));
    visibility = 'visible';
    documentListeners.get('visibilitychange')?.(new Event('visibilitychange'));
    windowListeners.get('focus')?.(new Event('focus'));
    expect(capture).not.toHaveBeenCalled();
  });

  it('dedupes visibility, focus and pageshow for the same order', () => {
    markExternalPaymentOpened({ orderId: 'TG_1', paymentType: 'wxpay' });
    visibility = 'hidden';
    documentListeners.get('visibilitychange')?.(new Event('visibilitychange'));
    windowListeners.get('pagehide')?.(new Event('pagehide'));
    visibility = 'visible';
    pathname = '/profile/recharge/TG_1';
    documentListeners.get('visibilitychange')?.(new Event('visibilitychange'));
    windowListeners.get('focus')?.(new Event('focus'));
    windowListeners.get('pageshow')?.(new Event('pageshow'));
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[0]).toMatchObject({
      order_id: 'TG_1',
      return_surface: 'order_detail',
    });
  });

  it('treats bfcache pageshow as a resume after external payment', () => {
    markExternalPaymentOpened({ orderId: 'TG_1', paymentType: 'wxpay' });
    pathname = '/profile/recharge/TG_1';
    const pageshow = new Event('pageshow') as Event & { persisted?: boolean };
    pageshow.persisted = true;
    windowListeners.get('pageshow')?.(pageshow);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture.mock.calls[0]?.[0]).toMatchObject({
      event: 'payment_return_observed',
      order_id: 'TG_1',
      return_source: 'webview_resume',
    });
  });
});
