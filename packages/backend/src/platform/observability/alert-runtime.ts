import { FeishuAlertSink } from '../../features/alerting/feishu-alert-sink.js';
import { observation } from './runtime.js';
import { getLogAlertSettings } from '../runtime-config.js';
import { createLogAlerts } from './log-alerts.js';
import { subscribeLogAlerts } from './log-channel.js';

let active: { references: number; stop: () => Promise<void> } | undefined;

export function startLogAlerts(): () => Promise<void> {
  const policy = getLogAlertSettings();
  if (!policy.enabled) return async () => {};
  if (!active) {
    const sink = new FeishuAlertSink(policy.webhookUrl);
    if (!sink.configured()) throw new Error('Log alerts require a valid Feishu webhook');
    const alerts = createLogAlerts(policy, sink, (reason, count) => {
      observation.emit(
        `observability.alert.${reason}`,
        'observability.alert',
        { outcome: 'degraded', count },
        'warn'
      );
    });
    const unsubscribe = subscribeLogAlerts(alerts.accept);
    active = {
      references: 0,
      stop: async () => {
        unsubscribe();
        await alerts.close();
      },
    };
  }
  const registration = active;
  registration.references++;
  let stopped = false;
  return async () => {
    if (stopped) return;
    stopped = true;
    registration.references--;
    if (registration.references === 0) {
      active = undefined;
      await registration.stop();
    }
  };
}
