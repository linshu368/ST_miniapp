#!/usr/bin/env npx tsx
/**
 * import-character.ts — 角色卡上架工具
 *
 * 将酒馆角色卡 PNG 上传到 Supabase Storage 并写入 miniapp.characters 表。
 *
 * 用法：
 *   pnpm import-character <png-path-or-dir> -- [options]
 *
 * 示例：
 *   pnpm import-character ./角色卡.png -- --env scripts/.env.test
 *   pnpm import-character ./角色卡.png -- --env scripts/.env.prod --sort-order 1
 *   pnpm import-character ./角色卡文件夹 -- --env scripts/.env.prod --sort-order 1
 *
 * 完整文档见 docs/角色卡上架操作手册.md
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, basename, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

const PROJECT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const PNG_IEND_CHUNK = Buffer.from('0000000049454e44ae426082', 'hex');

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

interface NormalizedPng {
  buffer: Buffer;
  repairedMissingIend: boolean;
}

function normalizePngBuffer(buf: Buffer, pngPath: string): NormalizedPng {
  if (buf.length < PNG_SIGNATURE.length || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`Not a valid PNG: ${pngPath}`);
  }

  let p = 8;
  while (p < buf.length) {
    if (p + 8 > buf.length) {
      throw new Error(`PNG chunk header is truncated in ${pngPath}`);
    }

    const len = buf.readUInt32BE(p);
    const type = buf.subarray(p + 4, p + 8).toString('ascii');
    const chunkEnd = p + 8 + len + 4;

    if (chunkEnd > buf.length) {
      throw new Error(`PNG chunk ${type} is truncated in ${pngPath}`);
    }

    if (type === 'IEND') {
      if (len !== 0) {
        throw new Error(`Invalid PNG IEND chunk length in ${pngPath}`);
      }
      return { buffer: buf, repairedMissingIend: false };
    }

    p = chunkEnd;
  }

  // Some upstream card exporters emit a valid final metadata chunk but forget the
  // terminal IEND chunk. ST refuses those files, so normalize before uploading.
  return { buffer: Buffer.concat([buf, PNG_IEND_CHUNK]), repairedMissingIend: true };
}

function extractCharaCardFromPngBuffer(buf: Buffer, pngPath: string): CharaCardData {
  if (buf.length < PNG_SIGNATURE.length || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error(`Not a valid PNG: ${pngPath}`);
  }

  let p = 8;
  let bestPayload: string | null = null;
  let bestKey: string | null = null;

  while (p < buf.length) {
    if (p + 8 > buf.length) {
      throw new Error(`PNG chunk header is truncated in ${pngPath}`);
    }

    const len = buf.readUInt32BE(p);
    const type = buf.subarray(p + 4, p + 8).toString('ascii');
    const dataStart = p + 8;
    const chunkEnd = dataStart + len + 4;
    if (chunkEnd > buf.length) {
      throw new Error(`PNG chunk ${type} is truncated in ${pngPath}`);
    }
    const data = buf.subarray(dataStart, dataStart + len);

    if (type === 'tEXt') {
      const nul = data.indexOf(0);
      if (nul !== -1) {
        const key = data.subarray(0, nul).toString('utf-8');
        const value = data.subarray(nul + 1).toString('utf-8');

        if (key === 'ccv3') {
          bestPayload = value;
          bestKey = key;
        }
        if (key === 'chara' && bestPayload === null) {
          bestPayload = value;
          bestKey = key;
        }
      }
    }

    if (type === 'IEND') break;
    p = chunkEnd;
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
  inputPath: string;
  name?: string;
  sortOrder: number;
  setAsFallback: boolean;
  envPath: string;
}

interface InputPngs {
  kind: 'file' | 'directory';
  pngPaths: string[];
}

interface ImportResult {
  uuid: string;
  characterName: string;
  sortOrder: number;
  storagePath: string;
  setAsFallback: boolean;
}

function printHelp(): void {
  console.log(
    `
角色卡上架工具 — import-character.ts

用法：
  pnpm import-character <png-path-or-dir> [options]

选项：
  --name <name>           覆盖 PNG 内嵌的角色名
  --sort-order <n>        大厅展示顺序；目录模式下作为起始顺序（默认 0）
  --set-as-fallback       将此卡设为系统兜底卡（角色引用失效时的回退值，
                          不是"用户默认进入的角色"。该配置用户感知不到。）
  --env <path>            指定 .env 文件路径（默认 packages/sync-engine/.env）
  --help                  显示帮助信息

示例：
  pnpm import-character ./角色卡.png
  pnpm import-character ./角色卡.png -- --sort-order 1
  pnpm import-character ./角色卡.png -- --set-as-fallback
  pnpm import-character ./角色卡.png -- --name "自定义名字" --sort-order 2
  pnpm import-character ./角色卡文件夹 -- --sort-order 1
`.trim()
  );
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    printHelp();
    process.exit(0);
  }

  let inputPath = '';
  let name: string | undefined;
  let sortOrder = 0;
  let setAsFallback = false;
  let envPath = resolve(PROJECT_ROOT, 'packages/sync-engine/.env');

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
      inputPath = arg;
    }
  }

  if (!inputPath) fatal('必须提供 PNG 文件或目录路径');

  return {
    inputPath: resolveCliPath(inputPath),
    name,
    sortOrder,
    setAsFallback,
    envPath: resolveCliPath(envPath),
  };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function formatErrorDetails(err: unknown): string {
  if (!err || typeof err !== 'object') {
    return String(err);
  }

  const record = err as Record<string, unknown>;
  const lines: string[] = [];
  for (const key of ['name', 'message', 'status', 'statusCode', 'code', 'cause', 'originalError']) {
    const value = record[key];
    if (value === undefined || value === null) continue;

    if (value instanceof Error) {
      lines.push(`${key}: ${value.name}: ${value.message}`);
    } else if (typeof value === 'object') {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${String(value)}`);
    }
  }

  return lines.length > 0 ? lines.join('\n') : JSON.stringify(record);
}

function resolveCliPath(cliPath: string): string {
  const cwdPath = resolve(cliPath);
  if (existsSync(cwdPath)) return cwdPath;

  return resolve(PROJECT_ROOT, cliPath);
}

function resolveInputPngs(inputPath: string): InputPngs {
  if (!existsSync(inputPath)) {
    fatal(`PNG 文件或目录不存在：${inputPath}`);
  }

  const stat = statSync(inputPath);
  if (stat.isFile()) {
    if (extname(inputPath).toLowerCase() !== '.png') {
      fatal(`输入文件不是 PNG：${inputPath}`);
    }
    return { kind: 'file', pngPaths: [inputPath] };
  }

  if (!stat.isDirectory()) {
    fatal(`输入路径既不是 PNG 文件，也不是目录：${inputPath}`);
  }

  const pngPaths = readdirSync(inputPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === '.png')
    .map((entry) => join(inputPath, entry.name))
    .sort((a, b) => basename(a).localeCompare(basename(b), 'zh-Hans-CN'));

  if (pngPaths.length === 0) {
    fatal(`目录下没有 PNG 文件：${inputPath}`);
  }

  return { kind: 'directory', pngPaths };
}

async function uploadPngWithRetry(params: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  bucket: string;
  storagePath: string;
  pngBuffer: Buffer;
}): Promise<void> {
  const { supabase, bucket, storagePath, pngBuffer } = params;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { error } = await supabase.storage
      .from(bucket)
      .upload(storagePath, pngBuffer, { contentType: 'image/png', upsert: false });

    if (!error) return;

    if (attempt < maxAttempts) {
      console.warn(`   ⚠️  Storage 上传失败，准备重试 ${attempt}/${maxAttempts}：${error.message}`);
      await sleep(1000 * attempt);
      continue;
    }

    fatal(
      [
        `Storage 上传失败：${error.message}`,
        '',
        '底层错误信息：',
        formatErrorDetails(error),
        '',
        '请检查：',
        '  1. scripts/.env.test 里的 SUPABASE_URL 是否正确且可访问',
        '  2. 当前网络/代理是否能访问 Supabase',
        '  3. CHARACTER_STORAGE_BUCKET 是否存在，默认是 character-assets',
      ].join('\n')
    );
  }
}

async function importOneCharacter(params: {
  pngPath: string;
  name?: string;
  sortOrder: number;
  setAsFallback: boolean;
  bucket: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schemaClient: any;
}): Promise<ImportResult> {
  const { pngPath, name, sortOrder, setAsFallback, bucket, supabase, schemaClient } = params;

  console.log(`\n📦 解析 PNG 文件：${basename(pngPath)}`);
  let pngBuffer: Buffer;
  let card: CharaCardData;
  try {
    const normalized = normalizePngBuffer(readFileSync(pngPath), pngPath);
    pngBuffer = normalized.buffer;
    if (normalized.repairedMissingIend) {
      console.warn('   ⚠️  PNG 缺少 IEND 结尾块，已在上传前自动修复');
    }
    card = extractCharaCardFromPngBuffer(pngBuffer, pngPath);
  } catch (err) {
    fatal(`PNG 解析失败：${err instanceof Error ? err.message : err}`);
  }

  const characterName = name ?? card.data.name;
  console.log(`   角色名：${characterName}`);
  console.log(`   spec：${card.spec} v${card.spec_version}`);
  console.log(`   creator：${card.data.creator ?? '(无)'}`);
  console.log(`   tags：${(card.data.tags ?? []).join(', ') || '(无)'}`);

  const uuid = randomUUID();
  const now = beijingTimestamp();
  const storagePath = `characters/platform_${uuid}.png`;
  const avatarUrl = `${process.env['SUPABASE_URL']}/storage/v1/object/public/${bucket}/${storagePath}`;
  console.log(`\n🆔 UUID：${uuid}`);

  console.log(`\n☁️  上传到 Storage：${bucket}/${storagePath}`);
  await uploadPngWithRetry({ supabase, bucket, storagePath, pngBuffer });
  console.log('   ✅ 上传成功');

  console.log('\n📝 写入 miniapp.characters 表...');
  const d = card.data;

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
    avatar_url: avatarUrl,
    enabled: true,
    sort_order: sortOrder,
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

  if (setAsFallback) {
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

  return { uuid, characterName, sortOrder, storagePath, setAsFallback };
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

  // 2. 校验输入，支持单个 PNG 或目录批量导入
  const input = resolveInputPngs(cli.inputPath);
  if (input.kind === 'directory' && cli.name) {
    fatal('--name 只能在上传单个 PNG 时使用，目录批量导入会使用每张卡内嵌的角色名');
  }
  if (input.kind === 'directory' && cli.setAsFallback) {
    fatal('--set-as-fallback 只能在上传单个 PNG 时使用');
  }

  if (input.kind === 'directory') {
    console.log(`\n📂 批量导入目录：${cli.inputPath}`);
    console.log(`   找到 PNG 文件：${input.pngPaths.length} 个`);
    console.log(`   sort_order 起始值：${cli.sortOrder}`);
  }

  // 3. 初始化 Supabase client
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const schemaClient = (supabase as any).schema('miniapp');

  // 4. 逐个上传 PNG 并写库
  const results: ImportResult[] = [];
  for (const [index, pngPath] of input.pngPaths.entries()) {
    const result = await importOneCharacter({
      pngPath,
      name: cli.name,
      sortOrder: cli.sortOrder + index,
      setAsFallback: cli.setAsFallback,
      bucket,
      supabase,
      schemaClient,
    });
    results.push(result);
  }

  // 5. 输出结果摘要
  console.log('\n' + '═'.repeat(60));
  console.log(input.kind === 'directory' ? '✅ 角色卡批量上架完成' : '✅ 角色卡上架完成');
  console.log('═'.repeat(60));

  for (const result of results) {
    console.log(`   UUID          : ${result.uuid}`);
    console.log(`   角色名        : ${result.characterName}`);
    console.log(`   sort_order    : ${result.sortOrder}`);
    console.log(`   enabled       : true`);
    console.log(`   Storage 路径  : ${bucket}/${result.storagePath}`);
    if (result.setAsFallback) {
      console.log(`   系统兜底卡    : ✅ 已设置`);
    }
    if (results.length > 1) {
      console.log('─'.repeat(60));
    }
  }

  console.log('═'.repeat(60));
}

main().catch((err) => {
  console.error('\n💥 未预期的错误：', err);
  process.exit(1);
});
