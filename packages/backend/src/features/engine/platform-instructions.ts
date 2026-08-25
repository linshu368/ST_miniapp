/**
 * backend / features / engine / platform-instructions.ts
 *
 * 平台规则三件套的读取通道：miniapp.runtime_config 的
 * system_instructions / interaction_mode_blocks / pref_word_count_tiers 三个 key
 * → 引擎接缝的 EnginePlatformInstructions。正文由 migration 071 落库，076 起可由 Admin 发布。
 *
 * 这是本模块里唯一有 IO 的文件；渲染与组装（render-instructions.ts / prompt-engine.ts）保持纯函数。
 *
 * ⚠️ 同名 key 在 bot 的 public.runtime_config 下也有一份（同一个 Supabase 项目），
 *    这里读的始终是 miniapp schema，两者互不影响。
 */

import {
  DEFAULT_WORD_COUNT_TIERS_CONFIG,
  toPublicWordCountTiers,
  WordCountTiersConfigSchema,
  type PublicWordCountTiers,
  type WordCountTiersConfig,
} from '@miniapp/shared';
import {
  fetchRuntimeConfigEntries,
  type RuntimeConfigEntry,
} from '../../platform/runtime-config.js';
import type { EnginePlatformInstructions, EngineWordCountTiers } from './types.js';

export const PLATFORM_INSTRUCTIONS_TEMPLATE_KEY = 'system_instructions';
export const INTERACTION_MODE_BLOCKS_KEY = 'interaction_mode_blocks';
export const WORD_COUNT_TIERS_KEY = 'pref_word_count_tiers';

const CONFIG_KEYS = [
  PLATFORM_INSTRUCTIONS_TEMPLATE_KEY,
  INTERACTION_MODE_BLOCKS_KEY,
  WORD_COUNT_TIERS_KEY,
] as const;

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 三个 key 全部缺失/损坏时的最后兜底。刻意写得很短——它只保证生成不中断，
 * 输出质量一定是降级的，靠 degraded 标记和日志把问题暴露出来，而不是让它悄悄跑下去。
 */
const FALLBACK_TEMPLATE = [
  '你正在进行沉浸式角色扮演。只输出剧情正文，不要输出状态栏、系统提示或思考过程；',
  '不要替用户决定行动或说话；不要打破第四面墙提及自己是 AI。',
  '{{INTERACTION_MODE}}',
  '输出篇幅为 {{WORD_COUNT}} 字，段落之间使用空行隔开，仅使用简体中文。',
  '用户个人偏好为：',
  '{{USER_CUSTOM_INSTRUCTIONS}}',
].join('\n');

const FALLBACK_INTERACTION_MODE_BLOCKS = {
  optionsOn:
    '正文结束后，另起一行，生成 2-3 个选项供用户参考。选项是建议而非限制，用户可以完全忽略。',
  optionsOff: '不要在回复末尾生成任何选项。用户自行决定下一步行动。',
} as const;

const FALLBACK_WORD_COUNT_TIERS: EngineWordCountTiers = configToEngineWordCountTiers(
  DEFAULT_WORD_COUNT_TIERS_CONFIG
);

export interface PlatformInstructionsSnapshot {
  instructions: EnginePlatformInstructions;
  /** 任一 key 缺失或校验失败、已回落到内置兜底。M3b 可据此打点告警 */
  degraded: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/** 模板存在 text_value 列；兼容早期把长文本塞进 value 的写法（见 rechargeRules 同款处理） */
export function parseTemplate(entry: RuntimeConfigEntry | undefined): string | null {
  if (!entry) return null;
  return nonEmptyString(entry.textValue) ?? nonEmptyString(entry.value);
}

export function parseInteractionModeBlocks(
  value: unknown
): EnginePlatformInstructions['interactionModeBlocks'] | null {
  if (!isRecord(value)) return null;
  const optionsOn = nonEmptyString(value.options_on);
  const optionsOff = nonEmptyString(value.options_off);
  if (!optionsOn || !optionsOff) return null;
  return { optionsOn, optionsOff };
}

function layoutColumns(value: unknown): 2 | 3 | 4 {
  if (value === 2 || value === 3 || value === 4) return value;
  return 4;
}

/**
 * 新 shape（076）：{ tiers:[{id,ui_label,prompt_value,enabled,sort_order}], default_tier_id, layout }
 * 旧 shape（071）：{ tiers:[{label,prompt_value}], default_value }
 */
export function parseWordCountTiers(value: unknown): EngineWordCountTiers | null {
  if (!isRecord(value) || !Array.isArray(value.tiers) || value.tiers.length === 0) return null;

  const tiers: EngineWordCountTiers['tiers'] = [];
  for (const [index, item] of value.tiers.entries()) {
    if (!isRecord(item)) return null;
    const id = nonEmptyString(item.id) ?? nonEmptyString(item.label);
    const promptValue = nonEmptyString(item.prompt_value);
    if (!id || !promptValue) return null;
    const uiLabel = nonEmptyString(item.ui_label) ?? id;
    const enabled = typeof item.enabled === 'boolean' ? item.enabled : true;
    const sortOrder =
      typeof item.sort_order === 'number' && Number.isFinite(item.sort_order)
        ? Math.trunc(item.sort_order)
        : index;
    tiers.push({ id, uiLabel, promptValue, enabled, sortOrder });
  }

  const defaultTierId =
    nonEmptyString(value.default_tier_id) ??
    nonEmptyString(value.default_value) ??
    tiers.find((tier) => tier.enabled)?.id ??
    null;
  if (!defaultTierId) return null;

  const columns = isRecord(value.layout) ? layoutColumns(value.layout.columns) : 4;

  return {
    tiers,
    defaultTierId,
    layoutColumns: columns,
  };
}

/**
 * EngineWordCountTiers → shared 契约 shape，校验失败时把 issues 交回调用方。
 *
 * 刻意不在这里兜底：兜底只发生在 buildSnapshot 一处，否则同一份配置会在
 * prompt 出口和 MiniApp 出口分叉成两种结果（见 buildSnapshot 里的注释）。
 */
function validateEngineWordCountTiers(
  tiersConfig: EngineWordCountTiers
): { ok: true; config: WordCountTiersConfig } | { ok: false; issues: string[] } {
  const parsed = WordCountTiersConfigSchema.safeParse({
    tiers: tiersConfig.tiers.map((tier) => ({
      id: tier.id,
      ui_label: tier.uiLabel,
      prompt_value: tier.promptValue,
      enabled: tier.enabled,
      sort_order: tier.sortOrder,
    })),
    default_tier_id: tiersConfig.defaultTierId,
    layout: { columns: tiersConfig.layoutColumns },
  });
  if (parsed.success) return { ok: true, config: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`
    ),
  };
}

function configToEngineWordCountTiers(config: WordCountTiersConfig): EngineWordCountTiers {
  return {
    tiers: config.tiers.map((tier) => ({
      id: tier.id,
      uiLabel: tier.ui_label,
      promptValue: tier.prompt_value,
      enabled: tier.enabled,
      sortOrder: tier.sort_order,
    })),
    defaultTierId: config.default_tier_id,
    layoutColumns: config.layout.columns,
  };
}

/**
 * buildSnapshot 已保证快照里的 wordCountTiers 一定过得了 shared 契约，
 * 所以兜底分支正常走不到；保留它只是为了让这个函数对任意入参都是全函数。
 */
export function engineWordCountTiersToConfig(
  tiersConfig: EngineWordCountTiers
): WordCountTiersConfig {
  const validated = validateEngineWordCountTiers(tiersConfig);
  return validated.ok ? validated.config : DEFAULT_WORD_COUNT_TIERS_CONFIG;
}

export function toPublicWordCountTiersFromEngine(
  tiersConfig: EngineWordCountTiers
): PublicWordCountTiers {
  return toPublicWordCountTiers(engineWordCountTiersToConfig(tiersConfig));
}

let cached: PlatformInstructionsSnapshot | null = null;
let cachedVersionSignature = '';
let lastFetchTime = 0;

function versionSignature(entries: Map<string, RuntimeConfigEntry>): string {
  return CONFIG_KEYS.map((key) => `${key}:${entries.get(key)?.version ?? -1}`).join('|');
}

/** 纯函数，导出仅供单测直接喂 entries；对外的入口是 fetchPlatformInstructions */
export function buildSnapshot(
  entries: Map<string, RuntimeConfigEntry>
): PlatformInstructionsSnapshot {
  let degraded = false;

  const template = parseTemplate(entries.get(PLATFORM_INSTRUCTIONS_TEMPLATE_KEY));
  if (!template) {
    console.error(
      `[engine] runtime_config ${PLATFORM_INSTRUCTIONS_TEMPLATE_KEY} 缺失或为空，平台规则已降级到内置兜底模板`
    );
    degraded = true;
  }

  const interactionModeBlocks = parseInteractionModeBlocks(
    entries.get(INTERACTION_MODE_BLOCKS_KEY)?.value
  );
  if (!interactionModeBlocks) {
    console.error(
      `[engine] runtime_config ${INTERACTION_MODE_BLOCKS_KEY} 缺失或格式非法，选项模式已降级到内置兜底`
    );
    degraded = true;
  }

  const wordCountEntry = entries.get(WORD_COUNT_TIERS_KEY);
  let wordCountTiers = parseWordCountTiers(wordCountEntry?.value);
  if (!wordCountTiers) {
    console.error(
      `[engine] runtime_config ${WORD_COUNT_TIERS_KEY} 缺失或格式非法，字数档位已降级到内置兜底`
    );
    degraded = true;
  } else {
    // parseWordCountTiers 比 shared 契约宽松（容忍不合 id 正则的档位 id、超长 ui_label、
    // 重复 id、default_tier_id 指向停用档位等），差集必须在这里判降级。
    // 否则 prompt 侧会用运营配置渲染 {{WORD_COUNT}}，而 MiniApp 侧的 toPublicWordCountTiersFromEngine
    // 拿到的是内置默认档位表——用户看到的按钮和实际注入的字数对不上，且全程无日志无 degraded。
    const validated = validateEngineWordCountTiers(wordCountTiers);
    if (validated.ok) {
      // 回灌契约校验后的值：两个出口从此拿到同一份（已 trim）数据
      wordCountTiers = configToEngineWordCountTiers(validated.config);
    } else {
      console.error(
        `[engine] runtime_config ${WORD_COUNT_TIERS_KEY}（version ${
          wordCountEntry?.version ?? -1
        }）不满足 shared 契约，字数档位已整表降级到内置兜底：${validated.issues.join('；')}`
      );
      wordCountTiers = null;
      degraded = true;
    }
  }

  return {
    instructions: {
      template: template ?? FALLBACK_TEMPLATE,
      interactionModeBlocks: interactionModeBlocks ?? FALLBACK_INTERACTION_MODE_BLOCKS,
      wordCountTiers: wordCountTiers ?? FALLBACK_WORD_COUNT_TIERS,
    },
    degraded,
  };
}

/**
 * 读取平台规则，按 version 判活缓存（与模型目录同款策略）。
 * 三个 key 任一 version 变化即重建，运营改文案后无需重启。
 */
export async function fetchPlatformInstructions(): Promise<PlatformInstructionsSnapshot> {
  let entries: Map<string, RuntimeConfigEntry>;
  try {
    entries = await fetchRuntimeConfigEntries(CONFIG_KEYS);
  } catch (error) {
    console.error('[engine] 读取平台规则失败:', error);
    entries = new Map();
  }

  const signature = versionSignature(entries);

  if (cached && signature === cachedVersionSignature) return cached;
  // 三个 key 一个都没读到（表不可达或被清空）时不要立刻把已有缓存换成兜底，
  // 先扛过 TTL，避免一次抖动就让全站 prompt 降级。
  if (cached && entries.size === 0 && Date.now() - lastFetchTime < CACHE_TTL_MS) return cached;

  cached = buildSnapshot(entries);
  cachedVersionSignature = signature;
  lastFetchTime = Date.now();
  return cached;
}

export function invalidatePlatformInstructionsCache(): void {
  cached = null;
  cachedVersionSignature = '';
  lastFetchTime = 0;
}
