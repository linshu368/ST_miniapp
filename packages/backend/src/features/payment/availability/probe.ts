import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import type { PaymentType } from '@miniapp/shared';
import type {
  PaymentGateway,
  PaymentGatewayErrorClass,
} from '../../../infrastructure/payment/PaymentGateway.js';
import { createEpayOrderId } from '../../../infrastructure/payment/epay-protocol.js';

export interface PaymentProbeSettings {
  enabled: boolean;
  preview: boolean;
  channel: string;
}

export interface PaymentAvailabilityObservation {
  kind: 'available' | 'unavailable';
  channel: PaymentType;
  startedAt: string;
  observedAt: string;
  durationMs: number;
  errorClass?: PaymentGatewayErrorClass;
}

export type PaymentProbeResult =
  | PaymentAvailabilityObservation
  | { kind: 'skipped'; reason: 'disabled' | 'preview' | 'aborted' }
  | {
      kind: 'configuration_error';
      reason: 'invalid_channel' | 'gateway_configuration';
    };

export function paymentProbeGuard(settings: PaymentProbeSettings): PaymentProbeResult | null {
  if (settings.preview) return { kind: 'skipped', reason: 'preview' };
  if (!settings.enabled) return { kind: 'skipped', reason: 'disabled' };
  if (settings.channel !== 'alipay' && settings.channel !== 'wxpay') {
    return { kind: 'configuration_error', reason: 'invalid_channel' };
  }
  return null;
}

/** Container-local address only; discovering a public egress IP would add another network dependency. */
export function resolvePaymentProbeClientIp(
  interfaces?: ReturnType<typeof networkInterfaces>
): string {
  try {
    for (const addresses of Object.values(interfaces ?? networkInterfaces())) {
      const candidate = addresses?.find(
        (address) => !address.internal && isIP(address.address) === 4
      );
      if (candidate) return candidate.address;
    }
  } catch {
    // Local interface inspection failure says nothing about upstream payment availability.
  }
  return '127.0.0.1';
}

/** One ephemeral upstream order: no order repository, reconciliation, or operation-event dependency. */
export async function probePaymentAvailability(input: {
  settings: PaymentProbeSettings;
  gateway: Pick<PaymentGateway, 'createPayment'>;
  signal: AbortSignal;
}): Promise<PaymentProbeResult> {
  const guarded = paymentProbeGuard(input.settings);
  if (guarded) return guarded;
  if (input.signal.aborted) return { kind: 'skipped', reason: 'aborted' };
  const channel = input.settings.channel as PaymentType;
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let errorClass: PaymentGatewayErrorClass | undefined;
  try {
    const result = await input.gateway.createPayment(
      {
        orderId: createEpayOrderId(),
        amount: '1.00',
        type: channel,
        description: '星尘',
        clientIp: resolvePaymentProbeClientIp(),
      },
      input.signal
    );
    // A shutdown is not a failed provider observation and must never recover an incident.
    if (input.signal.aborted) return { kind: 'skipped', reason: 'aborted' };
    if (result.errorClass === 'configuration') {
      return { kind: 'configuration_error', reason: 'gateway_configuration' };
    }
    if (!result.success || !result.paymentUrl || !result.providerTransactionId) {
      errorClass = result.errorClass ?? 'response_invalid';
    }
  } catch {
    if (input.signal.aborted) return { kind: 'skipped', reason: 'aborted' };
    // Transport errors can contain credentials/URLs. Only carry a stable class across this boundary.
    errorClass = 'network';
  }
  return {
    kind: errorClass ? 'unavailable' : 'available',
    channel,
    startedAt,
    observedAt: new Date().toISOString(),
    durationMs: Math.max(0, Math.round(performance.now() - start)),
    ...(errorClass ? { errorClass } : {}),
  };
}
