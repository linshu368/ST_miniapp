/**
 * 记忆栏 prompt 在运营平台（memory_bar_prompt，纯文本）。每次检查都读线上版本，改了下一次检查就生效。
 * 不在代码里放兜底文本：读不到或不合法就不检查，记 error，由运营在平台上补。
 */
import { MEMORY_BAR_PROMPT_KEY, MemoryBarPromptSchema } from '@miniapp/shared';
import { fetchRuntimeConfigEntryStrict } from '../../platform/runtime-config.js';

const TIMEOUT_MS = 5_000;

export interface MemoryBarPrompt {
  text: string;
  /** 运营配置的版本号，记进每条记忆，回看时知道是哪版 prompt 记的 */
  version: number;
}

export async function fetchMemoryBarPrompt(): Promise<MemoryBarPrompt | null> {
  const entry = await fetchRuntimeConfigEntryStrict(
    MEMORY_BAR_PROMPT_KEY,
    AbortSignal.timeout(TIMEOUT_MS)
  );
  const parsed = MemoryBarPromptSchema.safeParse(entry?.textValue);
  return entry && parsed.success ? { text: parsed.data, version: entry.version } : null;
}
