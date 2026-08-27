/**
 * backend / routes / voice.ts
 *
 * 聊天页角色语音：用户级音色偏好 + 按消息生成/读取语音。
 *
 * 生成不同步等结果：改写加合成最坏要几十秒，同步等会被各层代理掐断，
 * 手机端切后台也会断。所以 POST 只负责「受理」——落一行 pending 立刻返回，
 * 真正的活在进程内异步跑，前端轮询 GET 拿终态。
 *
 * 计费（migration 097 起）：每次生成成功（音频可播后）扣 voice_generation_credits
 * 星尘（默认 15）。受理阶段做 402 预检——余额不足不建 pending，避免「转圈半分钟
 * 再告诉你没钱」。见到可播音频才扣（generate.ts），超限/写稿失败/TTS 失败不扣。
 * 计费开关 voice_billing_enabled 关闭时跳过预检与扣费，行为与现网一致。
 */

import type { FastifyInstance } from 'fastify';
import { fail, MAX_CUSTOM_VOICE_CHARS, ok } from '@miniapp/shared';
import type {
  CreateMessageVoiceData,
  CreateMessageVoiceRequest,
  GetSessionVoiceData,
  GetVoiceConfigData,
  InsufficientBalanceErrorResponse,
  PatchVoiceConfigData,
  PatchVoiceConfigRequest,
} from '@miniapp/shared';
import { requireTelegramAuth } from '../middleware/auth.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requestLogger } from '../lib/logger.js';
import { config } from '../platform/config.js';
import {
  AudioConflictError,
  ChatMessageAudioRepository,
  toMessageVoice,
} from '../infrastructure/repositories/ChatMessageAudioRepository.js';
import { ChatSessionRepository } from '../infrastructure/repositories/ChatSessionRepository.js';
import { ConversationHistoryRepository } from '../infrastructure/repositories/ConversationHistoryRepository.js';
import { MiniappUserSettingsRepository } from '../infrastructure/repositories/MiniappUserSettingsRepository.js';
import { MiniappWalletRepository } from '../infrastructure/repositories/MiniappWalletRepository.js';
import { ConversationRepositoryError } from '../infrastructure/repositories/conversation-errors.js';
import { runVoiceGeneration } from '../features/voice/generate.js';
import { getVoiceBillingConfig } from '../features/voice/voice-billing-config.js';
import { normalizeCustomText } from '../features/voice/voice-text.js';
import {
  DEFAULT_TTS_MODEL,
  DEFAULT_TTS_SPEED,
  PLAYBACK_RATES,
  VOICE_CATALOG,
} from '../features/voice/voice-catalog.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 送进改写模型的正文上限。回复本身受生成档位约束，正常远在这之下；
 * 超长的多半是异常内容，截断比让上游按 token 计费跑一趟划算。
 */
const MAX_SOURCE_CHARS = 4000;

export default async function voiceRoutes(app: FastifyInstance) {
  const sessions = new ChatSessionRepository();
  const history = new ConversationHistoryRepository();
  const settings = new MiniappUserSettingsRepository();
  const audio = new ChatMessageAudioRepository();
  const wallets = new MiniappWalletRepository();

  // ── 用户级语音偏好 ────────────────────────────────────────────────────────

  // @frontend-ready: true
  app.get('/api/v1/voice/config', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const dbUser = await getOrCreateDbUser(request.user);
    const billing = await getVoiceBillingConfig();
    return reply.send(
      ok<GetVoiceConfigData>({
        config: await settings.getVoiceConfig(dbUser.id),
        voices: [...VOICE_CATALOG],
        playback_rates: [...PLAYBACK_RATES],
        billing: billing.billing,
        limits: billing.limits,
        hints: billing.hints,
      })
    );
  });

  // @frontend-ready: true
  app.patch(
    '/api/v1/voice/config',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const body = (request.body ?? {}) as PatchVoiceConfigRequest;
      if (body.voice_id === undefined && body.playback_rate === undefined) {
        return reply.status(400).send(fail('BAD_REQUEST', '没有要修改的语音设置'));
      }
      if (body.voice_id !== undefined && typeof body.voice_id !== 'string') {
        return reply.status(400).send(fail('BAD_REQUEST', '音色格式不正确'));
      }
      if (body.playback_rate !== undefined && typeof body.playback_rate !== 'number') {
        return reply.status(400).send(fail('BAD_REQUEST', '播放速度格式不正确'));
      }

      const dbUser = await getOrCreateDbUser(request.user);
      const billing = await getVoiceBillingConfig();
      try {
        const updated = await settings.setVoiceConfig(dbUser.id, request.user, {
          ...(body.voice_id !== undefined ? { voiceId: body.voice_id } : {}),
          ...(body.playback_rate !== undefined ? { playbackRate: body.playback_rate } : {}),
        });
        return reply.send(
          ok<PatchVoiceConfigData>({
            config: updated,
            voices: [...VOICE_CATALOG],
            playback_rates: [...PLAYBACK_RATES],
            billing: billing.billing,
            limits: billing.limits,
            hints: billing.hints,
          })
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : '更新语音设置失败';
        if (message.startsWith('无效的')) {
          return reply.status(400).send(fail('BAD_REQUEST', message));
        }
        throw error;
      }
    }
  );

  // ── 会话语音 ──────────────────────────────────────────────────────────────

  /**
   * 一次取回整段对话的语音。进入会话时拉一次，生成期间前端会轮询它，
   * 所以按会话整取而不是按消息单取——轮询期间每条消息一个请求扛不住。
   */
  // @frontend-ready: true
  app.get(
    '/api/v1/conversations/:sessionId/voice',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const { sessionId } = request.params as { sessionId: string };
      if (!UUID_PATTERN.test(sessionId)) {
        return reply.status(400).send(fail('BAD_REQUEST', '会话 ID 无效'));
      }

      const dbUser = await getOrCreateDbUser(request.user);
      try {
        await sessions.requireSession(sessionId, dbUser.id);
      } catch (error) {
        if (error instanceof ConversationRepositoryError) {
          return reply.status(404).send(fail('NOT_FOUND', '这段对话不存在'));
        }
        throw error;
      }

      return reply.send(ok<GetSessionVoiceData>({ audio: await audio.listBySession(sessionId) }));
    }
  );

  /**
   * 受理一条角色回复的语音生成。
   *
   * messageId 是 chat_history.id，也就是前端 assistant 消息的 id。
   * 用户消息（<id>:user）和开场白（opening:<sessionId>）不是合法 UUID，
   * 在参数校验这一步就被挡掉，与产品口径一致。
   *
   * 带 custom_text 时是「自定义本次语音」：跳过写稿，念用户给的字。
   * 清洗与非空判定都放在这里而不是后台任务里——清完变成空串（用户只输了标点）
   * 要当场回 400，让用户改，而不是等三十秒换来一个失败的播放条。
   */
  // @frontend-ready: true
  app.post(
    '/api/v1/conversations/:sessionId/messages/:messageId/voice',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

      const log = requestLogger(request.log, 'voice');
      const { sessionId, messageId } = request.params as {
        sessionId: string;
        messageId: string;
      };
      if (!UUID_PATTERN.test(sessionId) || !UUID_PATTERN.test(messageId)) {
        return reply.status(400).send(fail('BAD_REQUEST', '这条内容不支持生成语音'));
      }
      // 写稿与合成是两个供应商两把 key，缺任何一把都走不完整条链路
      if (!config.voice.draft.apiKey || !config.voice.apiKey) {
        return reply.status(503).send(fail('VOICE_UNAVAILABLE', '语音功能暂不可用'));
      }

      const body = (request.body ?? {}) as CreateMessageVoiceRequest;
      if (body.custom_text !== undefined && typeof body.custom_text !== 'string') {
        return reply.status(400).send(fail('BAD_REQUEST', '自定义语音文字格式不正确'));
      }
      const rawCustom = body.custom_text?.trim() ?? '';
      if (rawCustom.length > MAX_CUSTOM_VOICE_CHARS) {
        return reply
          .status(400)
          .send(fail('BAD_REQUEST', `自定义语音文字不能超过 ${MAX_CUSTOM_VOICE_CHARS} 字`));
      }
      const customText = rawCustom ? normalizeCustomText(rawCustom) : '';
      if (rawCustom && !customText) {
        return reply.status(400).send(fail('BAD_REQUEST', '自定义语音文字里没有可朗读的内容'));
      }

      const dbUser = await getOrCreateDbUser(request.user);
      try {
        await sessions.requireSession(sessionId, dbUser.id);
      } catch (error) {
        if (error instanceof ConversationRepositoryError) {
          return reply.status(404).send(fail('NOT_FOUND', '这段对话不存在'));
        }
        throw error;
      }

      // 计费预检：开关开且余额 < 单次扣费额 → 402，不建 pending。
      // 复用对话链路的裸形状 InsufficientBalanceErrorResponse（标准 envelope 装不下两个金额），
      // 前端 apiClient 据此跳充值页并带 required。开关关时跳过预检（现网行为）。
      const billing = await getVoiceBillingConfig();
      if (billing.enabled) {
        const wallet = await wallets.getOrCreate(dbUser.id);
        const balance = wallet.total_credits ?? wallet.main_credits + wallet.bonus_credits;
        if (balance < billing.creditsPerGeneration) {
          const response: InsufficientBalanceErrorResponse = {
            error: {
              message: `Insufficient credits: have ${balance}, need ${billing.creditsPerGeneration}`,
              type: 'insufficient_balance',
              credits_required: billing.creditsPerGeneration,
              credits_available: balance,
            },
          };
          return reply.status(402).send(response);
        }
      }

      const turn = await history.findCurrentTurnById(sessionId, messageId);
      const sourceText = turn?.assistant_reply?.trim() ?? '';
      if (!turn || !sourceText) {
        return reply.status(404).send(fail('NOT_FOUND', '这条回复不存在或还没有内容'));
      }

      const voiceConfig = await settings.getVoiceConfig(dbUser.id);
      let pending;
      try {
        pending = await audio.createPending({
          messageId,
          sessionId,
          userId: dbUser.id,
          voiceId: voiceConfig.voice_id,
          ttsModel: DEFAULT_TTS_MODEL,
          ttsSpeed: DEFAULT_TTS_SPEED,
          sourceChars: customText ? customText.length : sourceText.length,
        });
      } catch (error) {
        if (error instanceof AudioConflictError) {
          return reply.status(409).send(fail('CONFLICT', '这条回复正在生成语音'));
        }
        throw error;
      }

      // 故意不 await：响应要立刻返回，生成在后台跑完自己写回记录
      void runVoiceGeneration({
        audioId: pending.id,
        messageId,
        userId: dbUser.id,
        sourceText: sourceText.slice(0, MAX_SOURCE_CHARS),
        customText: customText || null,
        voiceId: pending.voice_id,
        ttsModel: pending.tts_model,
        ttsSpeed: Number(pending.tts_speed),
        billingEnabled: billing.enabled,
        creditsPerGeneration: billing.creditsPerGeneration,
        log,
      });

      return reply.status(202).send(ok<CreateMessageVoiceData>({ audio: toMessageVoice(pending) }));
    }
  );
}
