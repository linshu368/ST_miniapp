import type { AlertEvaluation } from '@miniapp/shared';
import type { AlertPublisher } from '../../../alerting/publisher.js';
import type { PaymentAvailabilityStrategy } from '../strategy.js';
import { createFeishuAlertStrategy } from './feishu-alert.js';

/** Register additional independent strategies here; one and many use the same bounded executor. */
export function createPaymentAvailabilityStrategies(
  publisher: Pick<AlertPublisher, 'publish'>,
  environment: AlertEvaluation['environment']
): readonly PaymentAvailabilityStrategy[] {
  return [createFeishuAlertStrategy(publisher, environment)];
}
