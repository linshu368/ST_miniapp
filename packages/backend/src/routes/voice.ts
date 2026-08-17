/**
 * backend / routes / voice.ts
 *
 * 聊天页角色语音：用户级音色偏好 + 按消息生成/读取语音。
 *
 * 生成不同步等结果：改写加合成最坏要几十秒，同步等会被各层代理掐断，
 * 手机端切后台也会断。所以 POST 只负责「受理」——落一行 pending 立刻返回，
 * 真正的活在进程内异步跑，前端轮询 GET 拿终态。
 *
 * 本期不扣费，但每次生成都留一行，用量按行统计（migration 080 头部）。
 */

import type { FastifyInstance } from 'fastify';
import { fail, ok } from '@miniapp/shared';
import type {
  CreateMessageVoiceData,
  GetSessionVoiceData,
  GetVoiceConfigData,
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
import { ConversationRepositoryError } from '../infrastructure/repositories/conversation-errors.js';
import { runVoiceGeneration } from '../features/voice/generate.js';
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

  // ── 用户级语音偏好 ────────────────────────────────────────────────────────

  // @frontend-ready: true
  app.get('/api/v1/voice/config', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));

    const dbUser = await getOrCreateDbUser(request.user);
    return reply.send(
      ok<GetVoiceConfigData>({
        config: await settings.getVoiceConfig(dbUser.id),
        voices: [...VOICE_CATALOG],
        playback_rates: [...PLAYBACK_RATES],
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
      if (!config.voice.apiKey) {
        return reply.status(503).send(fail('VOICE_UNAVAILABLE', '语音功能暂不可用'));
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
          sourceChars: sourceText.length,
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
        voiceId: pending.voice_id,
        ttsModel: pending.tts_model,
        ttsSpeed: Number(pending.tts_speed),
        log,
      });

      return reply.status(202).send(ok<CreateMessageVoiceData>({ audio: toMessageVoice(pending) }));
    }
  );
}
