import { loadLogAlertPolicy } from './alert-config.js';

try {
  // Explicit CI validation reads the file even though production alerting defaults off.
  const policy = loadLogAlertPolicy('true');
  process.stdout.write(
    JSON.stringify({
      success: true,
      version: 1,
      rules: policy.rules.length,
      enabled_rules: policy.rules.filter((rule) => rule.enabled).length,
    }) + '\n'
  );
} catch {
  process.stderr.write('LOG_ALERT_CONFIG_INVALID\n');
  process.exitCode = 1;
}
