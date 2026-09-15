'use client';

import {
  isForbiddenTelemetryPropertyKey,
  parseReplayTelemetryEvent,
  type ReplaySdkFailureCode,
  type ReplayTelemetryEvent,
} from '@miniapp/shared';

import { createLogger } from '@/lib/logger';
import { sendSentryLog } from '@/lib/sentry/client';

import { POSTHOG_JS_DEFAULTS, resolvePostHogConfig, type PostHogBrowserEnv } from './config';
import { buildSessionRecordingOptions } from './masking';

const log = createLogger('telemetry');

const START_RECORDING_OVERRIDE = {
  sampling: true,
  linked_flag: true,
  url_trigger: true as const,
  event_trigger: true as const,
};

type JsonValue = string | number | boolean | null;
type SessionPropertyMap = Record<string, JsonValue>;

export type PostHogClient = {
  init: (key: string, config: Record<string, unknown>) => void;
  identify: (distinctId: string, properties?: SessionPropertyMap) => void;
  setPersonProperties: (properties: SessionPropertyMap) => void;
  register_for_session: (properties: SessionPropertyMap) => void;
  capture: (event: string, properties?: Record<string, unknown>) => void;
  startSessionRecording: (override?: typeof START_RECORDING_OVERRIDE | true) => void;
  stopSessionRecording: () => void;
  sessionRecordingStarted: () => boolean;
};

export type PostHogSdkModule = { default: PostHogClient };

export type PostHogAdapterDeps = {
  env?: PostHogBrowserEnv;
  loadSdk?: () => Promise<PostHogSdkModule>;
  now?: () => Date;
  isBrowser?: () => boolean;
};

function defaultLoadSdk(): Promise<PostHogSdkModule> {
  return import('posthog-js') as Promise<PostHogSdkModule>;
}

function occurredAt(now: () => Date): string {
  return now().toISOString();
}

function fingerprintEvent(event: ReplayTelemetryEvent): string | null {
  switch (event.event) {
    case 'replay_chat_started':
    case 'replay_chat_ended':
      return `${event.event}:${event.replay_context_id}`;
    case 'replay_sdk_init_failed':
    case 'replay_recording_failed':
      return `${event.event}:${event.failure_code}:${event.replay_context_id ?? ''}`;
    case 'payment_order_status_observed':
    case 'payment_order_settled':
    case 'payment_order_failed':
      return `${event.event}:${event.order_id}:${event.order_status}:${String(event.settled_by)}`;
    default:
      return null;
  }
}

export function createPostHogAdapter(deps: PostHogAdapterDeps = {}) {
  const now = deps.now ?? (() => new Date());
  const loadSdk = deps.loadSdk ?? defaultLoadSdk;
  const isBrowser = deps.isBrowser ?? (() => typeof window !== 'undefined');
  const seen = new Set<string>();
  let initPromise: Promise<boolean> | undefined;
  let client: PostHogClient | undefined;
  let distinctId: string | undefined;
  let disabled = false;
  let lastHealthKey: string | undefined;

  function reportHealth(
    event: 'replay_sdk_init_failed' | 'replay_recording_failed',
    failureCode: ReplaySdkFailureCode,
    replayContextId?: string
  ): void {
    const key = `${event}:${failureCode}:${replayContextId ?? ''}`;
    if (lastHealthKey === key) return;
    lastHealthKey = key;

    sendSentryLog('warn', event, { failure_code: failureCode });
    log.warn(event, { failure_code: failureCode });

    if (!client || disabled) return;
    capture({
      event,
      occurred_at: occurredAt(now),
      failure_code: failureCode,
      ...(distinctId ? { telegram_user_id: distinctId } : {}),
      ...(replayContextId ? { replay_context_id: replayContextId } : {}),
    });
  }

  function capture(event: ReplayTelemetryEvent | Record<string, unknown>): boolean {
    if (disabled || !client) return false;

    const result = requireSafeEvent(event);
    if (!result) {
      const eventName = typeof event.event === 'string' ? event.event : '';
      if (eventName === 'replay_sdk_init_failed' || eventName === 'replay_recording_failed') {
        return false;
      }
      reportHealth('replay_recording_failed', 'event_rejected');
      return false;
    }

    const fingerprint = fingerprintEvent(result);
    if (fingerprint) {
      if (seen.has(fingerprint)) return false;
      seen.add(fingerprint);
    }

    const { event: eventName, ...properties } = result;
    try {
      client.capture(eventName, properties);
      return true;
    } catch {
      reportHealth('replay_recording_failed', 'network_failed', result.replay_context_id);
      return false;
    }
  }

  async function init(telegramUserId: string): Promise<boolean> {
    if (disabled) return false;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      if (!isBrowser()) {
        disabled = true;
        return false;
      }

      const config = resolvePostHogConfig(deps.env);
      if (!config.ok) {
        disabled = true;
        reportHealth('replay_sdk_init_failed', config.failureCode);
        return false;
      }

      try {
        const mod = await loadSdk();
        const sdk = mod.default;
        sdk.init(config.key, {
          api_host: config.host,
          defaults: POSTHOG_JS_DEFAULTS,
          disable_session_recording: true,
          autocapture: false,
          capture_pageview: false,
          capture_pageleave: false,
          capture_dead_clicks: false,
          rageclick: false,
          disable_surveys: true,
          enable_recording_console_log: false,
          capture_performance: false,
          person_profiles: 'identified_only',
          persistence: 'localStorage+cookie',
          session_recording: buildSessionRecordingOptions(),
        });
        sdk.identify(telegramUserId);
        client = sdk;
        distinctId = telegramUserId;
        return true;
      } catch {
        disabled = true;
        client = undefined;
        reportHealth('replay_sdk_init_failed', 'init_failed');
        return false;
      }
    })();

    return initPromise;
  }

  return {
    init,
    isReady(): boolean {
      return Boolean(client) && !disabled;
    },
    getDistinctId(): string | undefined {
      return distinctId;
    },
    identify(telegramUserId: string): void {
      if (!client || disabled) return;
      try {
        client.identify(telegramUserId);
        distinctId = telegramUserId;
      } catch {
        reportHealth('replay_sdk_init_failed', 'init_failed');
      }
    },
    setPersonProperties(properties: SessionPropertyMap): void {
      if (!client || disabled) return;
      try {
        client.setPersonProperties(properties);
      } catch {
        reportHealth('replay_recording_failed', 'network_failed');
      }
    },
    registerSessionProperties(properties: SessionPropertyMap): void {
      if (!client || disabled) return;
      try {
        client.register_for_session(properties);
      } catch {
        reportHealth('replay_recording_failed', 'network_failed');
      }
    },
    startNewRecording(replayContextId?: string): boolean {
      if (!client || disabled) return false;
      try {
        if (client.sessionRecordingStarted()) {
          client.stopSessionRecording();
        }
        client.startSessionRecording(START_RECORDING_OVERRIDE);
        return true;
      } catch {
        reportHealth('replay_recording_failed', 'recording_failed', replayContextId);
        return false;
      }
    },
    stopRecording(replayContextId?: string): void {
      if (!client || disabled) return;
      try {
        if (client.sessionRecordingStarted()) {
          client.stopSessionRecording();
        }
      } catch {
        reportHealth('replay_recording_failed', 'recording_failed', replayContextId);
      }
    },
    capture,
    reportHealth,
  };
}

function requireSafeEvent(
  event: ReplayTelemetryEvent | Record<string, unknown>
): ReplayTelemetryEvent | null {
  for (const key of Object.keys(event)) {
    if (isForbiddenTelemetryPropertyKey(key)) return null;
  }
  try {
    return parseReplayTelemetryEvent(event);
  } catch {
    return null;
  }
}

export type PostHogAdapter = ReturnType<typeof createPostHogAdapter>;

let adapter: PostHogAdapter | undefined;

export function getPostHogAdapter(): PostHogAdapter {
  if (!adapter) adapter = createPostHogAdapter();
  return adapter;
}

export function resetPostHogAdapterForTests(next?: PostHogAdapter): void {
  adapter = next;
}
