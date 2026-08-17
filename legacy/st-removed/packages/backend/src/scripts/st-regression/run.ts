/**
 * backend / scripts / st-regression / run.ts
 *
 * §7.3 ST 链路回归的本地跑法。
 *
 *   pnpm --filter @miniapp/backend st:regression
 *   pnpm --filter @miniapp/backend st:regression -- --snapshot /tmp/after.json
 *   pnpm --filter @miniapp/backend st:regression -- --scenario upstream_error
 *   pnpm --filter @miniapp/backend st:regression -- --seed-free-model
 *
 * --seed-free-model 会临时往共享的模型目录里插一个 markup = 0 的模型再还原（test 库目前
 * 一个免费模型都没有，免费额度那条判据只能这么跑）。它动的是别人也在读的配置，别在
 * 有人调试 test 环境时开。
 *
 * 做的事：起一个假上游 + 在随机端口起真实的 Fastify app + 用自签 platformToken 打
 * /api/platform/llm-proxy/v1/chat/completions，然后查 test 库断言落库与计费。
 *
 * 为什么不是集成测试而是脚本：它要占端口、要写真库、单次跑十几秒，塞进 `pnpm test`
 * 会让每次提交都变慢且不稳定。它的定位是「上线前手动跑一遍」，与 §7.3 的性质一致。
 *
 * ⚠️ 前提：packages/backend/.env 里 DATABASE_ENV=test 且 TEST_SUPABASE_* 齐备。
 *    脚本会拒绝在非 test 库上运行——它会真的写 chat_history 和扣费明细。
 *
 * 对拍用法（这才是「行为零变化」的判据，见 compare-snapshots.ts）：
 *   git stash && git checkout <重构前的 commit>
 *   pnpm --filter @miniapp/backend st:regression -- --snapshot /tmp/before.json
 *   git checkout - && git stash pop
 *   pnpm --filter @miniapp/backend st:regression -- --snapshot /tmp/after.json
 *   pnpm --filter @miniapp/backend st:regression:diff -- /tmp/before.json /tmp/after.json
 */

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { startMockUpstream } from './mock-upstream.js';
// 只导入类型：编译后会被抹掉，不会在设置环境变量之前把后端模块拉起来。
import type { ScenarioResult } from './scenarios.js';

interface CliArgs {
  snapshotPath: string | null;
  scenarioFilter: string | null;
  emitGenerationId: boolean;
  seedFreeModel: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    snapshotPath: null,
    scenarioFilter: null,
    emitGenerationId: false,
    seedFreeModel: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--snapshot') args.snapshotPath = argv[++i] ?? null;
    else if (flag === '--scenario') args.scenarioFilter = argv[++i] ?? null;
    else if (flag === '--generation-id') args.emitGenerationId = true;
    else if (flag === '--seed-free-model') args.seedFreeModel = true;
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // ── 假上游必须先起来 ────────────────────────────────────────────────────────
  // features/generation/upstream.ts 和 lib/chat-history-logger.ts 都在**模块加载时**
  // 读环境变量，所以 LLM_UPSTREAM_URL / LLM_API_KEY 必须在 import 任何后端模块之前设好。
  // 下面所有后端模块因此都走动态 import，顺序不能调。
  const upstream = await startMockUpstream({ emitGenerationId: args.emitGenerationId });
  process.env.LLM_UPSTREAM_URL = upstream.url;
  process.env.LLM_API_KEY = process.env.LLM_API_KEY || 'st-regression-fake-key';
  // 后台同步任务与本次回归无关，开着只会往日志里灌噪音。
  process.env.CHAT_HISTORY_SYNC_ENABLED = 'false';
  // 默认只留 warn 以上，否则每轮请求的 pino 输出会把断言结果冲掉。排障时 LOG_LEVEL=info 覆盖。
  process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'warn';
  // 签发与验签读同一个变量，本地不需要真实密钥。
  process.env.LLM_PROXY_TOKEN_SECRET =
    process.env.LLM_PROXY_TOKEN_SECRET || 'st-regression-token-secret';

  const { config } = await import('../../platform/config.js');
  if (config.database.environment !== 'test') {
    await upstream.close();
    console.error(
      `拒绝运行：当前 DATABASE_ENV = ${config.database.environment}。本脚本会真的写 chat_history 与扣费明细，只允许在 test 库上跑。`
    );
    process.exit(1);
  }
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    await upstream.close();
    console.error('拒绝运行：TEST_SUPABASE_URL / TEST_SUPABASE_SERVICE_ROLE_KEY 未配置。');
    process.exit(1);
  }

  const { buildApp } = await import('../../app.js');
  const {
    pickCatalogModels,
    seedFixtures,
    cleanupFixtures,
    seedFreeModelIntoCatalog,
    sweepOrphanFixtures,
  } = await import('./fixtures.js');
  const { SCENARIOS } = await import('./scenarios.js');

  // 打错场景名会跑出「0 个场景，全部通过」，这种假绿灯比报错危险得多。
  if (args.scenarioFilter && !SCENARIOS.some((s) => s.name === args.scenarioFilter)) {
    await upstream.close();
    console.error(
      `未知场景 ${args.scenarioFilter}。可选：${SCENARIOS.map((s) => s.name).join(', ')}`
    );
    process.exit(1);
  }

  // 目录是共享配置，改了必须还原：进程被 Ctrl-C 掉也不能留下脏数据。
  let catalogOverride: Awaited<ReturnType<typeof seedFreeModelIntoCatalog>> | null = null;
  const restoreCatalog = async () => {
    if (!catalogOverride) return;
    const pending = catalogOverride;
    catalogOverride = null;
    await pending.restore();
  };
  if (args.seedFreeModel) {
    catalogOverride = await seedFreeModelIntoCatalog();
    process.once('SIGINT', () => {
      void restoreCatalog().finally(() => process.exit(130));
    });
  }

  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  const sweptCount = await sweepOrphanFixtures();
  const models = await pickCatalogModels();
  const fixtures = await seedFixtures();
  const results: ScenarioResult[] = [];

  console.log(`\n目标库：${config.database.projectRef}（${config.database.environment}）`);
  console.log(`假上游：${upstream.url}`);
  console.log(`后端：  ${baseUrl}`);
  console.log(
    `模型：  免费=${models.free?.openRouterModelId ?? '无'} / 付费=${models.paid?.openRouterModelId ?? '无'}`
  );
  console.log(`测试用户：${fixtures.userId}`);
  if (sweptCount > 0) console.log(`已清理 ${sweptCount} 组上次异常退出遗留的测试数据`);
  console.log('');

  try {
    for (const scenario of SCENARIOS) {
      if (args.scenarioFilter && scenario.name !== args.scenarioFilter) continue;
      process.stdout.write(`▶ ${scenario.name} ... `);
      try {
        const result = await scenario.run({
          baseUrl,
          upstream,
          fixtures,
          freeModel: models.free,
          paidModel: models.paid,
        });
        results.push(result);
        if (result.outcome === 'skipped') console.log(`跳过（${result.skipReason}）`);
        else if (result.outcome === 'passed') console.log(`通过（${result.checks.length} 项断言）`);
        else console.log('未通过');
      } catch (error) {
        console.log('异常');
        results.push({
          name: scenario.name,
          description: '',
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
    await cleanupFixtures(fixtures);
    await restoreCatalog();
    await app.close();
    await upstream.close();
  }

  // ── 汇总 ────────────────────────────────────────────────────────────────────
  console.log('\n────────────────────────── 结果 ──────────────────────────');
  for (const result of results) {
    const mark = result.outcome === 'passed' ? '✓' : result.outcome === 'skipped' ? '−' : '✗';
    console.log(`${mark} ${result.name}  ${result.description}`);
    for (const check of result.checks) {
      if (check.passed) continue;
      console.log(`    ✗ ${check.label}`);
      console.log(`      期望：${JSON.stringify(check.expected)}`);
      console.log(`      实际：${JSON.stringify(check.actual)}`);
    }
  }

  const failed = results.filter((result) => result.outcome === 'failed');
  const skipped = results.filter((result) => result.outcome === 'skipped');
  console.log(
    `\n通过 ${results.length - failed.length - skipped.length} / 未通过 ${failed.length} / 跳过 ${skipped.length}`
  );
  console.log(
    '\n注意：§7.3 第 4 条（simulation 链路）不在本脚本覆盖内，simulation 跑在独立 project 且连生产库。'
  );
  console.log(
    '      402 的 statusMessage 本地只能验到「后端发出去了」，能否穿过 nginx / Vercel 需在真实环境确认。'
  );

  if (args.snapshotPath) {
    const snapshot = {
      // 版本号只用于 diff 时确认两份快照来自同一套场景定义
      schema_version: 1,
      scenarios: results.map((result) => ({
        name: result.name,
        outcome: result.outcome,
        observed: result.observed,
      })),
    };
    writeFileSync(args.snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    console.log(`\n快照已写入 ${args.snapshotPath}`);
  }

  process.exit(failed.length > 0 ? 1 : 0);
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
