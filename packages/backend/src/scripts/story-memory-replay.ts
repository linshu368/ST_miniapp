/**
 * 离线回放：对一个已有会话，从第 1 轮起按线上完全相同的 prompt、分块与校验逻辑
 * 逐块压缩，把每一块的档案打印到标准输出。只读，不写任何版本或任务状态。
 *
 * 用法（在配置了 Supabase 与 LLM_API_KEY 的环境，建议 TEST 库）：
 *   pnpm --filter @miniapp/backend story-memory:replay -- --session <uuid> [--to <turn>]
 *     [--chunk-chars 40000] [--prompt-file ./draft.txt] [--model <openrouter id>]
 *
 * --prompt-file 用于在发布到运营平台前试跑新 prompt；不传则读已发布版本（缺失时用内置初稿）。
 */
import '../platform/config.js';
import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { extractStoryMemorySections, StoryMemoryPromptSchema } from '@miniapp/shared';
import { StoryMemoryRepository } from '../infrastructure/repositories/StoryMemoryRepository.js';
import { closeSupabaseClient, getDomainDb } from '../lib/supabase.js';
import {
  chunkTurns,
  compressChunk,
  loadStoryContext,
} from '../features/story-memory/compress-job.js';
import { fetchStoryMemoryConfig, fetchStoryMemoryPrompt } from '../features/story-memory/config.js';
import { countChars, renderTurnsForCompression } from '../features/story-memory/text.js';

const { values } = parseArgs({
  options: {
    session: { type: 'string' },
    to: { type: 'string' },
    'chunk-chars': { type: 'string' },
    'prompt-file': { type: 'string' },
    model: { type: 'string' },
  },
});

async function readSession(sessionId: string) {
  const { data, error } = await getDomainDb('experience')
    .from('chat_sessions')
    .select('id,user_id,character_id')
    .eq('id', sessionId)
    .maybeSingle();
  if (error || !data) throw new Error(`会话不存在或读取失败：${error?.message ?? sessionId}`);
  const row = data as { id: string; user_id: string; character_id: string };
  return { sessionId: row.id, userId: row.user_id, characterId: row.character_id };
}

async function resolvePrompt() {
  if (!values['prompt-file']) return fetchStoryMemoryPrompt(AbortSignal.timeout(5_000));
  const template = StoryMemoryPromptSchema.parse(await readFile(values['prompt-file'], 'utf8'));
  return { template, version: `file:${values['prompt-file']}` };
}

async function main() {
  if (!values.session) throw new Error('缺少 --session <uuid>');
  const session = await readSession(values.session);
  const config = await fetchStoryMemoryConfig();
  const chunkChars = values['chunk-chars'] ? Number(values['chunk-chars']) : config.chunk_chars;
  const prompt = await resolvePrompt();
  const model = values.model || config.model_id;

  const turns = await new StoryMemoryRepository().readTurns({
    sessionId: session.sessionId,
    fromTurn: 1,
    toTurn: values.to ? Number(values.to) : 100000,
    limit: 1000,
  });
  const story = await loadStoryContext(session);
  const sections = extractStoryMemorySections(prompt.template);
  const chunks = chunkTurns(turns, chunkChars);
  console.log(
    `# 回放 ${session.sessionId}：${turns.length} 轮，${chunks.length} 块，模型 ${model}，prompt ${prompt.version}\n`
  );

  let memory: string | null = null;
  for (const [index, chunk] of chunks.entries()) {
    const first = chunk[0]!.turnIndex;
    const last = chunk.at(-1)!.turnIndex;
    const newHistory = renderTurnsForCompression(chunk, story.userName);
    const startedAt = performance.now();
    const result = await compressChunk({
      ctx: {
        prompt,
        model,
        config,
        onRejected: (reason) => console.log(`> 第 ${index + 1} 块校验未通过：${reason}，重试`),
      },
      sections,
      oldMemory: memory,
      promptVars: {
        user_name: story.userName,
        char_name: story.charName,
        max_chars: String(config.memory_max_chars),
        old_memory: memory ?? '（空）',
        new_history: newHistory,
        // Offline replay has no live window; the next chunk stands in as recent context.
        recent_context: chunks[index + 1]
          ? renderTurnsForCompression(
              chunks[index + 1]!.slice(0, config.recent_context_turns),
              story.userName
            )
          : '（无）',
      },
    });
    memory = result.content;
    console.log(
      `## 第 ${index + 1}/${chunks.length} 块 T${first}-T${last}｜输入 ${countChars(newHistory)} 字｜档案 ${countChars(memory)} 字｜${Math.round(performance.now() - startedAt)}ms｜tokens ${result.inputTokens ?? '?'}/${result.outputTokens ?? '?'}\n`
    );
    console.log(memory + '\n');
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await closeSupabaseClient();
}
