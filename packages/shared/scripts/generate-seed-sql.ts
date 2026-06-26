/**
 * generate-seed-sql.ts
 *
 * 用途：
 *   - 从 SillyTavern-latest/data/default-user 真实数据生成种子 SQL
 *   - 输出文件：packages/shared/migrations/011_seed_data.sql
 *
 * 输入：
 *   - 角色卡：3 张 PNG（chara_card_v3 嵌入），来自 /SillyTavern-latest/data/default-user/characters/
 *   - 预设：OpenAI Settings/Default.json
 *   - 全量 settings：default-user/settings.json
 *
 * 种子内容：
 *   - miniapp.characters：3 张种子卡（enabled=true, sort_order=0..2）
 *   - miniapp.runtime_config：system_fallback_character_id 指向兜底卡
 *   - st_platform.platform_presets：1 行默认预设
 *   - st_platform.platform_api_configs：1 行（OpenRouter / Claude，is_default=true，api_key 占位 "REPLACE_ME"）
 *   - st_platform.platform_settings：第一行 platform_version=1，含全量 settings_jsonb 和 writable_paths
 *
 * 运行：
 *   cd packages/shared
 *   npx tsx scripts/generate-seed-sql.ts
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CharaCardData } from '../src/png-parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ST_ROOT = '/Users/qj/python_project/SillyTavern-latest/data/default-user';
const OUTPUT_PATH = path.join(__dirname, '..', 'migrations', '011_seed_data.sql');

// ─── 确定性 UUID（写死，保证 seed 幂等） ──────────────────────────────────────
// 命名空间：
//   1xxx-... = miniapp.characters（D003 复用）
//   2xxx-... = st_platform.platform_presets
//   3xxx-... = st_platform.platform_api_configs
//   4xxx-... = st_platform.platform_settings（按 platform_version 派生即可，但留出范围）
const SEED_CHARACTER_UUIDS: Record<string, string> = {
  第七开发部: '11111111-1111-4111-8111-000000000001',
  莫池来: '11111111-1111-4111-8111-000000000002',
  贺商寒: '11111111-1111-4111-8111-000000000003',
};

const SEED_PRESET_UUID = '22222222-2222-4222-8222-000000000001';
const SEED_API_CONFIG_UUID = '33333333-3333-4333-8333-000000000001';
const SEED_PLATFORM_SETTINGS_UUID = '44444444-4444-4444-8444-000000000001';

// 系统兜底卡（character_ref 失效时的回退值，用户感知不到）
const FALLBACK_CHARACTER_NAME = '第七开发部';

// ─── PNG chara card 解析 ─────────────────────────────────────────────────────

function extractCharaCardFromPng(pngPath: string): CharaCardData {
  const buf = fs.readFileSync(pngPath);
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

// ─── canonical JSON serialization（key 排序，用于 content_hash） ─────────────
// PG 原生 jsonb 排序不稳定，由应用层提前算好

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys
      .map((k) => JSON.stringify(k) + ':' + canonicalize((value as Record<string, unknown>)[k]))
      .join(',') +
    '}'
  );
}

function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf-8').digest('hex');
}

// ─── SQL 字面量序列化（用 dollar-quoting 保证安全） ───────────────────────────

const DOLLAR_TAG = 'miniapp_seed';

function sqlString(value: string | null | undefined): string {
  if (value === null || value === undefined) return 'NULL';
  return `$${DOLLAR_TAG}$${value}$${DOLLAR_TAG}$`;
}

function sqlJson(value: unknown): string {
  if (value === null || value === undefined) return `'{}'::jsonb`;
  const json = JSON.stringify(value);
  return `${sqlString(json)}::jsonb`;
}

function sqlJsonArray(value: unknown): string {
  if (!value) return `'[]'::jsonb`;
  const json = JSON.stringify(value);
  return `${sqlString(json)}::jsonb`;
}

// ─── 角色卡 INSERT ────────────────────────────────────────────────────────────
// 注意：miniapp.characters.updated_at 是 NOT NULL 且无 DB 默认值
//       Prisma 用 @updatedAt 在 client 端注入，但纯 SQL INSERT 必须显式提供

function buildCharacterInsert(uuid: string, card: CharaCardData, sortOrder: number): string {
  const d = card.data;
  return `
INSERT INTO miniapp.characters (
  id, name, description, personality, scenario, first_mes, mes_example,
  creator_notes, system_prompt, post_history_instructions,
  alternate_greetings, tags, character_book, extensions,
  creator, character_version, spec, spec_version, avatar_url,
  enabled, sort_order,
  created_at, updated_at
) VALUES (
  '${uuid}',
  ${sqlString(d.name)},
  ${sqlString(d.description ?? '')},
  ${sqlString(d.personality ?? '')},
  ${sqlString(d.scenario ?? '')},
  ${sqlString(d.first_mes ?? '')},
  ${sqlString(d.mes_example ?? '')},
  ${sqlString(d.creator_notes ?? '')},
  ${sqlString(d.system_prompt ?? '')},
  ${sqlString(d.post_history_instructions ?? '')},
  ${sqlJsonArray(d.alternate_greetings ?? [])},
  ${sqlJsonArray(d.tags ?? [])},
  ${d.character_book ? sqlJson(d.character_book) : 'NULL'},
  ${sqlJson(d.extensions ?? {})},
  ${sqlString(d.creator ?? '')},
  ${sqlString(d.character_version ?? '')},
  ${sqlString(card.spec ?? 'chara_card_v3')},
  ${sqlString(card.spec_version ?? '3.0')},
  '',
  TRUE,
  ${sortOrder},
  now(),
  now()
) ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  personality = EXCLUDED.personality,
  scenario = EXCLUDED.scenario,
  first_mes = EXCLUDED.first_mes,
  mes_example = EXCLUDED.mes_example,
  creator_notes = EXCLUDED.creator_notes,
  system_prompt = EXCLUDED.system_prompt,
  post_history_instructions = EXCLUDED.post_history_instructions,
  alternate_greetings = EXCLUDED.alternate_greetings,
  tags = EXCLUDED.tags,
  character_book = EXCLUDED.character_book,
  extensions = EXCLUDED.extensions,
  creator = EXCLUDED.creator,
  character_version = EXCLUDED.character_version,
  spec = EXCLUDED.spec,
  spec_version = EXCLUDED.spec_version,
  sort_order = EXCLUDED.sort_order,
  updated_at = now();
`.trim();
}

// ─── 预设 INSERT（新 schema：display_name + preset_payload） ─────────────────

function buildPresetInsert(uuid: string, presetData: Record<string, unknown>): string {
  return `
INSERT INTO st_platform.platform_presets (
  id, display_name, preset_payload, is_default, sort_order, enabled,
  created_at, updated_at
) VALUES (
  '${uuid}',
  ${sqlString('Default')},
  ${sqlJson(presetData)},
  TRUE,
  0,
  TRUE,
  now(),
  now()
) ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  preset_payload = EXCLUDED.preset_payload,
  is_default = EXCLUDED.is_default,
  sort_order = EXCLUDED.sort_order,
  enabled = EXCLUDED.enabled,
  updated_at = now();
`.trim();
}

// ─── API 配置 INSERT（占位，api_key 用 REPLACE_ME，运维上线时替换） ──────────

function buildApiConfigInsert(uuid: string): string {
  // 阶段一约定 config_payload 结构（应用层校验，DB 不约束）
  // 注意：api_key 用占位符 REPLACE_ME，部署时通过 Supabase Studio 或 SQL 替换
  // 不能在种子里写真实 key（git 安全）
  const configPayload = {
    provider: 'openrouter',
    api_key: 'REPLACE_ME',
    api_base_url: 'https://openrouter.ai/api/v1',
    model: 'anthropic/claude-sonnet-4.5',
    model_whitelist: [],
  };

  return `
INSERT INTO st_platform.platform_api_configs (
  id, display_name, config_payload, is_default,
  created_at, updated_at
) VALUES (
  '${uuid}',
  ${sqlString('OpenRouter Default')},
  ${sqlJson(configPayload)},
  TRUE,
  now(),
  now()
) ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  -- 注意：不更新 config_payload（部署时手动维护的 api_key 不能被种子重置）
  is_default = EXCLUDED.is_default,
  updated_at = now();
`.trim();
}

// ─── platform_settings INSERT ────────────────────────────────────────────────
// settings_jsonb 来自 default-user/settings.json，做三处清洗：
//   1) active_character = "platform_<defaultCharUuid>.png"
//   2) oai_settings.preset_settings_openai = "platform_<presetUuid>"（预设引用不带扩展名）
//   3) main_api = "openai"

function cleanSettingsJsonb(
  raw: Record<string, unknown>,
  defaultCharUuid: string,
  presetUuid: string
): Record<string, unknown> {
  // 深拷贝以免污染原对象
  const cleaned = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;

  // 1) active_character → platform_<uuid>.png
  cleaned.active_character = `platform_${defaultCharUuid}.png`;

  // 2) main_api → "openai"
  cleaned.main_api = 'openai';

  // 3) oai_settings.preset_settings_openai → platform_<uuid>
  if (cleaned.oai_settings && typeof cleaned.oai_settings === 'object') {
    (cleaned.oai_settings as Record<string, unknown>).preset_settings_openai =
      `platform_${presetUuid}`;
  } else {
    // 异常容错：如果 default-user 的 settings.json 没 oai_settings（不应该发生），构造一个最小结构
    cleaned.oai_settings = { preset_settings_openai: `platform_${presetUuid}` };
  }

  return cleaned;
}

function buildPlatformSettingsInsert(
  uuid: string,
  settingsJsonb: Record<string, unknown>,
  writablePaths: unknown[],
  contentHash: string
): string {
  return `
INSERT INTO st_platform.platform_settings (
  id, platform_version, settings_jsonb, writable_paths,
  content_hash, created_by, note, created_at
) VALUES (
  '${uuid}',
  1,
  ${sqlJson(settingsJsonb)},
  ${sqlJsonArray(writablePaths)},
  ${sqlString(contentHash)},
  ${sqlString('system')},
  ${sqlString('阶段一首版种子，从 default-user/settings.json 导出 + 三处指针清洗')},
  now()
) ON CONFLICT (content_hash) DO NOTHING;
`.trim();
}

// ─── 主流程 ───────────────────────────────────────────────────────────────────

function main() {
  // 角色卡顺序：第七开发部（兜底卡）→ 莫池来 → 贺商寒
  const characterOrder = [
    { name: '第七开发部', file: '第七开发部.png' },
    { name: '莫池来', file: '莫池来.png' },
    { name: '贺商寒', file: '贺商寒.png' },
  ];

  const characterInserts: string[] = [];
  characterOrder.forEach(({ name, file }, idx) => {
    const pngPath = path.join(ST_ROOT, 'characters', file);
    const card = extractCharaCardFromPng(pngPath);
    const uuid = SEED_CHARACTER_UUIDS[name];
    if (!uuid) throw new Error(`Missing UUID mapping for ${name}`);
    console.log(
      `  ✓ character ${name} -> ${uuid} (sort=${idx}, size=${JSON.stringify(card.data).length}B)`
    );
    characterInserts.push(buildCharacterInsert(uuid, card, idx));
  });

  // 预设
  const presetPath = path.join(ST_ROOT, 'OpenAI Settings', 'Default.json');
  const presetData = JSON.parse(fs.readFileSync(presetPath, 'utf-8')) as Record<string, unknown>;
  console.log(
    `  ✓ preset Default -> ${SEED_PRESET_UUID} (size=${JSON.stringify(presetData).length}B)`
  );
  const presetInsert = buildPresetInsert(SEED_PRESET_UUID, presetData);

  // API 配置（占位）
  console.log(`  ✓ api_config OpenRouter -> ${SEED_API_CONFIG_UUID} (api_key=REPLACE_ME 占位)`);
  const apiConfigInsert = buildApiConfigInsert(SEED_API_CONFIG_UUID);

  // platform_settings
  const settingsPath = path.join(ST_ROOT, 'settings.json');
  const rawSettings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) as Record<string, unknown>;

  const fallbackCharUuid = SEED_CHARACTER_UUIDS[FALLBACK_CHARACTER_NAME];
  if (!fallbackCharUuid) throw new Error('Fallback character UUID missing');

  const cleanedSettings = cleanSettingsJsonb(rawSettings, fallbackCharUuid, SEED_PRESET_UUID);

  // 校验清洗结果
  console.log(`  ✓ settings cleaning:`);
  console.log(`      active_character           : ${cleanedSettings.active_character}`);
  console.log(`      main_api                   : ${cleanedSettings.main_api}`);
  console.log(
    `      oai_settings.preset_settings_openai : ${(cleanedSettings.oai_settings as Record<string, unknown>)?.preset_settings_openai}`
  );

  // 白名单（J1：阶段一走整组路径）
  const writablePaths = [
    { path: 'active_character', transform: 'character_ref' },
    { path: 'oai_settings.prompts', transform: 'passthrough' },
  ];

  // canonical content_hash
  const canonical = canonicalize({
    settings_jsonb: cleanedSettings,
    writable_paths: writablePaths,
    platform_version: 1,
  });
  const contentHash = sha256(canonical);
  console.log(
    `  ✓ platform_settings v1 -> ${SEED_PLATFORM_SETTINGS_UUID} (hash=${contentHash.slice(0, 16)}...)`
  );

  const platformSettingsInsert = buildPlatformSettingsInsert(
    SEED_PLATFORM_SETTINGS_UUID,
    cleanedSettings,
    writablePaths,
    contentHash
  );

  // ─── 系统兜底卡 runtime_config 行 ──────────────────────────────────────────
  const fallbackConfigInsert = `
INSERT INTO miniapp.runtime_config (key, value, description, version, updated_at)
VALUES (
  'system_fallback_character_id',
  ${sqlString(JSON.stringify(fallbackCharUuid))}::jsonb,
  ${sqlString('系统兜底卡 UUID。当 active_character 引用失效（角色被下架/PNG 缺失）时的回退值。用户感知不到此配置。')},
  1,
  now()
) ON CONFLICT (key) DO UPDATE SET
  value = EXCLUDED.value,
  description = EXCLUDED.description,
  updated_at = now();
`.trim();
  console.log(`  ✓ runtime_config system_fallback_character_id -> ${fallbackCharUuid}`);

  // ─── 拼装 SQL ─────────────────────────────────────────────────────────────

  const header = `-- 011: 阶段一种子数据
-- 来源：SillyTavern-latest/data/default-user/
--   - characters/第七开发部.png / 莫池来.png / 贺商寒.png（chara_card_v3）
--   - OpenAI Settings/Default.json（openrouter / claude-sonnet-4.5）
--   - settings.json（全量 ST settings 快照）
--
-- 目标 schema（D014 三 schema 切分后）：
--   - 角色卡          -> miniapp.characters（D003 复用）
--   - 预设            -> st_platform.platform_presets
--   - API 配置        -> st_platform.platform_api_configs（api_key=REPLACE_ME 占位，部署时替换）
--   - settings 全量   -> st_platform.platform_settings（platform_version=1，含 writable_paths 白名单）
--   - 兜底卡配置      -> miniapp.runtime_config.system_fallback_character_id
--
-- settings_jsonb 清洗：
--   - active_character                       -> "platform_<兜底卡 uuid>.png"
--   - oai_settings.preset_settings_openai    -> "platform_<预设 uuid>"
--   - main_api                                -> "openai"
--
-- 白名单（writable_paths）：
--   - { path: "active_character", transform: "character_ref" }
--   - { path: "oai_settings.prompts", transform: "passthrough" }
--
-- 生成方式：packages/shared/scripts/generate-seed-sql.ts
--   重新生成：cd packages/shared && npx tsx scripts/generate-seed-sql.ts
--
-- 幂等性：使用确定性 UUID + ON CONFLICT，可重跑
-- 注意：内容字段使用 PG 的 dollar-quoting（tag 由生成器控制），避免单引号转义陷阱

BEGIN;

-- ─── 角色卡（3 张，分区 A 平台池，schema=miniapp） ──────────────────────────
${characterInserts.join('\n\n')}

-- ─── 系统兜底卡配置（character_ref 失效时的回退值） ─────────────────────────
${fallbackConfigInsert}

-- ─── API 预设（1 个，分区 A 平台池，schema=st_platform） ───────────────────
${presetInsert}

-- ─── API 配置（1 个，分区 A 平台池 + 凭证型，schema=st_platform） ──────────
${apiConfigInsert}

-- ─── platform_settings 全量快照（分区 A 配置型，schema=st_platform） ──────
${platformSettingsInsert}

COMMIT;
`;

  // 早期失败检查：dollar tag 不在内容中出现
  if (header.split(`$${DOLLAR_TAG}$`).length % 2 === 0) {
    throw new Error(`Dollar-quote tag conflict detected. Change DOLLAR_TAG.`);
  }
  for (const block of [
    ...characterInserts,
    fallbackConfigInsert,
    presetInsert,
    apiConfigInsert,
    platformSettingsInsert,
  ]) {
    const innerContent = block
      .split(`$${DOLLAR_TAG}$`)
      .filter((_, i) => i % 2 === 1)
      .join('');
    if (innerContent.includes(`$${DOLLAR_TAG}$`)) {
      throw new Error(`Content collision with dollar tag ${DOLLAR_TAG}. Change tag and re-run.`);
    }
  }

  fs.writeFileSync(OUTPUT_PATH, header, 'utf-8');
  console.log(`\n✓ Wrote ${OUTPUT_PATH}`);
  console.log(`  Size: ${header.length} bytes`);
}

main();
