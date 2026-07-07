/**
 * backend / routes / llm-proxy.ts
 *
 * LLM 代理网关：/api/platform/llm-proxy/v1/*
 *
 * ST 配置 LLM endpoint 指向此路由。职责：
 *   1. JWT platformToken 验签 → 提取 userId
 *   2. 从 body.model derive tier → 查配置表得扣费额度
 *   3. 余额预检（不足 → 402）
 *   4. 注入平台真实 API key，转发上游（默认 OpenRouter）
 *   5. SSE 流式透传；流正常结束后实际扣费
 *   6. 上游 5xx / 流中断 → 不扣费
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { Readable, Transform } from 'node:stream';
import { verifyPlatformToken } from '../lib/llm-token.js';
import { getModelTier } from '../platform/model-tiers.js';
import { MiniappWalletRepository } from '../infrastructure/repositories/MiniappWalletRepository.js';
import { saveChatHistory } from '../lib/chat-history-logger.js';

const LLM_UPSTREAM_URL = process.env.LLM_UPSTREAM_URL || 'https://openrouter.ai/api/v1';
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';

const STRIP_HEADERS = new Set([
  'transfer-encoding',
  'connection',
  'content-encoding',
  'content-length',
]);

const wallets = new MiniappWalletRepository();

// ─── JWT 验签中间件 ────────────────────────────────────────────────────────────

async function requirePlatformToken(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({
      error: {
        message: 'Missing or invalid Authorization header',
        type: 'auth_error',
      },
    });
  }

  const token = authHeader.slice(7);
  const userId = verifyPlatformToken(token);
  if (!userId) {
    request.log.warn('[llm-proxy] invalid platformToken');
    return reply.status(403).send({
      error: {
        message: 'Invalid or expired platform token',
        type: 'auth_error',
      },
    });
  }

  (request as FastifyRequest & { platformUserId: string }).platformUserId = userId;
}

// ─── 路由注册 ──────────────────────────────────────────────────────────────────

export default async function llmProxyRoutes(app: FastifyInstance) {
  app.all(
    '/api/platform/llm-proxy/v1/*',
    { preHandler: [requirePlatformToken] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request as FastifyRequest & { platformUserId: string }).platformUserId;

      if (!LLM_API_KEY) {
        return reply.status(503).send({
          error: {
            message: 'LLM proxy not configured: missing API key',
            type: 'configuration_error',
          },
        });
      }

      // ── 解析 model 并查配置表 ────────────────────────────────────────────
      let modelName = '';
      let deductionRate = 0;
      let chatMessages: unknown[] = [];
      let userInput = '';

      const characterId = (request.headers['x-st-character-id'] as string) || null;
      const presetId = (request.headers['x-st-preset-id'] as string) || null;

      const isChatCompletion =
        request.method !== 'GET' &&
        request.method !== 'HEAD' &&
        request.body &&
        typeof request.body === 'object';

      if (isChatCompletion) {
        const body = request.body as Record<string, unknown>;
        modelName = (body.model as string) || '';

        if (Array.isArray(body.messages)) {
          chatMessages = body.messages;
          for (let i = chatMessages.length - 1; i >= 0; i--) {
            const msg = chatMessages[i] as { role?: string; content?: string };
            if (msg.role === 'user' && msg.content) {
              userInput = msg.content;
              break;
            }
          }
        }
      }

      // 优先使用 st-extension 注入的原始用户输入（base64(UTF-8)）。
      // messages 数组末尾的 role=user 往往是预设注入的 post-history 指令（防截断/越狱等），
      // 且真实输入被模板前后缀包裹，故上面的提取只作 header 缺失时的回退。
      const rawInputHeader = request.headers['x-st-user-input'];
      if (typeof rawInputHeader === 'string' && rawInputHeader.length > 0) {
        try {
          const decoded = Buffer.from(rawInputHeader, 'base64').toString('utf8').trim();
          if (decoded) userInput = decoded;
        } catch (err) {
          request.log.warn(
            { err: String(err), userId },
            '[llm-proxy] failed to decode x-st-user-input header, falling back to messages extraction'
          );
        }
      }

      if (modelName) {
        const tierConfig = await getModelTier(modelName);
        deductionRate = tierConfig.deductionRate;
      }

      // ── 余额预检临时关闭：允许 0 积分用户正常发起 LLM 调用 ────────────────
      // if (deductionRate > 0) {
      //   try {
      //     const wallet = await wallets.getOrCreate(userId);
      //     const balance = wallet.total_credits ?? wallet.main_credits + wallet.bonus_credits;
      //     if (balance < deductionRate) {
      //       request.log.info(
      //         { userId, balance, required: deductionRate, model: modelName },
      //         '[llm-proxy] insufficient balance'
      //       );
      //       return reply.status(402).send({
      //         error: {
      //           message: `Insufficient credits: have ${balance}, need ${deductionRate}`,
      //           type: 'insufficient_balance',
      //           credits_required: deductionRate,
      //           credits_available: balance,
      //         },
      //       });
      //     }
      //   } catch (err) {
      //     request.log.error({ err: String(err), userId }, '[llm-proxy] wallet check failed');
      //     return reply.status(500).send({
      //       error: { message: 'Failed to check wallet balance', type: 'internal_error' },
      //     });
      //   }
      // }

      // ── 构造上游请求 ──────────────────────────────────────────────────────
      const subPath = request.url.replace(/^\/api\/platform\/llm-proxy\/v1/, '') || '/';
      const targetUrl = `${LLM_UPSTREAM_URL}${subPath}`;

      const forwardHeaders: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${LLM_API_KEY}`,
        'HTTP-Referer': 'http://localhost:3000',
        'X-Title': 'ST_miniAPP',
      };

      let bodyInit: BodyInit | undefined;
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        const rawBody = request.body;
        if (rawBody instanceof Buffer) {
          bodyInit = new Uint8Array(rawBody) as BodyInit;
        } else if (rawBody !== null && rawBody !== undefined) {
          bodyInit = JSON.stringify(rawBody);
        }
      }

      let upstreamRes: Response;
      try {
        upstreamRes = await fetch(targetUrl, {
          method: request.method,
          headers: forwardHeaders,
          body: bodyInit,
          // @ts-expect-error Node 18+ fetch supports duplex
          duplex: 'half',
        });
      } catch (err) {
        request.log.error({ err: String(err), targetUrl }, '[llm-proxy] upstream request failed');
        return reply.status(502).send({
          error: { message: `Upstream error: ${String(err)}`, type: 'upstream_error' },
        });
      }

      // 上游非 2xx → 不扣费，记录失败，直接透传
      if (!upstreamRes.ok) {
        if (isChatCompletion && userInput) {
          saveChatHistory(
            {
              user_id: userId,
              model: modelName,
              user_input: userInput,
              assistant_reply: null,
              history: chatMessages,
              character_id: characterId,
              preset_id: presetId,
              status: 'upstream_error',
              upstream_status: upstreamRes.status,
              deduction_rate: 0,
            },
            request.log
          );
        }

        reply.status(upstreamRes.status);
        upstreamRes.headers.forEach((value, key) => {
          if (!STRIP_HEADERS.has(key.toLowerCase())) {
            reply.header(key, value);
          }
        });
        if (upstreamRes.body) {
          const nodeStream = Readable.fromWeb(
            upstreamRes.body as import('stream/web').ReadableStream
          );
          return reply.send(nodeStream);
        }
        return reply.send(await upstreamRes.text());
      }

      // ── 透传响应头 ────────────────────────────────────────────────────────
      reply.status(upstreamRes.status);
      upstreamRes.headers.forEach((value, key) => {
        if (!STRIP_HEADERS.has(key.toLowerCase())) {
          reply.header(key, value);
        }
      });

      // ── 判断是否 SSE 流式 ─────────────────────────────────────────────────
      const contentType = upstreamRes.headers.get('content-type') || '';
      const isSSE = contentType.includes('text/event-stream');

      if (!upstreamRes.body) {
        if (deductionRate > 0) {
          deductAfterSuccess(userId, deductionRate, modelName, request);
        }
        if (isChatCompletion && userInput) {
          saveChatHistory(
            {
              user_id: userId,
              model: modelName,
              user_input: userInput,
              assistant_reply: null,
              history: chatMessages,
              character_id: characterId,
              preset_id: presetId,
              status: 'success',
              deduction_rate: deductionRate,
            },
            request.log
          );
        }
        return reply.send('');
      }

      if (isSSE) {
        const upstreamNodeStream = Readable.fromWeb(
          upstreamRes.body as import('stream/web').ReadableStream
        );

        let streamCompleted = false;
        const replyChunks: string[] = [];

        const sseTap = new Transform({
          transform(chunk, _encoding, callback) {
            const text = chunk.toString();
            if (text.includes('data: [DONE]')) {
              streamCompleted = true;
            }

            // 从 SSE data 行中提取 delta content 累积 assistant reply
            const lines = text.split('\n');
            for (const line of lines) {
              if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
              try {
                const json = JSON.parse(line.slice(6));
                const delta = json?.choices?.[0]?.delta?.content;
                if (typeof delta === 'string') {
                  replyChunks.push(delta);
                }
              } catch {
                // non-JSON data line, skip
              }
            }

            callback(null, chunk);
          },
          flush(callback) {
            if (streamCompleted) {
              if (deductionRate > 0) {
                deductAfterSuccess(userId, deductionRate, modelName, request);
              }
              if (isChatCompletion && userInput) {
                saveChatHistory(
                  {
                    user_id: userId,
                    model: modelName,
                    user_input: userInput,
                    assistant_reply: replyChunks.join(''),
                    history: chatMessages,
                    character_id: characterId,
                    preset_id: presetId,
                    status: 'success',
                    deduction_rate: deductionRate,
                  },
                  request.log
                );
              }
            } else {
              request.log.warn(
                { userId, model: modelName },
                '[llm-proxy] stream ended without [DONE], skipping deduction'
              );
              if (isChatCompletion && userInput) {
                saveChatHistory(
                  {
                    user_id: userId,
                    model: modelName,
                    user_input: userInput,
                    assistant_reply: replyChunks.length > 0 ? replyChunks.join('') : null,
                    history: chatMessages,
                    character_id: characterId,
                    preset_id: presetId,
                    status: 'stream_interrupted',
                    deduction_rate: 0,
                  },
                  request.log
                );
              }
            }
            callback();
          },
        });

        return reply.send(upstreamNodeStream.pipe(sseTap));
      }

      // 非 SSE 响应但有 body（如非流式 chat completion）
      const nodeStream = Readable.fromWeb(upstreamRes.body as import('stream/web').ReadableStream);
      if (deductionRate > 0) {
        deductAfterSuccess(userId, deductionRate, modelName, request);
      }
      if (isChatCompletion && userInput) {
        saveChatHistory(
          {
            user_id: userId,
            model: modelName,
            user_input: userInput,
            assistant_reply: null,
            history: chatMessages,
            character_id: characterId,
            preset_id: presetId,
            status: 'success',
            deduction_rate: deductionRate,
          },
          request.log
        );
      }
      return reply.send(nodeStream);
    }
  );
}

// ─── 扣费（fire-and-forget，不阻塞响应）──────────────────────────────────────

function deductAfterSuccess(
  userId: string,
  amount: number,
  model: string,
  request: FastifyRequest
): void {
  wallets
    .deduct(userId, amount)
    .then(() => {
      request.log.info({ userId, amount, model }, '[llm-proxy] deduction success');
    })
    .catch((err) => {
      request.log.error(
        { err: String(err), userId, amount, model },
        '[llm-proxy] deduction failed'
      );
    });
}
