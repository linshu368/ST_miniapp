'use client';

import { noteExternalPaymentBackgrounded, observePaymentReturn } from './flow-telemetry';

type WindowListener = (type: string, listener: EventListener) => void;
type DocumentListener = (type: string, listener: EventListener) => void;

export type PaymentReturnObserverEnv = {
  getPathname?: () => string;
  getVisibilityState?: () => DocumentVisibilityState;
  addWindowListener?: WindowListener;
  removeWindowListener?: WindowListener;
  addDocumentListener?: DocumentListener;
  removeDocumentListener?: DocumentListener;
};

let env: PaymentReturnObserverEnv = {};
let attached = false;

const pageHideListener: EventListener = () => {
  noteExternalPaymentBackgrounded();
};

const pageShowListener: EventListener = (event) => {
  const persisted = 'persisted' in event && Boolean((event as PageTransitionEvent).persisted);
  if (persisted) noteExternalPaymentBackgrounded();
  observePaymentReturn({
    source: 'webview_resume',
    route: currentPathname(),
  });
};

const focusListener: EventListener = () => {
  observePaymentReturn({
    source: 'webview_resume',
    route: currentPathname(),
  });
};

const visibilityListener: EventListener = () => {
  if (currentVisibility() === 'hidden') {
    noteExternalPaymentBackgrounded();
    return;
  }
  if (currentVisibility() !== 'visible') return;
  observePaymentReturn({
    source: 'webview_resume',
    route: currentPathname(),
  });
};

function currentPathname(): string {
  if (env.getPathname) return env.getPathname();
  if (typeof window === 'undefined') return '/';
  return window.location.pathname;
}

function currentVisibility(): DocumentVisibilityState {
  if (env.getVisibilityState) return env.getVisibilityState();
  if (typeof document === 'undefined') return 'visible';
  return document.visibilityState;
}

function addWindow(type: string, listener: EventListener): void {
  const add =
    env.addWindowListener ??
    ((eventType, eventListener) => {
      if (typeof window === 'undefined') return;
      window.addEventListener(eventType, eventListener);
    });
  add(type, listener);
}

function removeWindow(type: string, listener: EventListener): void {
  const remove =
    env.removeWindowListener ??
    ((eventType, eventListener) => {
      if (typeof window === 'undefined') return;
      window.removeEventListener(eventType, eventListener);
    });
  remove(type, listener);
}

function addDocument(type: string, listener: EventListener): void {
  const add =
    env.addDocumentListener ??
    ((eventType, eventListener) => {
      if (typeof document === 'undefined') return;
      document.addEventListener(eventType, eventListener);
    });
  add(type, listener);
}

function removeDocument(type: string, listener: EventListener): void {
  const remove =
    env.removeDocumentListener ??
    ((eventType, eventListener) => {
      if (typeof document === 'undefined') return;
      document.removeEventListener(eventType, eventListener);
    });
  remove(type, listener);
}

export function configurePaymentReturnObserverForTests(next?: PaymentReturnObserverEnv): void {
  detachPaymentReturnObserver();
  env = next ?? {};
}

export function attachPaymentReturnObserver(): void {
  if (attached) return;
  attached = true;
  addWindow('pagehide', pageHideListener);
  addWindow('pageshow', pageShowListener);
  addWindow('focus', focusListener);
  addDocument('visibilitychange', visibilityListener);
}

export function detachPaymentReturnObserver(): void {
  if (!attached) return;
  attached = false;
  removeWindow('pagehide', pageHideListener);
  removeWindow('pageshow', pageShowListener);
  removeWindow('focus', focusListener);
  removeDocument('visibilitychange', visibilityListener);
}
