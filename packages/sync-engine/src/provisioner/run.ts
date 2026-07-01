/**
 * sync-engine / provisioner / run.ts
 *
 * CLI 入口脚本。
 * 用法：
 *   pnpm provision --user-id=<uuid>
 *   pnpm provision --user-id=<uuid> --force
 */

import 'dotenv/config';
import { provision, ProvisionError } from './index.js';

// ─── 解析命令行参数 ────────────────────────────────────────────────────────────
function parseArgs(): { userId: string; force: boolean } {
  const args = process.argv.slice(2);
  let userId = '';
  let force = false;

  for (const arg of args) {
    if (arg.startsWith('--user-id=')) {
      userId = arg.replace('--user-id=', '').trim();
    } else if (arg === '--force') {
      force = true;
    }
  }

  if (!userId) {
    console.error('❌ 缺少必填参数 --user-id=<uuid>');
    console.error('用法：pnpm provision --user-id=<uuid> [--force]');
    process.exit(1);
  }

  return { userId, force };
}

// ─── 主流程 ────────────────────────────────────────────────────────────────────
async function main() {
  const { userId, force } = parseArgs();

  console.log(`\n🚀 ST_miniapp 同步引擎 — 初始化分发器`);
  console.log(`   user_id : ${userId}`);
  console.log(`   模式    : ${force ? '全量覆盖 (--force)' : '增量补全（默认）'}\n`);

  try {
    const result = await provision(userId, {
      force,
      log: (msg) => console.log(msg),
    });

    console.log('\n─────────────────────────────────────────');
    console.log('📊 执行摘要：');
    console.log(`   st_handle     : ${result.stHandle}`);
    console.log(`   角色卡写入    : ${result.charactersWritten} 张`);
    console.log(`   角色卡跳过    : ${result.charactersSkipped} 张`);
    if (result.charactersMissing > 0) {
      console.log(`   角色卡缺失    : ${result.charactersMissing} 张 ⚠️`);
    }
    console.log(`   预设写入      : ${result.presetsWritten} 条`);
    console.log(`   预设跳过      : ${result.presetsSkipped} 条`);
    if (result.hadInvalidRef) {
      console.log(`   character_ref : 已回退到默认卡 ⚠️  (原值='${result.invalidRefValue}')`);
    }
    console.log(`   首次初始化    : ${result.alreadyInitialized ? '否（重新投影）' : '是'}`);
    console.log('─────────────────────────────────────────');
    console.log('✅ 初始化完成\n');
  } catch (err) {
    if (err instanceof ProvisionError) {
      console.error(`\n❌ 初始化失败：${err.message}`);
    } else {
      console.error(`\n❌ 未知错误：${err}`);
    }
    process.exit(1);
  }
}

main();
