import type { AlertEvaluation } from '@miniapp/shared';

const FORBIDDEN_KEY =
  /(?:tg_?id|order|pay_?url|signature|secret|token|key|init_?data|content|raw_?error|error_?(?:message|stack|body))/i;
const FORBIDDEN_VALUE = /(?:https?:\/\/|tgWebAppData|-----BEGIN|[a-f0-9]{32,})/i;

export interface SafeAlertCard {
  title: string;
  summary: string;
  severity: AlertEvaluation['severity'];
  transition: 'firing' | 'escalated' | 'recovered';
  incident_fingerprint: string;
  notification_key: string;
  metrics: Array<{ name: string; value: number; unit?: string }>;
  samples: Array<{ kind: string; reference: string; summary?: string }>;
  recommended_action?: string;
}

function safeText(value: string): boolean {
  return !FORBIDDEN_VALUE.test(value);
}

/** Re-check the already bounded shared envelope before it crosses the delivery boundary. */
export function createSafeAlertCard(
  evaluation: AlertEvaluation,
  transition: SafeAlertCard['transition'],
  notificationKey: string
): SafeAlertCard {
  for (const metric of evaluation.metrics) {
    if (FORBIDDEN_KEY.test(metric.name)) throw new Error('alert metric contains forbidden data');
  }
  for (const sample of evaluation.samples) {
    if (
      FORBIDDEN_KEY.test(sample.kind) ||
      !safeText(sample.reference) ||
      !safeText(sample.summary ?? '')
    ) {
      throw new Error('alert sample contains forbidden data');
    }
  }
  if (!safeText(evaluation.title) || !safeText(evaluation.summary)) {
    throw new Error('alert text contains forbidden data');
  }
  return {
    title: evaluation.title,
    summary: evaluation.summary,
    severity: evaluation.severity,
    transition,
    incident_fingerprint: evaluation.fingerprint,
    notification_key: notificationKey,
    metrics: evaluation.metrics.map((metric) => ({ ...metric })),
    samples: evaluation.samples.map((sample) => ({ ...sample })),
    ...(evaluation.recommended_action ? { recommended_action: evaluation.recommended_action } : {}),
  };
}
