/**
 * backend / scripts / invite-uat / run.ts
 *
 * 裂变邀请阶段三 UAT 的本地跑法。
 *
 *   pnpm --filter @miniapp/backend invite:uat
 *   pnpm --filter @miniapp/backend invite:uat -- --scenario concurrency_bind_http
 *   pnpm --filter @miniapp/backend invite:uat -- --snapshot /tmp/invite-uat.json
 *
 * 做的事：在随机端口起真实的 Fastify app，用 MOCK_AUTH 的 initData 打
 * /api/invite/* 四条路由，再回查 test 库断言邀请关系、发奖明细、钱包流水与归因字段；
 * 并发用例同时从库层直调 RPC，确认唯一约束在真实并发下兜底。
 *
 * 为什么是脚本而不是 vitest：它要占端口、写真库、单次跑几十秒，塞进 `pnpm test`
 * 会让每次提交都变慢且不稳定。定位是阶段验收与发布前手动跑一遍。
 *
 * ⚠️ 前提：packages/backend/.env 里 DATABASE_ENV=test 且 TEST_SUPABASE_* 齐备，
 *    且 105 / 106 / 108 迁移已在该库执行。脚本会拒绝在非 test 库上运行。
 */

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import type { ScenarioResult } from './scenarios.js';

interface CliArgs {
  snapshotPath: string | null;
  scenarioFilter: string | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { snapshotPath: null, scenarioFilter: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--snapshot') args.snapshotPath = argv[++i] ?? null;
    else if (flag === '--scenario') args.scenarioFilter = argv[++i] ?? null;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // 鉴权：MOCK_AUTH 让 verifyTelegramInitData 只解析 user 参数，不需要真实签名。
  process.env.MOCK_AUTH = '1';
  // DEV_AUTH_BYPASS 必须关：它会把「不带 header」的请求兜底成 tg_id=99999 的固定用户，
  // auth_guard 场景的 401 判据就永远测不到，而且会往真实用户身上写邀请数据。
  //
  // 覆盖成 '0' 而不是 delete：app.ts 的依赖链（@prisma/client）会再次加载 .env，
  // 而 dotenv 只填充「不存在」的变量——删掉会被重新填回 '1'，赋值才留得住。
  process.env.DEV_AUTH_BYPASS = '0';
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';

  const { config } = await import('../../platform/config.js');
  if (config.nodeEnv === 'production') {
    console.error('拒绝运行：NODE_ENV=production 时 MOCK_AUTH 旁路不生效，且不该在生产上跑。');
    process.exit(1);
  }
  if (config.database.environment !== 'test') {
    console.error(
      `拒绝运行：当前 DATABASE_ENV = ${config.database.environment}。本脚本会真的写邀请关系、发奖明细与钱包流水，只允许在 test 库上跑。`
    );
    process.exit(1);
  }
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    console.error('拒绝运行：TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_ROLE_KEY 未配置。');
    process.exit(1);
  }

  const { buildApp } = await import('../../app.js');
  const { sweepOrphanFixtures, readEntryEnabledRaw, readRewardRules } =
    await import('./fixtures.js');
  const { getTransientRetryCount } = await import('./client.js');
  const { SCENARIOS } = await import('./scenarios.js');

  // 打错场景名会跑出「0 个场景，全部通过」，这种假绿灯比报错危险得多。
  if (args.scenarioFilter && !SCENARIOS.some((s) => s.name === args.scenarioFilter)) {
    console.error(
      `未知场景 ${args.scenarioFilter}。可选：\n  ${SCENARIOS.map((s) => s.name).join('\n  ')}`
    );
    process.exit(1);
  }

  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const sweptCount = await sweepOrphanFixtures();
  const rulesBefore = await readRewardRules();
  const entryBefore = await readEntryEnabledRaw();

  console.log(`\n目标库：${config.database.projectRef}（${config.database.environment}）`);
  console.log(`后端：  ${baseUrl}`);
  console.log(`奖励规则：cap=${rulesBefore.total_cap_credits}，入口开关=${String(entryBefore)}`);
  if (sweptCount > 0) console.log(`已清理 ${sweptCount} 个上次异常退出遗留的测试用户`);
  console.log('');

  const results: ScenarioResult[] = [];
  try {
    for (const scenario of SCENARIOS) {
      if (args.scenarioFilter && scenario.name !== args.scenarioFilter) continue;
      process.stdout.write(`▶ ${scenario.name} ... `);
      try {
        const result = await scenario.run({ baseUrl });
        results.push(result);
        console.log(
          result.outcome === 'passed' ? `通过（${result.checks.length} 项断言）` : '未通过'
        );
      } catch (error) {
        console.log('异常');
        results.push({
          name: scenario.name,
          description: scenario.description,
          outcome: 'failed',
          checks: [
            {
              label: '场景执行抛出异常',
              passed: false,
              expected: '正常结束',
              actual: (error as Error).message,
            },
          ],
          observed: {},
        });
      }
    }
  } finally {
    await app.close();
  }

  console.log('\n────────────────────────── 结果 ──────────────────────────');
  for (const result of results) {
    console.log(`${result.outcome === 'passed' ? '✓' : '✗'} ${result.name}  ${result.description}`);
    for (const check of result.checks) {
      if (check.passed) continue;
      console.log(`    ✗ ${check.label}`);
      console.log(`      期望：${JSON.stringify(check.expected)}`);
      console.log(`      实际：${JSON.stringify(check.actual)}`);
    }
    if (Object.keys(result.observed).length > 0) {
      console.log(`    · ${JSON.stringify(result.observed)}`);
    }
  }

  // 共享配置必须原样归还：任何场景改过 runtime_config 都要在自己的 finally 里还原，
  // 这里是最后一道核对，不通过就当失败处理（否则会污染 test 环境）。
  const rulesAfter = await readRewardRules();
  const entryAfter = await readEntryEnabledRaw();
  const configIntact =
    JSON.stringify(rulesBefore) === JSON.stringify(rulesAfter) &&
    JSON.stringify(entryBefore) === JSON.stringify(entryAfter);
  console.log(
    configIntact
      ? '\n✓ runtime_config 已原样还原（奖励规则 / 入口开关）'
      : '\n✗ runtime_config 未还原，请手动核对 miniapp_invite_reward_rules / miniapp_invite_entry_enabled'
  );

  const leftover = await sweepOrphanFixtures();
  console.log(
    leftover === 0 ? '✓ 测试数据零残留' : `✗ 仍有 ${leftover} 个用户未被场景清理（已在此补清）`
  );

  // 抖动次数不影响判定，但要显式打出来：数字异常高说明本机到 Supabase 的链路有问题，
  // 而不是"用例都过了就没事"。
  const retries = getTransientRetryCount();
  console.log(
    retries === 0 ? '✓ 无 500 重试' : `· 期间发生 ${retries} 次 500 重试（本机到 Supabase 抖动）`
  );

  const failed = results.filter((result) => result.outcome === 'failed');
  console.log(`\n通过 ${results.length - failed.length} / 未通过 ${failed.length}`);

  if (args.snapshotPath) {
    const snapshot = {
      schema_version: 1,
      database: config.database.projectRef,
      generated_at: new Date().toISOString(),
      config_intact: configIntact,
      scenarios: results.map((result) => ({
        name: result.name,
        outcome: result.outcome,
        check_count: result.checks.length,
        failed_checks: result.checks.filter((check) => !check.passed),
        observed: result.observed,
      })),
    };
    writeFileSync(args.snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    console.log(`\n快照已写入 ${args.snapshotPath}`);
  }

  process.exit(failed.length > 0 || !configIntact ? 1 : 0);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
