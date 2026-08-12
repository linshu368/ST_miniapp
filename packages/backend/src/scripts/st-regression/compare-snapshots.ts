/**
 * backend / scripts / st-regression / compare-snapshots.ts
 *
 *   pnpm --filter @miniapp/backend st:regression:diff -- /tmp/before.json /tmp/after.json
 *
 * 对拍两份 run.ts --snapshot 产出的快照。
 *
 * 这是「M3a 行为零变化」真正的判据。单看断言只能证明重构后的行为符合我对旧行为的**理解**，
 * 而对拍是拿旧代码的实际输出当基准——理解错了也能被抓出来。
 *
 * 快照里的观测值已经在 scenarios.ts 里剔除过 id 与时间戳，所以任何差异都值得看一眼。
 */

import { readFileSync } from 'node:fs';

interface Snapshot {
  schema_version: number;
  scenarios: Array<{
    name: string;
    outcome: string;
    observed: Record<string, unknown>;
  }>;
}

interface Difference {
  path: string;
  before: unknown;
  after: unknown;
}

function readSnapshot(path: string): Snapshot {
  return JSON.parse(readFileSync(path, 'utf8')) as Snapshot;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function diff(before: unknown, after: unknown, path: string, out: Difference[]): void {
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      diff(before[key], after[key], path ? `${path}.${key}` : key, out);
    }
    return;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) {
      out.push({ path: `${path}.length`, before: before.length, after: after.length });
    }
    for (let i = 0; i < Math.max(before.length, after.length); i += 1) {
      diff(before[i], after[i], `${path}[${i}]`, out);
    }
    return;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    out.push({ path, before, after });
  }
}

// pnpm 会把分隔用的 `--` 原样透传下来，位置参数解析要先把它滤掉。
const [beforePath, afterPath] = process.argv.slice(2).filter((arg) => arg !== '--');
if (!beforePath || !afterPath) {
  console.error(
    'Usage: pnpm --filter @miniapp/backend st:regression:diff -- <before.json> <after.json>'
  );
  process.exit(1);
}

const before = readSnapshot(beforePath);
const after = readSnapshot(afterPath);

if (before.schema_version !== after.schema_version) {
  console.error(
    `两份快照的 schema_version 不同（${before.schema_version} vs ${after.schema_version}），说明场景定义本身变过，对拍无意义。`
  );
  process.exit(1);
}

const names = new Set([
  ...before.scenarios.map((scenario) => scenario.name),
  ...after.scenarios.map((scenario) => scenario.name),
]);

let totalDifferences = 0;
for (const name of names) {
  const beforeScenario = before.scenarios.find((scenario) => scenario.name === name);
  const afterScenario = after.scenarios.find((scenario) => scenario.name === name);

  if (!beforeScenario || !afterScenario) {
    console.log(`✗ ${name}：只在 ${beforeScenario ? beforePath : afterPath} 里出现`);
    totalDifferences += 1;
    continue;
  }

  const differences: Difference[] = [];
  if (beforeScenario.outcome !== afterScenario.outcome) {
    differences.push({
      path: 'outcome',
      before: beforeScenario.outcome,
      after: afterScenario.outcome,
    });
  }
  diff(beforeScenario.observed, afterScenario.observed, 'observed', differences);

  if (differences.length === 0) {
    console.log(`✓ ${name}`);
    continue;
  }

  console.log(`✗ ${name}`);
  for (const difference of differences) {
    console.log(`    ${difference.path}`);
    console.log(`      before: ${JSON.stringify(difference.before)}`);
    console.log(`      after:  ${JSON.stringify(difference.after)}`);
  }
  totalDifferences += differences.length;
}

console.log(
  totalDifferences === 0
    ? '\n两份快照完全一致。'
    : `\n共 ${totalDifferences} 处差异，逐条确认是有意变更还是回归。`
);
process.exit(totalDifferences === 0 ? 0 : 1);
