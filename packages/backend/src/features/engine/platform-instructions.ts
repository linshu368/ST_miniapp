import { observation } from '../../platform/observability/runtime.js';
/**
 * backend / features / engine / platform-instructions.ts
 *
 * 平台规则三件套的读取通道：app_core.runtime_config 的
 * system_instructions / pref_word_count_tiers 两个 key
 * → 引擎接缝的 EnginePlatformInstructions。正文由 migration 071 落库，076 起可由 Admin 发布。
 *
 * 这是本模块里唯一有 IO 的文件；渲染与组装（render-instructions.ts / prompt-engine.ts）保持纯函数。
 *
 * ⚠️ 同名 key 在 bot 的 public.runtime_config 下也有一份（同一个 Supabase 项目），
 *    这里读的始终是 miniapp schema，两者互不影响。
 */

import {
  DEFAULT_WORD_COUNT_TIERS_CONFIG,
  InstructionSlotRulesSchema,
  DRIVE_MODE_OPTIONS_KEY,
  ReplyStyleOptionsConfigSchema,
  toPublicWordCountTiers,
  WordCountTiersConfigSchema,
  type PublicWordCountTiers,
  type InstructionSlotRules,
  type WordCountTiersConfig,
} from '@miniapp/shared';
import {
  fetchRuntimeConfigEntries,
  type RuntimeConfigEntry,
} from '../../platform/runtime-config.js';
import type {
  EnginePlatformInstructions,
  EngineReplyStyle,
  EngineWordCountTiers,
} from './types.js';
import { readDriveModes, warnIfDriveSlotMissing } from './drive-mode.js';

export const PLATFORM_INSTRUCTIONS_TEMPLATE_KEY = 'system_instructions';
export const WORD_COUNT_TIERS_KEY = 'pref_word_count_tiers';
export const CHOICE_RULES_KEY = 'choice_rules';
export const MEMORY_RULES_KEY = 'memory_rules';
export const REPLY_STYLE_OPTIONS_KEY = 'reply_style_options';

const CONFIG_KEYS = [
  PLATFORM_INSTRUCTIONS_TEMPLATE_KEY,
  WORD_COUNT_TIERS_KEY,
  CHOICE_RULES_KEY,
  MEMORY_RULES_KEY,
  REPLY_STYLE_OPTIONS_KEY,
  DRIVE_MODE_OPTIONS_KEY,
] as const;

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * 两个 key 全部缺失/损坏时的最后兜底。刻意写得很短——它只保证生成不中断，
 * 输出质量一定是降级的，靠 degraded 标记和日志把问题暴露出来，而不是让它悄悄跑下去。
 */
// 状态栏、记忆栏已不由正文模型输出：模板里不再要求 {{STATUS_RULES}}、{{MEMORY_RULES}}（留着也会渲染为空）。
const REQUIRED_TEMPLATE_PLACEHOLDERS = [
  '{{CHOICE_RULES}}',
  '{{WORD_COUNT}}',
  '{{USER_CUSTOM_INSTRUCTIONS}}',
] as const;

const FALLBACK_TEMPLATE = [
  'Roleplay System Instructions',
  '',
  '{{CHOICE_RULES}}',
  '{{MEMORY_RULES}}',
  '{{DRIVE_RULES}}',
  '输出篇幅为 {{WORD_COUNT}} 字，仅使用简体中文。',
  '用户个人偏好为：{{USER_CUSTOM_INSTRUCTIONS}}',
].join('\n');

/** A broken operator config must not make the model emit unverified markup. */
const FALLBACK_SLOT_RULES: InstructionSlotRules = {
  on_first_two_turns: '不要输出该模块的标签、标题或占位内容。',
  on_later_turns: '不要输出该模块的标签、标题或占位内容。',
  off: '不要输出该模块的标签、标题或占位内容。',
};

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

function isCurrentTemplate(template: string): boolean {
  return (
    !template.includes('{{INTERACTION_MODE}}') &&
    REQUIRED_TEMPLATE_PLACEHOLDERS.every((placeholder) => template.includes(placeholder))
  );
}

/** Strict Shared schema keeps Backend and Admin on the same config contract. */
export function parseInstructionSlotRules(value: unknown): InstructionSlotRules | null {
  const parsed = InstructionSlotRulesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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
  if (!template || !isCurrentTemplate(template)) {
    observation.emit(
      'engine.template_degraded',
      'engine.config',
      { outcome: 'degraded', outcome_known: false },
      'warn'
    );
    degraded = true;
  }

  const wordCountEntry = entries.get(WORD_COUNT_TIERS_KEY);
  let wordCountTiers = parseWordCountTiers(wordCountEntry?.value);
  if (!wordCountTiers) {
    observation.emit(
      'engine.word_count_degraded',
      'engine.config',
      { outcome: 'degraded', outcome_known: false },
      'warn'
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
      observation.emit(
        'engine.word_count_contract_degraded',
        'engine.config',
        {
          outcome: 'degraded',
          outcome_known: false,
          resource: WORD_COUNT_TIERS_KEY,
          config_version: wordCountEntry?.version,
        },
        'warn'
      );
      wordCountTiers = null;
      degraded = true;
    }
  }

  const slotRules = {
    choiceRules: readSlotRules(entries, CHOICE_RULES_KEY),
    memoryRules: readSlotRules(entries, MEMORY_RULES_KEY),
  };
  if (slotRules.choiceRules.degraded || slotRules.memoryRules.degraded) {
    degraded = true;
  }

  const replyStyles = readReplyStyles(entries);
  if (replyStyles.degraded) degraded = true;

  const driveModes = readDriveModes(entries);
  if (driveModes.degraded) degraded = true;
  const effectiveTemplate = template && isCurrentTemplate(template) ? template : FALLBACK_TEMPLATE;
  if (
    warnIfDriveSlotMissing(
      effectiveTemplate,
      driveModes.config,
      entries.get(PLATFORM_INSTRUCTIONS_TEMPLATE_KEY)?.version
    )
  ) {
    degraded = true;
  }

  return {
    instructions: {
      template: effectiveTemplate,
      wordCountTiers: wordCountTiers ?? FALLBACK_WORD_COUNT_TIERS,
      choiceRules: slotRules.choiceRules.rules,
      memoryRules: slotRules.memoryRules.rules,
      replyStyles: replyStyles.styles,
      driveModes: driveModes.config,
    },
    degraded,
  };
}

/** 未配置 = 没有可选风格；配置损坏时同样不注入任何风格，并打降级日志。 */
function readReplyStyles(entries: Map<string, RuntimeConfigEntry>): {
  styles: EngineReplyStyle[];
  degraded: boolean;
} {
  const entry = entries.get(REPLY_STYLE_OPTIONS_KEY);
  if (!entry) return { styles: [], degraded: false };

  const parsed = ReplyStyleOptionsConfigSchema.safeParse(entry.value);
  if (parsed.success) {
    return {
      styles: parsed.data.options.map(({ id, marker, rules, enabled }) => ({
        id,
        marker,
        rules,
        enabled,
      })),
      degraded: false,
    };
  }

  // Validation issues can contain operator rule text; log only the config identity/version.
  observation.emit(
    'engine.reply_styles_degraded',
    'engine.config',
    {
      outcome: 'degraded',
      outcome_known: false,
      resource: REPLY_STYLE_OPTIONS_KEY,
      config_version: entry.version,
    },
    'warn'
  );
  return { styles: [], degraded: true };
}

function readSlotRules(
  entries: Map<string, RuntimeConfigEntry>,
  key: typeof CHOICE_RULES_KEY | typeof MEMORY_RULES_KEY
): { rules: InstructionSlotRules; degraded: boolean } {
  const entry = entries.get(key);
  const rules = parseInstructionSlotRules(entry?.value);
  if (rules) return { rules, degraded: false };

  // Do not include validation issues or a JSON value here: both can contain operator rule text.
  observation.emit(
    'engine.slot_rules_degraded',
    'engine.config',
    { outcome: 'degraded', outcome_known: false },
    'warn'
  );
  return { rules: FALLBACK_SLOT_RULES, degraded: true };
}

/**
 * 读取平台规则，按 version 判活缓存（与模型目录同款策略）。
 * 任一 key 的 version 变化即重建，运营改文案后无需重启。
 */
export async function fetchPlatformInstructions(): Promise<PlatformInstructionsSnapshot> {
  let entries: Map<string, RuntimeConfigEntry>;
  try {
    entries = await fetchRuntimeConfigEntries(CONFIG_KEYS);
  } catch (error) {
    observation.emit(
      'engine.instructions_read_failed',
      'engine.config',
      { outcome: 'degraded', outcome_known: false, err: error },
      'warn'
    );
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
