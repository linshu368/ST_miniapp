import '../platform/config.js';
import { createLogger } from '../lib/logger.js';
import { closeSupabaseClient } from '../lib/supabase.js';
import {
  createVipReminderStore,
  parseVipReminderArgs,
  readVipRemindersConfig,
  runVipExpiryReminders,
} from '../features/vip/vip-expiry-reminder.js';

const log = createLogger('vip');
let exitCode = 0;

try {
  const args = parseVipReminderArgs(process.argv.slice(2));
  const summary = await runVipExpiryReminders({
    mode: args.mode,
    limit: args.limit,
    store: createVipReminderStore(),
    readConfig: readVipRemindersConfig,
    log: {
      info: (bindings, message) => log.sys.info(bindings, message),
      warn: (bindings, message) => log.sys.warn(bindings, message),
      error: (bindings, message) => log.sys.error(bindings, message),
    },
  });
  console.log(JSON.stringify(summary));
  if (summary.failed > 0) exitCode = 1;
} catch (error) {
  log.sys.error({ event: 'vip.reminder.failed', err: error }, 'VIP 到期提醒任务失败');
  exitCode = 1;
} finally {
  try {
    await closeSupabaseClient();
  } catch (error) {
    log.sys.error({ event: 'vip.reminder.cleanup_failed', err: error }, 'VIP 到期提醒资源清理失败');
    exitCode = 1;
  }
  process.exit(exitCode);
}
