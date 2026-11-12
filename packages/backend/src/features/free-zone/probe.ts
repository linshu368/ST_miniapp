/**
 * 畅聊派单探测：用选定的供应商、带折扣底线，真发一个只要几个字的流式请求。
 *
 * 为什么要探测：Surplus 订单簿上的 discount_pct 和它派单时按请求估算的折扣不是一个数
 * （实测订单簿 86.5% / 90% 的报价，派单估算只有 75.9% / 70.9%，带 85% 底线直接 404）。
 * 只看订单簿会把派不出去的模型放上架，用户每次都落到原价兜底。
 *
 * 结果三类：
 * - ok：派出去了，记下首个字（正文或思考）的耗时；到上限还没出字也算 ok，耗时记为上限；
 * - unroutable：Surplus 明确说派不出去（折扣底线达不到、没有可用卖家）——这家本轮不达标；
 * - error：网络、超时没响应头、其他服务端错误——说不清，本轮维持现状。
 * 拿到首个字就中止，不等写完，花费只有几个 token。
 */
import type { FreeZoneProbe } from '@miniapp/shared';
import { forwardToUpstream, resolveProviderUpstream } from '../generation/upstream.js';

const PROBE_TIMEOUT_MS = 20_000;
const UNROUTABLE_CODES = new Set([
  'minimum_discount_not_met',
  'no_healthy_sellers',
  'no_available_sellers',
  'model_not_found',
]);

export type ProbeFn = (input: {
  model: string;
  provider: string;
  minDiscountPct: number;
}) => Promise<FreeZoneProbe>;

function errorCode(body: unknown): { code: string | null; message: string | null } {
  const error =
    typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : null;
  if (typeof error !== 'object' || error === null) return { code: null, message: null };
  const { code, message } = error as { code?: unknown; message?: unknown };
  return {
    code: typeof code === 'string' ? code : null,
    message: typeof message === 'string' ? message.slice(0, 200) : null,
  };
}

/** 读 SSE 直到第一个带正文或思考的 delta；返回耗时，流结束都没有则 null。 */
async function firstTokenMs(
  body: ReadableStream<Uint8Array>,
  startedAt: number,
  deadline: number
): Promise<number | null> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (performance.now() < deadline) {
      const { value, done } = await reader.read();
      if (done) return null;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const data = line.trim().startsWith('data:') ? line.trim().slice(5).trim() : '';
        if (!data || data === '[DONE]') continue;
        try {
          const event = JSON.parse(data) as {
            choices?: Array<{ delta?: Record<string, unknown> }>;
          };
          const delta = event.choices?.[0]?.delta ?? {};
          const text = [delta.content, delta.reasoning, delta.reasoning_content].find(
            (item) => typeof item === 'string' && item.length > 0
          );
          if (text) return Math.round(performance.now() - startedAt);
        } catch {
          // 非 JSON 的保活行等，忽略
        }
      }
    }
    return Math.round(deadline - startedAt);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** 和对话生成走同一个上游出口（upstream.ts），只是不进对话、不计费。 */
export function createSurplusProbe(
  options: { forward?: typeof forwardToUpstream; timeoutMs?: number } = {}
): ProbeFn {
  const forward = options.forward ?? forwardToUpstream;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  return async ({ model, provider, minDiscountPct }) => {
    const route = resolveProviderUpstream('surplus', model);
    const startedAt = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + 1_000);
    const base = { provider, first_token_ms: null };
    try {
      const response = await forward({
        ...route,
        method: 'POST',
        headers: { 'X-Min-Discount': String(minDiscountPct) },
        body: JSON.stringify({
          model,
          stream: true,
          max_tokens: 16,
          provider: [provider],
          // 量的是「不思考」时的首字；思考过程会作为首个字显示，不额外拖慢
          reasoning: { effort: 'none' },
          messages: [{ role: 'user', content: '只回复一个字：好' }],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const { code, message } = errorCode(await response.json().catch(() => null));
        const unroutable =
          (code !== null && UNROUTABLE_CODES.has(code)) ||
          response.status === 404 ||
          response.status === 503;
        return {
          ...base,
          outcome: unroutable ? 'unroutable' : 'error',
          detail: `${response.status}${code ? ` ${code}` : ''}${message ? `：${message}` : ''}`,
        };
      }
      if (!response.body) return { ...base, outcome: 'error', detail: '响应没有正文' };
      const ms = await firstTokenMs(response.body, startedAt, startedAt + timeoutMs);
      return ms === null
        ? { ...base, outcome: 'error', detail: '流结束了也没有出字' }
        : { ...base, outcome: 'ok', first_token_ms: ms, detail: null };
    } catch (err) {
      return {
        ...base,
        outcome: 'error',
        detail: err instanceof Error ? err.message.slice(0, 200) : '探测失败',
      };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  };
}
