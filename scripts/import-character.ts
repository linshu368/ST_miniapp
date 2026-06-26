#!/usr/bin/env npx tsx
/**
 * import-character.ts — 角色卡上架工具
 *
 * 将一张酒馆角色卡 PNG 上传到 Supabase Storage 并写入 miniapp.characters 表。
 *
 * 用法：
 *   pnpm import-character <png-path> -- [options]
 *
 * 示例：
 *   pnpm import-character ./角色卡.png -- --env scripts/.env.test
 *   pnpm import-character ./角色卡.png -- --env scripts/.env.prod --sort-order 1
 *
 * 完整文档见 docs/角色卡上架操作手册.md
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { config as loadDotenv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

// ─── PNG chara card 解析（内联，避免 shared 包的 Node.js 依赖限制） ──────────

interface CharaCardData {
  spec: string;
  spec_version: string;
  data: {
    name: string;
    description?: string;
    personality?: string;
    scenario?: string;
    first_mes?: string;
    mes_example?: string;
    creator_notes?: string;
    system_prompt?: string;
    post_history_instructions?: string;
    alternate_greetings?: string[];
    tags?: string[];
    creator?: string;
    character_version?: string;
    extensions?: Record<string, unknown>;
    character_book?: Record<string, unknown>;
  };
}

function extractCharaCardFromPng(pngPath: string): CharaCardData {
  const buf = readFileSync(pngPath);
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error(`Not a valid PNG: ${pngPath}`);
  }

  let p = 8;
  let bestPayload: string | null = null;
  let bestKey: string | null = null;

  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    p += 4;
    const type = buf.subarray(p, p + 4).toString('ascii');
    p += 4;
    const data = buf.subarray(p, p + len);
    p += len + 4;

    if (type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul === -1) continue;
      const key = data.subarray(0, nul).toString('utf-8');
      const value = data.subarray(nul + 1).toString('utf-8');

      if (key === 'ccv3') {
        bestPayload = value;
        bestKey = key;
        break;
      }
      if (key === 'chara' && bestPayload === null) {
        bestPayload = value;
        bestKey = key;
      }
    }

    if (type === 'IEND') break;
  }

  if (!bestPayload) {
    throw new Error(`No chara metadata found in ${pngPath}`);
  }

  const decoded = Buffer.from(bestPayload, 'base64').toString('utf-8');
  const json = JSON.parse(decoded) as CharaCardData;

  if (!json.data || !json.data.name) {
    throw new Error(`Invalid chara card structure in ${pngPath} (key=${bestKey})`);
  }

  return json;
}

// ─── CLI 参数解析 ────────────────────────────────────────────────────────────

interface CliArgs {
  pngPath: string;
  name?: string;
  sortOrder: number;
  setAsFallback: boolean;
  envPath: string;
}

function printHelp(): void {
  console.log(
    `
角色卡上架工具 — import-character.ts

用法：
  pnpm import-character <png-path> [options]

选项：
  --name <name>           覆盖 PNG 内嵌的角色名
  --sort-order <n>        大厅展示顺序（默认 0）
  --set-as-fallback       将此卡设为系统兜底卡（角色引用失效时的回退值，
                          不是"用户默认进入的角色"。该配置用户感知不到。）
  --env <path>            指定 .env 文件路径（默认 packages/sync-engine/.env）
  --help                  显示帮助信息

示例：
  pnpm import-character ./角色卡.png
  pnpm import-character ./角色卡.png -- --sort-order 1
  pnpm import-character ./角色卡.png -- --set-as-fallback
  pnpm import-character ./角色卡.png -- --name "自定义名字" --sort-order 2
`.trim()
  );
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printHelp();
    process.exit(0);
  }

  let pngPath = '';
  let name: string | undefined;
  let sortOrder = 0;
  let setAsFallback = false;
  let envPath = resolve('packages/sync-engine/.env');

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--name') {
      name = args[++i];
      if (!name) fatal('--name 需要一个参数');
    } else if (arg === '--sort-order') {
      const val = args[++i];
      if (!val) fatal('--sort-order 需要一个数字参数');
      sortOrder = parseInt(val, 10);
      if (isNaN(sortOrder)) fatal(`--sort-order 参数无效：${val}`);
    } else if (arg === '--set-as-fallback') {
      setAsFallback = true;
    } else if (arg === '--env') {
      envPath = args[++i] ?? '';
      if (!envPath) fatal('--env 需要一个路径参数');
    } else if (arg === '--') {
      continue;
    } else if (arg.startsWith('-')) {
      fatal(`未知选项：${arg}（使用 --help 查看用法）`);
    } else {
      pngPath = arg;
    }
  }

  if (!pngPath) fatal('必须提供 PNG 文件路径');

  return { pngPath: resolve(pngPath), name, sortOrder, setAsFallback, envPath: resolve(envPath) };
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function beijingTimestamp(date = new Date()): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .replace('Z', '');
}

function fatal(msg: string): never {
  console.error(`\n❌ 错误：${msg}\n`);
  process.exit(1);
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

async function main() {
  const cli = parseArgs(process.argv);

  // 1. 加载环境变量
  if (existsSync(cli.envPath)) {
    loadDotenv({ path: cli.envPath });
  } else {
    console.warn(`⚠️  .env 文件不存在：${cli.envPath}，尝试从环境变量读取`);
  }

  const supabaseUrl = process.env['SUPABASE_URL'];
  const supabaseKey = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!supabaseUrl || !supabaseKey) {
    fatal('缺少 SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY 环境变量');
  }

  const bucket = process.env['CHARACTER_STORAGE_BUCKET'] ?? 'character-assets';

  // 2. 校验 PNG 文件
  if (!existsSync(cli.pngPath)) {
    fatal(`PNG 文件不存在：${cli.pngPath}`);
  }

  console.log(`\n📦 解析 PNG 文件：${basename(cli.pngPath)}`);
  let card;
  try {
    card = extractCharaCardFromPng(cli.pngPath);
  } catch (err) {
    fatal(`PNG 解析失败：${err instanceof Error ? err.message : err}`);
  }

  const characterName = cli.name ?? card.data.name;
  console.log(`   角色名：${characterName}`);
  console.log(`   spec：${card.spec} v${card.spec_version}`);
  console.log(`   creator：${card.data.creator ?? '(无)'}`);
  console.log(`   tags：${(card.data.tags ?? []).join(', ') || '(无)'}`);

  // 3. 生成 UUID
  const uuid = randomUUID();
  const now = beijingTimestamp();
  const storagePath = `characters/platform_${uuid}.png`;
  console.log(`\n🆔 UUID：${uuid}`);

  // 4. 初始化 Supabase client
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // 5. 上传 PNG 到 Storage
  console.log(`\n☁️  上传到 Storage：${bucket}/${storagePath}`);
  const pngBuffer = readFileSync(cli.pngPath);
  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(storagePath, pngBuffer, { contentType: 'image/png', upsert: false });

  if (uploadError) {
    fatal(`Storage 上传失败：${uploadError.message}`);
  }
  console.log('   ✅ 上传成功');

  // 6. 写入 miniapp.characters 表
  console.log('\n📝 写入 miniapp.characters 表...');
  const d = card.data;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schemaClient = (supabase as any).schema('miniapp');

  const { error: insertError } = await schemaClient.from('characters').insert({
    id: uuid,
    name: characterName,
    description: d.description ?? '',
    personality: d.personality ?? '',
    scenario: d.scenario ?? '',
    first_mes: d.first_mes ?? '',
    mes_example: d.mes_example ?? '',
    creator_notes: d.creator_notes ?? '',
    system_prompt: d.system_prompt ?? '',
    post_history_instructions: d.post_history_instructions ?? '',
    alternate_greetings: d.alternate_greetings ?? [],
    tags: d.tags ?? [],
    character_book: d.character_book ?? null,
    extensions: d.extensions ?? {},
    creator: d.creator ?? '',
    character_version: d.character_version ?? '',
    spec: card.spec ?? 'chara_card_v2',
    spec_version: card.spec_version ?? '2.0',
    avatar_url: '',
    enabled: true,
    sort_order: cli.sortOrder,
    raw_card: card,
    created_at: now,
    updated_at: now,
  });

  if (insertError) {
    // 回滚：删除已上传的 Storage 文件
    console.log('   ⚠️  DB 写入失败，回滚 Storage 文件...');
    await supabase.storage.from(bucket).remove([storagePath]);
    fatal(`DB 写入失败：${insertError.message}`);
  }
  console.log('   ✅ DB 写入成功');

  // 7. 如需设为系统兜底卡
  if (cli.setAsFallback) {
    console.log('\n🔧 设置为系统兜底卡...');
    const { error: configError } = await schemaClient.from('runtime_config').upsert(
      {
        key: 'system_fallback_character_id',
        value: uuid,
        description:
          '系统兜底卡 UUID。当 active_character 引用失效时的回退值。用户感知不到此配置。',
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'key' }
    );

    if (configError) {
      console.warn(`   ⚠️  设置兜底卡失败（不影响角色卡上架）：${configError.message}`);
    } else {
      console.log('   ✅ 已设为系统兜底卡');
    }
  }

  // 8. 输出结果摘要
  console.log('\n' + '═'.repeat(60));
  console.log('✅ 角色卡上架完成');
  console.log('═'.repeat(60));
  console.log(`   UUID          : ${uuid}`);
  console.log(`   角色名        : ${characterName}`);
  console.log(`   sort_order    : ${cli.sortOrder}`);
  console.log(`   enabled       : true`);
  console.log(`   Storage 路径  : ${bucket}/${storagePath}`);
  if (cli.setAsFallback) {
    console.log(`   系统兜底卡    : ✅ 已设置`);
  }
  console.log('═'.repeat(60));
}

main().catch((err) => {
  console.error('\n💥 未预期的错误：', err);
  process.exit(1);
});
