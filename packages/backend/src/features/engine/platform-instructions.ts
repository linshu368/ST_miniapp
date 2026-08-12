/**
 * backend / features / engine / platform-instructions.ts
 *
 * 平台规则三件套的读取通道（M2）：miniapp.runtime_config 的
 * system_instructions / interaction_mode_blocks / pref_word_count_tiers 三个 key
 * → 引擎接缝的 EnginePlatformInstructions。正文由 migration 071 落库。
 *
 * 这是本模块里唯一有 IO 的文件；渲染与组装（render-instructions.ts / prompt-engine.ts）保持纯函数。
 *
 * ⚠️ 同名 key 在 bot 的 public.runtime_config 下也有一份（同一个 Supabase 项目），
 *    这里读的始终是 miniapp schema，两者互不影响。
 */

import type { PreferredWordCount } from '@miniapp/shared';
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
 * PreferredWordCount 的运行时清单。satisfies 保证枚举增减档位时这里编译期就报错，
 * 不会留一个「新档位永远命中不了」的静默缺口。
 */
const PREFERRED_WORD_COUNTS = Object.keys({
  '100-300': true,
  '300-500': true,
  '500-800': true,
  '800+': true,
} satisfies Record<PreferredWordCount, true>) as PreferredWordCount[];

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

const FALLBACK_WORD_COUNT_TIERS: EngineWordCountTiers = {
  tiers: [
    { label: '100-300', promptValue: '100-300' },
    { label: '300-500', promptValue: '300-500' },
    { label: '500-800', promptValue: '500-800' },
    { label: '800+', promptValue: '800以上' },
  ],
  defaultValue: '300-500',
};

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

export function parseWordCountTiers(value: unknown): EngineWordCountTiers | null {
  if (!isRecord(value) || !Array.isArray(value.tiers) || value.tiers.length === 0) return null;

  const tiers: EngineWordCountTiers['tiers'] = [];
  for (const item of value.tiers) {
    if (!isRecord(item)) return null;
    const label = nonEmptyString(item.label);
    const promptValue = nonEmptyString(item.prompt_value);
    if (!label || !promptValue) return null;
    tiers.push({ label, promptValue });
  }

  const defaultValue = nonEmptyString(value.default_value);
  if (!defaultValue) return null;

  return { tiers, defaultValue };
}

/**
 * 档位表能否覆盖 PreferredWordCount 的每一个取值。
 * 覆盖不全的档位会静默回落到 defaultValue——用户改了设置却看不到长度变化，且不报错，
 * 所以这里单独判一次并在读取时打日志。
 */
export function findUncoveredWordCounts(tiersConfig: EngineWordCountTiers): PreferredWordCount[] {
  const labels = new Set(tiersConfig.tiers.map((tier) => tier.label));
  return PREFERRED_WORD_COUNTS.filter((wordCount) => !labels.has(wordCount));
}

let cached: PlatformInstructionsSnapshot | null = null;
let cachedVersionSignature = '';
let lastFetchTime = 0;

function versionSignature(entries: Map<string, RuntimeConfigEntry>): string {
  return CONFIG_KEYS.map((key) => `${key}:${entries.get(key)?.version ?? -1}`).join('|');
}

function buildSnapshot(entries: Map<string, RuntimeConfigEntry>): PlatformInstructionsSnapshot {
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

  const wordCountTiers = parseWordCountTiers(entries.get(WORD_COUNT_TIERS_KEY)?.value);
  if (!wordCountTiers) {
    console.error(
      `[engine] runtime_config ${WORD_COUNT_TIERS_KEY} 缺失或格式非法，字数档位已降级到内置兜底`
    );
    degraded = true;
  }

  const resolvedTiers = wordCountTiers ?? FALLBACK_WORD_COUNT_TIERS;
  const uncovered = findUncoveredWordCounts(resolvedTiers);
  if (uncovered.length > 0) {
    // 不算 degraded：其余档位仍然生效，只有这几个取值会落到 defaultValue。
    console.error(
      `[engine] runtime_config ${WORD_COUNT_TIERS_KEY} 未覆盖 PreferredWordCount 取值 ${uncovered.join(' / ')}，` +
        `这些档位会静默回落到 ${resolvedTiers.defaultValue}`
    );
  }

  return {
    instructions: {
      template: template ?? FALLBACK_TEMPLATE,
      interactionModeBlocks: interactionModeBlocks ?? FALLBACK_INTERACTION_MODE_BLOCKS,
      wordCountTiers: resolvedTiers,
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
