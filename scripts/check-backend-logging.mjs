import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = 'packages/backend/src';
const scheduled = new Set([
  'expire-payment-orders.ts',
  'reconcile-payment-orders.ts',
  'send-vip-expiry-reminders.ts',
  'payment-availability-probe.ts',
  'payment-alert-monitor.ts',
]);
const problems = [];
let checked = 0;
function visit(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) {
      visit(filename);
      continue;
    }
    if (
      !entry.name.endsWith('.ts') ||
      entry.name.endsWith('.test.ts') ||
      entry.name.endsWith('.d.ts')
    )
      continue;
    const path = relative(root, filename).replaceAll('\\', '/');
    // Offline import/replay/report CLIs have an intentional human/JSON stdout contract.
    if (path.startsWith('scripts/') && !scheduled.has(entry.name)) continue;
    checked++;
    const source = readFileSync(filename, 'utf8');
    if (/\bconsole\s*\.\s*(?:log|info|warn|error|debug)\s*\(/.test(source))
      problems.push(`${path}: use structured Pino/observation instead of console`);
    if (
      /\b(?:globalThis\.)?fetch\s*\(/.test(source) &&
      !/\b(?:clientFetch|observedFetch)\b/.test(source)
    )
      problems.push(`${path}: register the transport with observedFetch/clientFetch`);
    if (/\bglobalThis\.fetch\s*=/.test(source))
      problems.push(`${path}: global fetch replacement is not allowed`);
  }
}
visit(root);
if (problems.length) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Backend logging guard passed (${checked} runtime files; offline CLI output excluded).`
  );
