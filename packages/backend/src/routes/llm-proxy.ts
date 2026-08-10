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
 *
 * 其中 2~6 的公共部分已在 M3a 抽到 features/generation/，由本路由与自研引擎共用同一出口，
 * 保证切换前后计费口径不变。留在本文件里的是 ST 链路专有部分：platformToken 验签、
 * X-ST-* header 解析、simulation 分支、OpenAI 兼容的请求/响应透传外壳。
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { InsufficientBalanceErrorResponse } from '@miniapp/shared';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { verifyPlatformTokenContext, type PlatformTokenContext } from '../lib/llm-token.js';
import { getModelBillingContext, getPricingConfig } from '../platform/model-tiers.js';
import { MiniappUserSettingsRepository } from '../infrastructure/repositories/MiniappUserSettingsRepository.js';
import { saveChatHistory } from '../lib/chat-history-logger.js';
import { requestLogger } from '../lib/logger.js';
import {
  LLM_API_KEY,
  checkWalletBalance,
  createSseTap,
  forwardToUpstream,
  noFreeQuotaReservation,
  reserveCharacterFreeQuota,
  resolveAuthoritativeModel,
  resolveBillingPlan,
  resolveUpstreamUrl,
  type FreeQuotaReservation,
} from '../features/generation/index.js';
import { getSupabaseClient } from '../lib/supabase.js';

const STRIP_HEADERS = new Set([
  'transfer-encoding',
  'connection',
  'content-encoding',
  'content-length',
]);

const userSettings = new MiniappUserSettingsRepository();

async function getSimulationModelId(conversationId: string): Promise<string | null> {
  const { data, error } = await getSupabaseClient()
    .schema('miniapp_simulation' as 'public')
    .from('conversations')
    .select('effective_model_id')
    .eq('id', conversationId)
    .single();
  if (error || !data) {
    throw new Error(`simulation conversation not found: ${conversationId}`);
  }
  const row = data as { effective_model_id?: string | null };
  return row.effective_model_id ?? null;
}

async function getSimulationTurnMetadata(
  conversationId: string,
  turnId: string
): Promise<Record<string, unknown>> {
  const { data, error } = await getSupabaseClient()
    .schema('miniapp_simulation' as 'public')
    .from('conversations')
    .select('current_turn_id,current_turn_metadata')
    .eq('id', conversationId)
    .single();
  if (error || !data) return {};
  const row = data as {
    current_turn_id?: string | null;
    current_turn_metadata?: unknown;
  };
  if (row.current_turn_id !== turnId) return {};
  return row.current_turn_metadata &&
    typeof row.current_turn_metadata === 'object' &&
    !Array.isArray(row.current_turn_metadata)
    ? (row.current_turn_metadata as Record<string, unknown>)
    : {};
}

async function getSimulationEffectiveContext(
  conversationId: string,
  capturedPresetId: string | null
): Promise<Record<string, unknown>> {
  const supabase = getSupabaseClient();
  const { data } = await supabase
    .schema('miniapp_simulation' as 'public')
    .from('conversations')
    .select('effective_model_id,preset_id')
    .eq('id', conversationId)
    .single();
  const conversation = data as {
    effective_model_id?: string | null;
    preset_id?: string | null;
  } | null;
  const presetId = conversation?.preset_id ?? capturedPresetId;
  let presetVersion: string | null = null;
  if (presetId) {
    const { data: preset } = await supabase
      .schema('st_platform' as 'public')
      .from('platform_presets')
      .select('updated_at')
      .eq('id', presetId)
      .maybeSingle();
    presetVersion = (preset as { updated_at?: string } | null)?.updated_at ?? null;
  }
  return {
    model_id: conversation?.effective_model_id ?? '',
    preset_id: presetId,
    preset_version: presetVersion,
  };
}

function parseBase64JsonHeader(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

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
  const context = verifyPlatformTokenContext(token);
  if (!context) {
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

  (request as FastifyRequest & { platformContext: PlatformTokenContext }).platformContext = context;
}

// ─── 路由注册 ──────────────────────────────────────────────────────────────────

export default async function llmProxyRoutes(app: FastifyInstance) {
  // @frontend-ready: true
  app.all(
    '/api/platform/llm-proxy/v1/*',
    { preHandler: [requirePlatformToken] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const platformContext = (
        request as FastifyRequest & { platformContext: PlatformTokenContext }
      ).platformContext;
      const userId = platformContext.mode === 'production' ? platformContext.userId : null;
      const simulationConversationId =
        platformContext.mode === 'simulation' ? platformContext.conversationId : null;
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
      const presetConfigWarning = (request.headers['x-st-preset-config-warning'] as string) || null;

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
      if (presetConfigWarning) {
        request.log.warn(
          { userId, modelName, presetId, presetConfigWarning },
          '[llm-proxy] generation continues with degraded preset configuration'
        );
      }

      // 模型选择以后端持久化设置为权威来源。ST iframe 的运行时设置可能因 WebView
      // 事件未生效而停留在旧模型；若继续信任 body.model，会出现 UI 已切换、实际生成和
      // 计费仍走旧模型。这里在每次生成前覆盖请求体，保证模型与计费快照一致。
      if (isChatCompletion) {
        try {
          const persistedModelId =
            platformContext.mode === 'production'
              ? await userSettings.getSelectedModelId(platformContext.userId)
              : await getSimulationModelId(platformContext.conversationId);
          const authoritativeModel = await resolveAuthoritativeModel(persistedModelId);
          const requestedModel = modelName;
          modelName = authoritativeModel.openRouterModelId;
          (request.body as Record<string, unknown>).model = modelName;

          if (requestedModel !== modelName) {
            log.biz.warn(
              {
                event: 'llm.model.mismatch_corrected',
                userId,
                simulationConversationId,
                requestedModel,
                authoritativeModel: modelName,
                selectedModelId: authoritativeModel.modelId,
              },
              'runtime model mismatch corrected'
            );
          }
        } catch (err) {
          log.sys.error(
            {
              event: 'llm.model.resolve_failed',
              err,
              userId,
              simulationConversationId,
              requestedModel: modelName,
            },
            'failed to resolve authoritative user model'
          );
          return reply.status(500).send({
            error: { message: 'Failed to resolve selected model', type: 'internal_error' },
          });
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
          log.sys.warn(
            { event: 'llm.input.decode_failed', err, userId },
            'failed to decode x-st-user-input header, falling back to messages extraction'
          );
        }
      }

      if (isChatCompletion) {
        log.biz.info(
          {
            event: 'llm.request.start',
            userId,
            simulationConversationId,
            model: modelName,
            characterId,
            presetId,
          },
          'LLM 生成请求开始'
        );
      }

      let simulation =
        platformContext.mode === 'simulation' && isChatCompletion
          ? {
              conversation_id: platformContext.conversationId,
              turn_id: String(request.headers['x-st-simulation-turn-id'] ?? ''),
              metadata: parseBase64JsonHeader(request.headers['x-st-simulation-metadata']),
              effective_config: parseBase64JsonHeader(
                request.headers['x-st-simulation-effective-config']
              ),
            }
          : undefined;
      if (
        simulation &&
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          simulation.turn_id
        )
      ) {
        return reply.status(400).send({
          error: { message: 'Missing or invalid simulation turn id', type: 'invalid_request' },
        });
      }
      if (simulation) {
        const effectiveContext = await getSimulationEffectiveContext(
          simulation.conversation_id,
          typeof simulation.effective_config.preset_id === 'string'
            ? simulation.effective_config.preset_id
            : null
        );
        simulation = {
          ...simulation,
          metadata: await getSimulationTurnMetadata(simulation.conversation_id, simulation.turn_id),
          effective_config: {
            ...simulation.effective_config,
            ...effectiveContext,
            model_name: modelName,
          },
        };
      }

      const chargeId = randomUUID();
      const pricing = await getPricingConfig();
      const billingContext = await getModelBillingContext(modelName, pricing.markup);

      // 免费额度只对 production 的对话请求成立：simulation 不计费，非 chat completion
      // （模型列表等 GET）也没有轮次概念。判定本身在 features/generation/quota.ts。
      let reservation: FreeQuotaReservation;
      try {
        reservation =
          platformContext.mode === 'production' && isChatCompletion
            ? await reserveCharacterFreeQuota({
                chargeId,
                userId: platformContext.userId,
                characterId,
                billing: billingContext,
                log,
              })
            : noFreeQuotaReservation(billingContext.modelMarkup);
      } catch {
        return reply.status(500).send({
          error: { message: 'Failed to reserve free quota', type: 'internal_error' },
        });
      }

      const billingPlan = resolveBillingPlan({
        chargeId,
        billing: billingContext,
        effectiveModelMarkup: reservation.effectiveModelMarkup,
        pricing,
        log,
      });
      const billingSnapshot = billingPlan.snapshot;

      // ── 余额预检：不足基线时在调用上游前返回 402，由 ST bridge 引导充值 ─────────
      try {
        if (platformContext.mode === 'simulation') {
          log.biz.debug(
            {
              event: 'llm.balance.check_skipped',
              simulationConversationId,
              model: modelName,
            },
            'simulation balance check skipped'
          );
        } else if (!userId) {
          throw new Error('production user id is missing');
        } else {
          const precheck = await checkWalletBalance({
            userId,
            requiredAmount: billingPlan.fixedDeduction.amount,
            openRouterModelId: modelName,
            log,
          });
          if (!precheck.ok) {
            const response: InsufficientBalanceErrorResponse = {
              error: {
                message: `Insufficient credits: have ${precheck.creditsAvailable}, need ${precheck.creditsRequired}`,
                type: 'insufficient_balance',
                credits_required: precheck.creditsRequired,
                credits_available: precheck.creditsAvailable,
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
      const targetUrl = resolveUpstreamUrl(subPath);

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
        upstreamRes = await forwardToUpstream({
          url: targetUrl,
          method: request.method,
          body: bodyInit,
        });
      } catch (err) {
        await reservation.finalize(false);
        log.sys.error({ event: 'llm.upstream.error', err, targetUrl }, 'upstream request failed');
        return reply.status(502).send({
          error: { message: `Upstream error: ${String(err)}`, type: 'upstream_error' },
        });
      }

      // 上游非 2xx → 不扣费，记录失败，直接透传
      if (!upstreamRes.ok) {
        await reservation.finalize(false);
        if (isChatCompletion && userInput) {
          saveChatHistory(
            {
              user_id: userId,
              simulation,
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
        await reservation.finalize(true);
        if (isChatCompletion && userInput) {
          saveChatHistory(
            {
              user_id: userId,
              simulation,
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

        // tap 只累积不改写，chunk 逐字节透传给 ST；终态在 flush 里跑完才放行下游结束。
        const sseTap = createSseTap({
          generationId,
          onEnd: async (tapped) => {
            generationId = tapped.generationId;
            await reservation.finalize(tapped.completed);
            if (tapped.completed) {
              log.biz.info(
                {
                  event: 'llm.generation.completed',
                  userId,
                  simulationConversationId,
                  model: modelName,
                  generationId,
                  replyChars: tapped.content.length,
                },
                'LLM 生成完成'
              );
              if (isChatCompletion && userInput) {
                saveChatHistory(
                  {
                    user_id: userId,
                    simulation,
                    model: modelName,
                    ...billingSnapshot,
                    user_input: userInput,
                    assistant_reply: tapped.content,
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
                {
                  event: 'llm.generation.interrupted',
                  userId,
                  simulationConversationId,
                  model: modelName,
                  generationId,
                },
                'stream ended without [DONE], skipping deduction'
              );
              if (isChatCompletion && userInput) {
                saveChatHistory(
                  {
                    user_id: userId,
                    simulation,
                    model: modelName,
                    ...billingSnapshot,
                    user_input: userInput,
                    assistant_reply: tapped.deltaCount > 0 ? tapped.content : null,
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
          },
        });

        return reply.send(upstreamNodeStream.pipe(sseTap));
      }

      // 非 SSE 响应但有 body（如非流式 chat completion）
      let responseBody: string;
      try {
        responseBody = await upstreamRes.text();
      } catch (err) {
        await reservation.finalize(false);
        log.sys.error(
          { event: 'llm.upstream.body_read_failed', err, userId, model: modelName },
          'failed to read non-streaming upstream response'
        );
        return reply.status(502).send({
          error: { message: 'Failed to read upstream response', type: 'upstream_error' },
        });
      }

      let assistantReply: string | null = null;
      let responseParsed = false;
      try {
        const parsed = JSON.parse(responseBody);
        responseParsed = true;
        if (!generationId && typeof parsed?.id === 'string') generationId = parsed.id;
        const content = parsed?.choices?.[0]?.message?.content;
        if (typeof content === 'string') assistantReply = content;
      } catch {
        log.sys.warn(
          { event: 'llm.upstream.invalid_non_stream_response', userId, model: modelName },
          'successful upstream response was not valid JSON'
        );
      }
      if (!responseParsed) {
        await reservation.finalize(false);
        if (isChatCompletion && userInput) {
          saveChatHistory(
            {
              user_id: userId,
              simulation,
              model: modelName,
              ...billingSnapshot,
              user_input: userInput,
              assistant_reply: null,
              history: chatMessages,
              character_id: characterId,
              preset_id: presetId,
              status: 'upstream_error',
              upstream_status: upstreamRes.status,
              generation_id: generationId,
            },
            log
          );
        }
        return reply.send(responseBody);
      }
      await reservation.finalize(true);
      if (isChatCompletion && userInput) {
        saveChatHistory(
          {
            user_id: userId,
            simulation,
            model: modelName,
            ...billingSnapshot,
            user_input: userInput,
            assistant_reply: assistantReply,
            history: chatMessages,
            character_id: characterId,
            preset_id: presetId,
            status: 'success',
            generation_id: generationId,
          },
          log
        );
      }
      return reply.send(responseBody);
    }
  );
}
