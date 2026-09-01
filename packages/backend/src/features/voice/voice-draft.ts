/**
 * 写稿阶段：把角色回复改写成台词。对齐语音管道 0821 版的 step_llm_convert。
 *
 * 供应商是 DeepSeek 的 deepseek-v4-flash，OpenAI 兼容格式。有两个上游行为必须知道：
 *
 * 1. 思考模式默认是开的、默认强度 high，思考 token 按输出价计费。
 * 2. 思考开启时 temperature / top_p 一律不生效，只有关思考时才吃得到。
 *
 * 第一闸为什么关思考：实测同样的原文，开 low 思考要 15~18 秒、多花 2.7 倍 token，
 * 产出与关思考完全等价——含一个刻意做难的样本（混入他人台词、内心独白、大段动作
 * 描写，外加一句没打引号的低语），两种模式都挑对了。写稿本质是抽取任务，
 * DeepSeek 官方文档也建议这类任务关思考。语音是用户点完要等的功能，
 * 25 秒和 8 秒的差别比那点 token 重要得多。
 *
 * 三道闸的分工：模型「返回了但不能用」（空、或长到不像台词）时逐级升级重试；
 * 「根本没返回」（超时、HTTP 错）时直接抛错，不降级。后者故意不兜——上游挂了
 * 或 key 配错了却一直静默走正则兜底，是最难发现的那种故障。
 */

import { MAX_SPOKEN_VOICE_CHARS } from '@miniapp/shared';
import { config } from '../../platform/config.js';
import { buildVoiceUserPrompt, VOICE_SYSTEM_PROMPT } from './voice-prompt.js';
import { extractQuotedLines, normalizeConvertedText } from './voice-text.js';
import { stageCode, toTransportError, VoiceUpstreamError } from './voice-upstream.js';

/** 给足思考空间。写稿便宜，宁可多留 token 也别让思考把正文挤掉 */
const MAX_TOKENS = 20000;

const TEMPERATURE = 0.8;

export const MAX_SPOKEN_CHARS = MAX_SPOKEN_VOICE_CHARS;

export type DraftGate = 'thinking_off' | 'thinking_low' | 'quote_fallback';

export interface DraftResult {
  /** 成品台词，纯文本无标签，可直接送 TTS */
  text: string;
  /** 实际是哪一闸产出的。正常应当压倒性是 thinking_off */
  gate: DraftGate;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

async function callDeepSeek(
  sourceText: string,
  extra: Record<string, unknown>,
  mode: 'reply' | 'custom'
): Promise<string> {
  if (!config.voice.draft.apiKey) {
    throw new VoiceUpstreamError('draft', 'voice_not_configured', '语音服务未配置');
  }

  let response: Response;
  try {
    response = await fetch(config.voice.draft.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.voice.draft.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: config.voice.draft.model,
        messages: [
          { role: 'system', content: VOICE_SYSTEM_PROMPT },
          { role: 'user', content: buildVoiceUserPrompt(sourceText, mode) },
        ],
        max_tokens: MAX_TOKENS,
        temperature: TEMPERATURE,
        ...extra,
      }),
      signal: AbortSignal.timeout(config.voice.timeoutMs),
    });
  } catch (error) {
    throw toTransportError('draft', error);
  }

  let body: ChatCompletionResponse;
  try {
    body = (await response.json()) as ChatCompletionResponse;
  } catch {
    throw new VoiceUpstreamError(
      'draft',
      stageCode('draft', 'bad_response'),
      '写稿服务返回了无法解析的内容'
    );
  }

  if (!response.ok) {
    // error.message 可能带上游的内部细节，只留给日志，不进用户可见的提示
    throw new VoiceUpstreamError(
      'draft',
      stageCode('draft', String(response.status)),
      body.error?.message || `写稿服务返回 HTTP ${response.status}`
    );
  }

  // 思考过程在 reasoning_content，正文在 content。思考把 token 预算吃光时
  // 会出现 HTTP 200 但 content 为空——交给下一闸处理，不在这里报错。
  return (body.choices?.[0]?.message?.content ?? '').trim();
}

function isUsable(text: string): boolean {
  return text.length > 0 && text.length <= MAX_SPOKEN_VOICE_CHARS;
}

export async function draftSpokenText(
  sourceText: string,
  mode: 'reply' | 'custom' = 'reply'
): Promise<DraftResult> {
  // 闸 1：不思考，直接写。绝大多数回复到这里就结束了
  const off = normalizeConvertedText(
    await callDeepSeek(sourceText, { thinking: { type: 'disabled' } }, mode)
  );
  if (isUsable(off)) return { text: off, gate: 'thinking_off' };

  // 闸 2：给它想一会儿再来一次
  const low = normalizeConvertedText(
    await callDeepSeek(sourceText, { reasoning_effort: 'low' }, mode)
  );
  if (isUsable(low)) return { text: low, gate: 'thinking_low' };

  // 闸 3：规则抽引号。产出必然是原文里真实存在的台词，且天然短
  const quoted = normalizeConvertedText(extractQuotedLines(sourceText));
  if (quoted.length > MAX_SPOKEN_VOICE_CHARS) {
    // 抽出的引号仍超 300：长对白，不要送 TTS。与「无可朗读内容」用不同 code，
    // 用户要的是「请删减」，不是「这条回复不能念」
    throw new VoiceUpstreamError('draft', 'voice_text_too_long', '台词超过 300 字上限');
  }
  if (quoted) return { text: quoted, gate: 'quote_fallback' };

  // 闸 4：彻底失败，拒绝送入语音
  throw new VoiceUpstreamError('draft', stageCode('draft', 'unusable'), '这条回复没有可朗读的内容');
}
