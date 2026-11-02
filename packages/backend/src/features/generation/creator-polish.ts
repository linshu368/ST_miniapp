import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { CreatorPolishEvent, CreatorPolishRequest } from '@miniapp/shared';
import { createSseTap, forwardToUpstream, resolveProviderUpstream } from './upstream.js';
import { buildPolishMessages, MODEL_ID } from './creator-polish-prompts.js';
import { resolveCreatorPresets } from '../creator/preset-catalog.js';

export class CreatorPolishError extends Error {
  constructor(readonly status: number) {
    super(`creator_polish_http_${status}`);
  }
}

export function polishErrorMessage(error: unknown): string {
  if (error instanceof CreatorPolishError) {
    if (error.status === 429) return '模型暂时繁忙，请稍后再试。原稿已保留。';
    if ([401, 402, 403, 404, 503].includes(error.status))
      return 'AI 润色暂时不可用，请稍后再试。原稿已保留。';
  }
  return '本次润色未完整完成，已有内容仍可采用。原稿已保留。';
}

/** Creator editing uses the existing generation provider transport; it is not a paid chat turn. */
export async function streamCreatorPolish(
  input: CreatorPolishRequest,
  signal: AbortSignal,
  send: (event: CreatorPolishEvent) => void
): Promise<{ completed: boolean; characters: number }> {
  const upstream = resolveProviderUpstream('openrouter');
  if (!upstream.apiKey) throw new CreatorPolishError(503);
  const presets = await resolveCreatorPresets(input.draft.selectedPresetIds);
  const messages = buildPolishMessages(input.target, input.draft, presets);
  const response = await forwardToUpstream({
    ...upstream,
    method: 'POST',
    signal,
    body: JSON.stringify({
      model: MODEL_ID,
      stream: true,
      messages: [
        { role: 'system', content: messages.system },
        { role: 'user', content: messages.prompt },
      ],
      ...(input.target === 'opening' ? { max_tokens: 8192 } : {}),
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new CreatorPolishError(response.status);
  }
  if (!response.body) throw new CreatorPolishError(502);
  const tap = createSseTap({
    onDelta: (text) => send({ type: 'delta', text }),
    onEnd: () => undefined,
  });
  // Reuse the chat SSE parser (UTF-8 splits/reasoning) while bounding provider resource use.
  const body = response.body;
  async function* boundedBody() {
    const reader = body!.getReader();
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 2_000_000) throw new Error('creator_polish_response_too_large');
        yield chunk.value;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  }
  await pipeline(
    Readable.from(boundedBody()),
    tap,
    new Writable({
      write(_chunk, _encoding, next) {
        next();
      },
    }),
    { signal }
  );
  const result = tap.snapshot();
  const completed =
    result.completed && result.finishReason === 'stop' && Boolean(result.content.trim());
  send(
    completed
      ? { type: 'done' }
      : {
          type: 'error',
          message: result.content.trim()
            ? '这次润色未完整完成，可以采用已有内容后继续编辑。'
            : '模型没有返回润色内容，请重试。原稿已保留。',
        }
  );
  return { completed, characters: result.content.length };
}
