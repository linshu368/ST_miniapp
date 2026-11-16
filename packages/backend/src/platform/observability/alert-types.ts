/** Narrow, channel-independent metadata. Never pass an application log/DTO as a notification. */
export interface AlertLog {
  event_id: string;
  event: string;
  operation: string;
  module?: string;
  business_module?: string;
  level: number;
  error_code?: string;
  public_error_code?: string;
  outcome?: string;
  http_status?: number;
  upstream_status?: number;
  duration_ms?: number;
}

export interface LogAlertCard {
  title: string;
  summary: string;
  severity: 'P0' | 'P1' | 'P2';
  transition: 'firing';
  incident_fingerprint: string;
  notification_key: string;
  metrics: Array<{ name: string; value: number; unit?: string }>;
  samples: Array<{ kind: string; reference: string; summary?: string }>;
}

export type LogAlertDeliveryResult =
  | { kind: 'succeeded' }
  | { kind: 'retryable' | 'permanent'; errorClass?: string };

export interface LogAlertDelivery {
  deliver(card: LogAlertCard, timeoutMs: number): Promise<LogAlertDeliveryResult>;
}

export interface LogAlertPresentation {
  serviceName?: string;
  logLookupHint?: string;
}
