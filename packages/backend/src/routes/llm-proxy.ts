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
import {
  resolveEffectiveSelectedModelId,
  resolveEnabledCatalogModel,
  type InsufficientBalanceErrorResponse,
} from '@miniapp/shared';
import { randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { verifyPlatformToken } from '../lib/llm-token.js';
import {
  fetchModelCatalogSnapshot,
  getModelBillingContext,
  getPricingConfig,
} from '../platform/model-tiers.js';
import { MiniappWalletRepository } from '../infrastructure/repositories/MiniappWalletRepository.js';
import { MiniappUserSettingsRepository } from '../infrastructure/repositories/MiniappUserSettingsRepository.js';
import { saveChatHistory } from '../lib/chat-history-logger.js';
import { requestLogger } from '../lib/logger.js';
import { extractMarkedUserInput } from '../lib/llm-user-input.js';

const LLM_UPSTREAM_URL = process.env.LLM_UPSTREAM_URL || 'https://openrouter.ai/api/v1';
const LLM_API_KEY = process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '';

const STRIP_HEADERS = new Set([
  'transfer-encoding',
  'connection',
  'content-encoding',
  'content-length',
]);

const wallets = new MiniappWalletRepository();
const userSettings = new MiniappUserSettingsRepository();

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
    requestLogger(request.log, 'llm-proxy').sys.warn(
      { event: 'llm.auth.invalid_token' },
      'invalid platformToken'
    );
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
      const log = requestLogger(request.log, 'llm-proxy');

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
          const extraction = extractMarkedUserInput(body.messages);
          chatMessages = extraction.messages;
          body.messages = extraction.messages;
          userInput = extraction.userInput;
          if (extraction.issue) {
            request.log.warn(
              { userId, issue: extraction.issue },
              '[llm-proxy] user input marker validation failed'
            );
          }
        }
      }

      // 模型选择以后端持久化设置为权威来源。ST iframe 的运行时设置可能因 WebView
      // 事件未生效而停留在旧模型；若继续信任 body.model，会出现 UI 已切换、实际生成和
      // 计费仍走旧模型。这里在每次生成前覆盖请求体，保证模型与计费快照一致。
      if (isChatCompletion) {
        try {
          const [snapshot, persistedModelId] = await Promise.all([
            fetchModelCatalogSnapshot(),
            userSettings.getSelectedModelId(userId),
          ]);
          const effectiveModelId = resolveEffectiveSelectedModelId(
            snapshot.catalog,
            persistedModelId
          );
          const authoritativeModel = resolveEnabledCatalogModel(snapshot.catalog, effectiveModelId);
          const requestedModel = modelName;
          modelName = authoritativeModel.openrouter_model_id;
          (request.body as Record<string, unknown>).model = modelName;

          if (requestedModel !== modelName) {
            log.biz.warn(
              {
                event: 'llm.model.mismatch_corrected',
                userId,
                requestedModel,
                authoritativeModel: modelName,
                selectedModelId: authoritativeModel.id,
              },
              'runtime model mismatch corrected'
            );
          }
        } catch (err) {
          log.sys.error(
            { event: 'llm.model.resolve_failed', err, userId, requestedModel: modelName },
            'failed to resolve authoritative user model'
          );
          return reply.status(500).send({
            error: { message: 'Failed to resolve selected model', type: 'internal_error' },
          });
        }
      }

      if (isChatCompletion) {
        log.biz.info(
          { event: 'llm.request.start', userId, model: modelName, characterId, presetId },
          'LLM 生成请求开始'
        );
      }

      const chargeId = randomUUID();
      const pricing = await getPricingConfig();
      const billingContext = await getModelBillingContext(modelName, pricing.markup);
      const modelMarkup = billingContext.modelMarkup;
      const balanceBaseline = pricing.balanceBaseline;
      const billingSnapshot = {
        charge_id: chargeId,
        model_id: billingContext.modelId,
        model_display_name: billingContext.modelDisplayName,
        model_markup: modelMarkup,
        catalog_version: billingContext.catalogVersion,
        pricing_config_version: pricing.version,
        exchange_rate: pricing.exchangeRate,
        fallback_cost: pricing.fallbackCost,
      };

      // ── 余额预检：不足基线时在调用上游前返回 402，由 ST bridge 引导充值 ─────────
      try {
        if (modelMarkup === 0) {
          log.biz.debug(
            { event: 'llm.balance.check_skipped', userId, model: modelName },
            'free model balance check skipped'
          );
        } else {
          const wallet = await wallets.getOrCreate(userId);
          const balance = wallet.total_credits ?? wallet.main_credits + wallet.bonus_credits;
          if (balance < balanceBaseline) {
            log.biz.info(
              {
                event: 'llm.balance.insufficient',
                userId,
                balance,
                required: balanceBaseline,
                model: modelName,
              },
              'insufficient balance'
            );
            const response: InsufficientBalanceErrorResponse = {
              error: {
                message: `Insufficient credits: have ${balance}, need baseline ${balanceBaseline}`,
                type: 'insufficient_balance',
                credits_required: balanceBaseline,
                credits_available: balance,
              },
            };
            // ST 的非流式代理会把上游非 2xx 包成外层 200，但会保留 statusText 到
            // error.message。使用唯一状态文本，让浏览器扩展仍能可靠识别余额不足。
            reply.raw.statusMessage = 'MiniApp Insufficient Credits';
            return reply.status(402).send(response);
          }
        }
      } catch (err) {
        log.sys.error({ event: 'llm.balance.check_failed', err, userId }, 'wallet check failed');
        return reply.status(500).send({
          error: { message: 'Failed to check wallet balance', type: 'internal_error' },
        });
      }

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
        log.sys.error({ event: 'llm.upstream.error', err, targetUrl }, 'upstream request failed');
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
              ...billingSnapshot,
              user_input: userInput,
              assistant_reply: null,
              history: chatMessages,
              character_id: characterId,
              preset_id: presetId,
              status: 'upstream_error',
              upstream_status: upstreamRes.status,
            },
            log
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
      let generationId = upstreamRes.headers.get('x-generation-id') || null;

      if (!upstreamRes.body) {
        if (isChatCompletion && userInput) {
          saveChatHistory(
            {
              user_id: userId,
              model: modelName,
              ...billingSnapshot,
              user_input: userInput,
              assistant_reply: null,
              history: chatMessages,
              character_id: characterId,
              preset_id: presetId,
              status: 'success',
              generation_id: generationId,
            },
            log
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
        let sseBuffer = '';

        const sseTap = new Transform({
          transform(chunk, _encoding, callback) {
            sseBuffer += chunk.toString();
            const lines = sseBuffer.split('\n');
            // 保留最后一行（可能不完整），其余行处理
            sseBuffer = lines.pop() || '';

            for (const line of lines) {
              if (line.includes('data: [DONE]')) {
                streamCompleted = true;
                continue;
              }
              if (!line.startsWith('data: ')) continue;
              try {
                const json = JSON.parse(line.slice(6));
                if (!generationId && typeof json?.id === 'string') {
                  generationId = json.id;
                }
                const delta = json?.choices?.[0]?.delta?.content;
                if (typeof delta === 'string') {
                  replyChunks.push(delta);
                }
              } catch {
                // non-JSON data line or incomplete JSON, skip
              }
            }

            callback(null, chunk);
          },
          flush(callback) {
            // 处理 buffer 中剩余的最后一行
            if (sseBuffer.includes('data: [DONE]')) {
              streamCompleted = true;
            } else if (sseBuffer.startsWith('data: ')) {
              try {
                const json = JSON.parse(sseBuffer.slice(6));
                if (!generationId && typeof json?.id === 'string') {
                  generationId = json.id;
                }
                const delta = json?.choices?.[0]?.delta?.content;
                if (typeof delta === 'string') {
                  replyChunks.push(delta);
                }
              } catch {}
            }

            if (streamCompleted) {
              log.biz.info(
                {
                  event: 'llm.generation.completed',
                  userId,
                  model: modelName,
                  generationId,
                  replyChars: replyChunks.join('').length,
                },
                'LLM 生成完成'
              );
              if (isChatCompletion && userInput) {
                saveChatHistory(
                  {
                    user_id: userId,
                    model: modelName,
                    ...billingSnapshot,
                    user_input: userInput,
                    assistant_reply: replyChunks.join(''),
                    history: chatMessages,
                    character_id: characterId,
                    preset_id: presetId,
                    status: 'success',
                    generation_id: generationId,
                  },
                  log
                );
              }
            } else {
              log.biz.warn(
                { event: 'llm.generation.interrupted', userId, model: modelName, generationId },
                'stream ended without [DONE], skipping deduction'
              );
              if (isChatCompletion && userInput) {
                saveChatHistory(
                  {
                    user_id: userId,
                    model: modelName,
                    ...billingSnapshot,
                    user_input: userInput,
                    assistant_reply: replyChunks.length > 0 ? replyChunks.join('') : null,
                    history: chatMessages,
                    character_id: characterId,
                    preset_id: presetId,
                    status: 'stream_interrupted',
                    generation_id: generationId,
                  },
                  log
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
      if (isChatCompletion && userInput) {
        saveChatHistory(
          {
            user_id: userId,
            model: modelName,
            ...billingSnapshot,
            user_input: userInput,
            assistant_reply: null, // 非流式通常在这里无法简单拦截 body
            history: chatMessages,
            character_id: characterId,
            preset_id: presetId,
            status: 'success',
            generation_id: generationId,
          },
          log
        );
      }
      return reply.send(nodeStream);
    }
  );
}
