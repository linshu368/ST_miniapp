/**
 * 读取运营配置。参数在每轮生成的准备阶段读取（与其他准备读取并行，版本未变时复用解析结果）；
 * prompt 只在 worker 执行任务时严格读取。缺失或非法时回落到代码默认值。
 */
import {
  DEFAULT_STORY_MEMORY_CONFIG,
  DEFAULT_STORY_MEMORY_PROMPT,
  STORY_MEMORY_CONFIG_KEY,
  STORY_MEMORY_PROMPT_KEY,
  StoryMemoryConfigSchema,
  StoryMemoryPromptSchema,
  type StoryMemoryConfig,
} from '@miniapp/shared';
import { createLogger } from '../../lib/logger.js';
import {
  fetchRuntimeConfigEntries,
  fetchRuntimeConfigEntryStrict,
} from '../../platform/runtime-config.js';

const log = createLogger('story-memory');

let cached: StoryMemoryConfig | null = null;
let cachedVersion: number | null = null;

export async function fetchStoryMemoryConfig(): Promise<StoryMemoryConfig> {
  let entry;
  try {
    entry = (await fetchRuntimeConfigEntries([STORY_MEMORY_CONFIG_KEY])).get(
      STORY_MEMORY_CONFIG_KEY
    );
  } catch (err) {
    log.sys.error(
      { err, event: 'story_memory.config.read_failed' },
      '记忆配置读取失败，使用默认值'
    );
    return cached ?? DEFAULT_STORY_MEMORY_CONFIG;
  }
  if (!entry) return DEFAULT_STORY_MEMORY_CONFIG;
  if (cached && cachedVersion === entry.version) return cached;

  const parsed = StoryMemoryConfigSchema.safeParse(entry.value);
  if (!parsed.success) {
    log.sys.error(
      { event: 'story_memory.config.degraded', version: entry.version },
      '记忆配置不合法，使用默认值'
    );
  }
  cached = parsed.success ? parsed.data : DEFAULT_STORY_MEMORY_CONFIG;
  cachedVersion = entry.version;
  return cached;
}

export interface StoryMemoryPromptTemplate {
  template: string;
  /** 写入每个版本，便于回放时知道是哪版 prompt 生成的 */
  version: string;
}

export async function fetchStoryMemoryPrompt(
  signal: AbortSignal
): Promise<StoryMemoryPromptTemplate> {
  const entry = await fetchRuntimeConfigEntryStrict(STORY_MEMORY_PROMPT_KEY, signal);
  if (!entry) return { template: DEFAULT_STORY_MEMORY_PROMPT, version: 'default' };
  const parsed = StoryMemoryPromptSchema.safeParse(entry.textValue);
  if (!parsed.success) {
    log.sys.error(
      { event: 'story_memory.prompt.degraded', version: entry.version },
      '压缩 prompt 不合法，使用内置初稿'
    );
    return { template: DEFAULT_STORY_MEMORY_PROMPT, version: 'default' };
  }
  return { template: parsed.data, version: `v${entry.version}` };
}

export function invalidateStoryMemoryConfigCache(): void {
  cached = null;
  cachedVersion = null;
}
