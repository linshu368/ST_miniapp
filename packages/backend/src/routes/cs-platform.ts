import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as XLSX from 'xlsx';
import {
  ok,
  fail,
  type AdvanceCsSessionRequest,
  type CreateCsPersonaRequest,
  type CsMessageData,
  type CsPersonaDataResponse,
  type CsTelegramReachabilityData,
  type DeleteCsPersonaData,
  type GetCsAppChatData,
  type GetCsAuditLogsData,
  type GetCsMessagesData,
  type GetCsPersonaUsersData,
  type GetCsPersonasData,
  type GetCsSessionData,
  type RefreshCsPersonaData,
  type SendCsMessageData,
  type SendCsMessageRequest,
  type SkipCsSessionRequest,
  type SnoozeCsSessionRequest,
  type UpdateCsPersonaRequest,
  type GetCsSupportConversationsData,
  type GetCsSupportMessagesData,
  type SendCsSupportMessageRequest,
  type SendSupportMessageData,
  type SupportMessage,
  type CsSupportConversationSummary,
  type CsBroadcastAudience,
  type CsBroadcastData,
  type CsBroadcastPreviewData,
  type CsBroadcastPreviewRequest,
  type CsBroadcastRequest,
  type SetCsSpecialNoteData,
  type SetCsSpecialNoteRequest,
  MAX_CS_SPECIAL_NOTE_CHARS,
} from '@miniapp/shared';
import { config } from '../platform/config.js';
import { CsPlatformRepository } from '../infrastructure/repositories/CsPlatformRepository.js';
import { prisma } from '../lib/db.js';

const ADMIN_HEADER = 'x-cs-admin-token';
const OPERATOR_HEADER = 'x-cs-operator-id';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** 群发预览里回给前端的样本条数，只是让客服确认「发对人了」，不是全量名单 */
const BROADCAST_SAMPLE_SIZE = 5;
/** 顺序发送的间隔。Telegram 群发限速约 30 条/秒，留一倍余量 */
const BROADCAST_INTERVAL_MS = 60;

const BROADCAST_AUDIENCES: readonly CsBroadcastAudience[] = [
  'not_started',
  'first_round',
  'second_round',
  'all_waiting',
  'all',
];

interface CsRequest extends FastifyRequest {
  csOperatorId?: string;
}

interface TelegramSendResponse {
  ok: boolean;
  result?: {
    message_id?: number;
  };
  description?: string;
}

export default async function csPlatformRoutes(app: FastifyInstance) {
  const repository = new CsPlatformRepository();

  app.get('/api/cs/personas', { preHandler: [requireCsAdmin] }, async (request, reply) => {
    const personas = await repository.listPersonas();
    return reply.send(ok<GetCsPersonasData>({ personas }));
  });

  app.post('/api/cs/personas', { preHandler: [requireCsAdmin] }, async (request, reply) => {
    const body = request.body as Partial<CreateCsPersonaRequest>;
    const name = body.name?.trim();
    const sql = body.sql?.trim();
    const openingScript = body.opening_script?.trim();

    if (!name || !sql || !openingScript) {
      return reply
        .status(400)
        .send(fail('INVALID_PERSONA', '画像名称、SQL 规则和开场话术不能为空'));
    }

    const personaResult = await safeCsAction(reply, '创建画像簇失败', () =>
      repository.createPersona({
        name,
        description: body.description?.trim(),
        color: body.color,
        sql,
        openingScript,
        sop: body.sop,
        operatorId: getOperator(request),
      })
    );
    if (!personaResult.ok) return personaResult.reply;

    return reply.send(ok<CsPersonaDataResponse>({ persona: personaResult.data }));
  });

  app.patch('/api/cs/personas/:id', { preHandler: [requireCsAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdateCsPersonaRequest;
    const personaResult = await safeCsAction(reply, '更新画像簇失败', () =>
      repository.updatePersona(id, {
        name: body.name?.trim(),
        description: body.description?.trim(),
        color: body.color,
        sql: body.sql,
        openingScript: body.opening_script,
        sop: body.sop,
        status: body.status,
        operatorId: getOperator(request),
      })
    );
    if (!personaResult.ok) return personaResult.reply;

    return reply.send(ok<CsPersonaDataResponse>({ persona: personaResult.data }));
  });

  app.delete('/api/cs/personas/:id', { preHandler: [requireCsAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const persona = await repository.archivePersona(id, getOperator(request));
    return reply.send(ok<DeleteCsPersonaData>({ persona }));
  });

  app.post(
    '/api/cs/personas/:id/refresh',
    { preHandler: [requireCsAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const refreshResult = await safeCsAction(reply, '刷新画像簇失败', () =>
        repository.refreshPersona(id, getOperator(request))
      );
      if (!refreshResult.ok) return refreshResult.reply;

      const persona = await repository.getPersona(id);
      if (!persona) return reply.status(404).send(fail('PERSONA_NOT_FOUND', '画像簇不存在'));

      return reply.send(
        ok<RefreshCsPersonaData>({
          persona,
          run_id: refreshResult.data.run_id,
          active_count: refreshResult.data.active_count,
          entered_count: refreshResult.data.entered_count,
          chatted_left_count: refreshResult.data.chatted_left_count,
          refreshed_at: refreshResult.data.refreshed_at,
        })
      );
    }
  );

  app.get(
    '/api/cs/personas/:id/users',
    { preHandler: [requireCsAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const users = await repository.listUsers(id);
      return reply.send(ok<GetCsPersonaUsersData>(users));
    }
  );

  app.get(
    '/api/cs/personas/:id/users/:userId/telegram-reachability',
    { preHandler: [requireCsAdmin] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const users = await repository.listUsers(id);
      const target = [...users.active, ...users.chatted_left].find(
        (user) => user.user_id === userId
      );
      if (!target) return reply.status(404).send(fail('USER_NOT_FOUND', '画像簇中没有这个用户'));
      const result = await checkTelegramReachability(target.telegram_user_id);
      return reply.send(ok<CsTelegramReachabilityData>(result));
    }
  );

  app.get(
    '/api/cs/personas/:id/users/:userId/session',
    { preHandler: [requireCsAdmin] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const session = await repository.getSession(id, userId);
      return reply.send(ok<GetCsSessionData>({ session }));
    }
  );

  app.get(
    '/api/cs/personas/:id/users/:userId/messages',
    { preHandler: [requireCsAdmin] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const messages = await repository.listMessages(id, userId);
      return reply.send(ok<GetCsMessagesData>({ messages }));
    }
  );

  app.get(
    '/api/cs/personas/:id/users/:userId/app-chat',
    { preHandler: [requireCsAdmin] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const persona = await repository.getPersona(id);
      if (!persona) return reply.status(404).send(fail('PERSONA_NOT_FOUND', '画像簇不存在'));
      const turns = await repository.listAppChat(userId);
      return reply.send(ok<GetCsAppChatData>({ turns }));
    }
  );

  app.post(
    '/api/cs/personas/:id/users/:userId/messages',
    { preHandler: [requireCsAdmin] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const body = request.body as Partial<SendCsMessageRequest>;
      const content = body.content?.trim() ?? '';
      if (!content) return reply.status(400).send(fail('EMPTY_MESSAGE', '消息内容不能为空'));

      const users = await repository.listUsers(id);
      const target = [...users.active, ...users.chatted_left].find(
        (user) => user.user_id === userId
      );
      if (!target) return reply.status(404).send(fail('USER_NOT_FOUND', '画像簇中没有这个用户'));

      const pending = await repository.createPendingAgentMessage({
        personaId: id,
        userId,
        telegramUserId: target.telegram_user_id,
        content,
        sopStage: body.sop_stage,
        questionKey: body.question_key,
        idempotencyKey: body.idempotency_key,
        operatorId: getOperator(request),
      });

      const sent = await sendTelegramMessage(target.telegram_user_id, content);
      const message = await repository.markAgentMessage({
        messageId: pending.id,
        personaId: id,
        userId,
        status: sent.ok ? 'sent' : 'failed',
        telegramMessageId: sent.telegramMessageId,
        failedReason: sent.error,
        sopStage: body.sop_stage,
        questionKey: body.question_key,
        operatorId: getOperator(request),
      });
      const session = await repository.getSession(id, userId);

      if (!sent.ok) {
        return reply
          .status(502)
          .send(fail('TELEGRAM_UNREACHABLE', sent.error ?? 'Telegram 消息发送失败'));
      }
      return reply.send(ok<SendCsMessageData>({ message, session }));
    }
  );

  app.post(
    '/api/cs/personas/:id/users/:userId/messages/:messageId/retry',
    { preHandler: [requireCsAdmin] },
    async (request, reply) => {
      const { id, userId, messageId } = request.params as {
        id: string;
        userId: string;
        messageId: string;
      };
      const messages = await repository.listMessages(id, userId);
      const original = messages.find((message) => message.id === messageId);
      if (!original) return reply.status(404).send(fail('MESSAGE_NOT_FOUND', '消息不存在'));

      const sent = await sendTelegramMessage(original.telegram_user_id, original.content);
      const message = await repository.markAgentMessage({
        messageId,
        personaId: id,
        userId,
        status: sent.ok ? 'sent' : 'failed',
        telegramMessageId: sent.telegramMessageId,
        failedReason: sent.error,
        sopStage: original.sop_stage ?? undefined,
        questionKey: original.question_key ?? undefined,
        operatorId: getOperator(request),
      });
      const session = await repository.getSession(id, userId);
      if (!sent.ok) {
        return reply
          .status(502)
          .send(fail('TELEGRAM_UNREACHABLE', sent.error ?? 'Telegram 消息发送失败'));
      }
      return reply.send(ok<SendCsMessageData>({ message, session }));
    }
  );

  app.post(
    '/api/cs/personas/:id/users/:userId/session/advance',
    { preHandler: [requireCsAdmin] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const body = request.body as Partial<AdvanceCsSessionRequest>;
      const session = await repository.advanceSession(id, userId, {
        nextStage: body.next_stage,
        nextQuestionKey: body.next_question_key,
        status: body.status,
        operatorId: getOperator(request),
      });
      return reply.send(ok<GetCsSessionData>({ session }));
    }
  );

  app.post(
    '/api/cs/personas/:id/users/:userId/session/snooze',
    { preHandler: [requireCsAdmin] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const body = request.body as Partial<SnoozeCsSessionRequest>;
      const session = await repository.snoozeSession(id, userId, {
        nextTouchAt: body.next_touch_at,
        operatorId: getOperator(request),
      });
      return reply.send(ok<GetCsSessionData>({ session }));
    }
  );

  app.post(
    '/api/cs/personas/:id/users/:userId/session/skip',
    { preHandler: [requireCsAdmin] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const body = request.body as Partial<SkipCsSessionRequest>;
      const session = await repository.skipSession(id, userId, {
        reason: body.reason,
        operatorId: getOperator(request),
      });
      return reply.send(ok<GetCsSessionData>({ session }));
    }
  );

  app.put(
    '/api/cs/personas/:id/users/:userId/special-note',
    { preHandler: [requireCsAdmin] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const body = request.body as Partial<SetCsSpecialNoteRequest>;
      const raw = typeof body.note === 'string' ? body.note.trim() : '';
      if (raw.length > MAX_CS_SPECIAL_NOTE_CHARS) {
        return reply
          .status(400)
          .send(fail('NOTE_TOO_LONG', `备注最多 ${MAX_CS_SPECIAL_NOTE_CHARS} 字`));
      }

      const saved = await repository.setSpecialNote(id, userId, {
        note: raw.length > 0 ? raw : null,
        operatorId: getOperator(request),
      });
      return reply.send(
        ok<SetCsSpecialNoteData>({
          user_id: userId,
          persona_id: id,
          special_note: saved.note,
          special_note_updated_at: saved.updatedAt,
        })
      );
    }
  );

  app.post(
    '/api/cs/personas/:id/broadcast/preview',
    { preHandler: [requireCsAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as Partial<CsBroadcastPreviewRequest>;
      const audience = parseAudience(body.audience);
      if (!audience) return reply.status(400).send(fail('BAD_AUDIENCE', '群发范围不合法'));

      const persona = await repository.getPersona(id);
      if (!persona) return reply.status(404).send(fail('PERSONA_NOT_FOUND', '画像簇不存在'));

      const targets = await repository.listBroadcastTargets(id, audience);
      return reply.send(
        ok<CsBroadcastPreviewData>({
          audience,
          total: targets.length,
          sample: targets.slice(0, BROADCAST_SAMPLE_SIZE).map((target) => ({
            user_id: target.userId,
            display_name: target.displayName,
            waiting_state: target.waitingState,
          })),
        })
      );
    }
  );

  app.post(
    '/api/cs/personas/:id/broadcast',
    { preHandler: [requireCsAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as Partial<CsBroadcastRequest>;
      const audience = parseAudience(body.audience);
      if (!audience) return reply.status(400).send(fail('BAD_AUDIENCE', '群发范围不合法'));
      const content = body.content?.trim() ?? '';
      if (!content) return reply.status(400).send(fail('EMPTY_MESSAGE', '消息内容不能为空'));

      const persona = await repository.getPersona(id);
      if (!persona) return reply.status(404).send(fail('PERSONA_NOT_FOUND', '画像簇不存在'));

      const targets = await repository.listBroadcastTargets(id, audience);
      if (targets.length === 0) {
        return reply.status(400).send(fail('NO_BROADCAST_TARGET', '该范围下没有可发送的用户'));
      }

      const operatorId = getOperator(request);
      await repository.log(operatorId, 'persona.broadcast', id, null, {
        audience,
        total: targets.length,
        contentPreview: content.slice(0, 120),
      });

      // 提交即返回：几百人要按 Telegram 限速一条条发，同步等完必然打到网关超时。
      // 逐条结果写进 outreach_messages，客服在回访记录里能看到成功/失败。
      void runBroadcast({ personaId: id, targets, content, operatorId }).catch((error) => {
        app.log.error({ err: error, personaId: id, audience }, 'cs broadcast failed');
      });

      return reply.status(202).send(ok<CsBroadcastData>({ audience, accepted: targets.length }));
    }
  );

  /**
   * 顺序发送 + 固定间隔。Telegram 对同一个 bot 的群发限速在 30 条/秒左右，
   * 超了会返回 429 并要求等待，所以这里宁可慢一点也不并发。
   * 单个用户失败（拉黑、没启动 bot）只记账不中断，否则一个人挡住整簇。
   */
  async function runBroadcast(input: {
    personaId: string;
    targets: Array<{ userId: string; telegramUserId: string; displayName: string }>;
    content: string;
    operatorId: string;
  }): Promise<void> {
    for (const target of input.targets) {
      try {
        const pending = await repository.createPendingAgentMessage({
          personaId: input.personaId,
          userId: target.userId,
          telegramUserId: target.telegramUserId,
          content: input.content,
          operatorId: input.operatorId,
        });
        const sent = await sendTelegramMessage(target.telegramUserId, input.content);
        await repository.markAgentMessage({
          messageId: pending.id,
          personaId: input.personaId,
          userId: target.userId,
          status: sent.ok ? 'sent' : 'failed',
          telegramMessageId: sent.telegramMessageId,
          failedReason: sent.error,
          operatorId: input.operatorId,
        });
      } catch (error) {
        app.log.error(
          { err: error, personaId: input.personaId, userId: target.userId },
          'cs broadcast target failed'
        );
      }
      await sleep(BROADCAST_INTERVAL_MS);
    }
  }

  app.get(
    '/api/cs/personas/:id/export',
    { preHandler: [requireCsAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [persona, users] = await Promise.all([
        repository.getPersona(id),
        repository.listUsers(id),
      ]);
      if (!persona) return reply.status(404).send(fail('PERSONA_NOT_FOUND', '画像簇不存在'));

      const allUsers = [...users.active, ...users.chatted_left];
      const profileRows = allUsers.map((user) => ({
        用户ID: user.user_id,
        TelegramID: user.telegram_user_id,
        用户名: user.display_name,
        簇内状态: user.membership_status === 'active' ? '当前在簇' : '已聊·已移出',
        注册天数: user.register_days,
        累计充值: user.total_paid_amount,
        付费次数: user.paid_count,
        对话轮次: user.total_round,
        最后活跃: user.last_active_label,
        回访状态: user.session_status,
      }));

      const messageRows = (
        await Promise.all(
          allUsers.map(async (user) => {
            const messages = await repository.listMessages(id, user.user_id);
            return messages.map((message) => ({
              用户ID: user.user_id,
              用户名: user.display_name,
              簇内状态: user.membership_status === 'active' ? '当前在簇' : '已聊·已移出',
              SOP阶段: message.sop_stage ?? '',
              问题Key: message.question_key ?? '',
              发送方: message.direction === 'agent' ? '客服' : '用户',
              原始内容: message.content,
              发送状态: message.send_status,
              时间: message.sent_at ?? message.received_at ?? message.created_at,
            }));
          })
        )
      ).flat();

      const workbook = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(profileRows), '用户背景');
      XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(messageRows), '对话明细');
      const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
      const filename = encodeURIComponent(`${persona.name}_回访数据.xlsx`);

      await repository.log(getOperator(request), 'export.xlsx', id, null, {
        users: profileRows.length,
        messages: messageRows.length,
      });

      return reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
        .send(buffer);
    }
  );

  app.post('/api/cs/telegram/webhook', async (request, reply) => {
    const secret = request.headers['x-cs-webhook-secret'];
    if (!config.csTelegramWebhookSecret || secret !== config.csTelegramWebhookSecret) {
      return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    }

    const body = request.body as {
      message?: {
        message_id?: number;
        text?: string;
        from?: { id?: number };
        chat?: { id?: number };
      };
    };
    const telegramUserId = body.message?.from?.id ?? body.message?.chat?.id;
    const content = body.message?.text?.trim();
    if (!telegramUserId || !content) return reply.send(ok({ ignored: true }));

    const message = await repository.receiveTelegramMessage({
      telegramUserId: String(telegramUserId),
      content,
      telegramMessageId: body.message?.message_id ? String(body.message.message_id) : undefined,
    });

    return reply.send(ok<{ message: CsMessageData | null }>({ message }));
  });

  app.get('/api/cs/audit-logs', { preHandler: [requireCsAdmin] }, async (_request, reply) => {
    const logs = await repository.listAuditLogs();
    return reply.send(ok<GetCsAuditLogsData>({ logs }));
  });

  app.get(
    '/api/cs/support/conversations',
    { preHandler: [requireCsAdmin] },
    async (_request, reply) => {
      const conversations = await prisma.$queryRaw<CsSupportConversationSummary[]>`
        SELECT c.id, c.user_id, u.tg_id AS telegram_user_id,
               COALESCE(s.display_name, s.tg_username, s.tg_first_name) AS display_name,
               c.status, c.agent_unread_count, c.last_user_message_at,
               c.last_agent_message_at,
               (SELECT m.body FROM miniapp.support_messages m
                WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message
        FROM miniapp.support_conversations c
        JOIN miniapp.users u ON u.id = c.user_id
        LEFT JOIN miniapp.miniapp_user_settings s ON s.user_id = c.user_id
        ORDER BY (c.status = 'open') DESC,
                 GREATEST(c.last_user_message_at, c.last_agent_message_at) DESC NULLS LAST
        LIMIT 200
      `;
      return reply.send(ok<GetCsSupportConversationsData>({ conversations }));
    }
  );

  app.get(
    '/api/cs/support/conversations/:id/messages',
    { preHandler: [requireCsAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      if (!UUID_RE.test(id)) {
        return reply.status(400).send(fail('INVALID_CONVERSATION_ID', '会话标识无效'));
      }
      const rows = await prisma.$queryRaw<CsSupportConversationSummary[]>`
        SELECT c.id, c.user_id, u.tg_id AS telegram_user_id,
               COALESCE(s.display_name, s.tg_username, s.tg_first_name) AS display_name,
               c.status, c.agent_unread_count, c.last_user_message_at,
               c.last_agent_message_at,
               (SELECT m.body FROM miniapp.support_messages m
                WHERE m.conversation_id = c.id
                ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message
        FROM miniapp.support_conversations c
        JOIN miniapp.users u ON u.id = c.user_id
        LEFT JOIN miniapp.miniapp_user_settings s ON s.user_id = c.user_id
        WHERE c.id = ${id}::uuid
      `;
      const conversation = rows[0];
      if (!conversation) return reply.status(404).send(fail('NOT_FOUND', '客服会话不存在'));
      const messages = await prisma.$queryRaw<SupportMessage[]>`
        SELECT id, sender, body, client_msg_id, created_at
        FROM miniapp.support_messages
        WHERE conversation_id = ${id}::uuid
        ORDER BY created_at, id
        LIMIT 500
      `;
      await prisma.$executeRaw`
        UPDATE miniapp.support_conversations
        SET agent_unread_count = 0, updated_at = now()
        WHERE id = ${id}::uuid
      `;
      return reply.send(ok<GetCsSupportMessagesData>({ conversation, messages }));
    }
  );

  app.post(
    '/api/cs/support/conversations/:id/messages',
    { preHandler: [requireCsAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = (request.body ?? {}) as Partial<SendCsSupportMessageRequest>;
      const text = body.body?.trim() ?? '';
      if (!UUID_RE.test(id) || !text || text.length > 4000) {
        return reply.status(400).send(fail('INVALID_MESSAGE', '会话或消息内容无效'));
      }
      const rows = await prisma.$queryRaw<Array<{ message: SupportMessage }>>`
        WITH target AS (
          SELECT id FROM miniapp.support_conversations
          WHERE id = ${id}::uuid FOR UPDATE
        ), inserted AS (
          INSERT INTO miniapp.support_messages (conversation_id, sender, body)
          SELECT id, 'agent', ${text} FROM target
          RETURNING id, sender, body, client_msg_id, created_at
        ), updated AS (
          UPDATE miniapp.support_conversations c
          SET status = 'open', last_agent_message_at = now(), updated_at = now()
          FROM target WHERE c.id = target.id
        )
        SELECT row_to_json(inserted)::jsonb AS message
        FROM inserted
      `;
      const result = rows[0];
      if (!result) return reply.status(404).send(fail('NOT_FOUND', '客服会话不存在'));
      // 回复不再写消息中心：用户在消息中心点不进会话，通知要落在「联系客服」入口的红点上，
      // 而红点由 last_agent_message_at 与 user_last_read_at 的先后推导，这里无需额外写入。
      return reply.status(201).send(ok<SendSupportMessageData>({ message: result.message }));
    }
  );
}

async function requireCsAdmin(request: CsRequest, reply: FastifyReply) {
  const headerToken = request.headers[ADMIN_HEADER];
  const token = Array.isArray(headerToken) ? headerToken[0] : headerToken;
  const isDevBypass = config.nodeEnv !== 'production' && process.env.DEV_AUTH_BYPASS === '1';

  if (!config.csAdminToken && isDevBypass) {
    request.csOperatorId = readOperator(request);
    return;
  }

  if (!config.csAdminToken || token !== config.csAdminToken) {
    return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
  }

  request.csOperatorId = readOperator(request);
}

function getOperator(request: FastifyRequest): string {
  return (request as CsRequest).csOperatorId ?? readOperator(request);
}

function readOperator(request: FastifyRequest): string {
  const value = request.headers[OPERATOR_HEADER];
  const operator = Array.isArray(value) ? value[0] : value;
  return operator?.trim() || 'cs-operator';
}

async function safeCsAction<T>(
  reply: FastifyReply,
  fallbackMessage: string,
  action: () => Promise<T>
): Promise<{ ok: true; data: T } | { ok: false; reply: FastifyReply }> {
  try {
    return { ok: true, data: await action() };
  } catch (error) {
    const message = error instanceof Error ? error.message : fallbackMessage;
    const status = resolveCsErrorStatus(message);
    return {
      ok: false,
      reply: reply.status(status).send(fail(resolveCsErrorCode(status), message)),
    };
  }
}

function resolveCsErrorStatus(message: string): number {
  if (message.includes('不存在')) return 404;
  if (message.includes('duplicate key') || message.includes('unique constraint')) return 409;
  if (
    message.includes('persona sql') ||
    message.includes('SQL') ||
    message.includes('validation')
  ) {
    return 400;
  }
  return 500;
}

function resolveCsErrorCode(status: number): string {
  if (status === 400) return 'INVALID_PERSONA_SQL';
  if (status === 404) return 'PERSONA_NOT_FOUND';
  if (status === 409) return 'PERSONA_CONFLICT';
  return 'CS_PLATFORM_ERROR';
}

function parseAudience(value: unknown): CsBroadcastAudience | null {
  return BROADCAST_AUDIENCES.find((audience) => audience === value) ?? null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendTelegramMessage(
  telegramUserId: string,
  text: string
): Promise<{ ok: boolean; telegramMessageId?: string; error?: string }> {
  if (!config.csTelegramBotToken) {
    return { ok: false, error: 'CS_TELEGRAM_BOT_TOKEN is not configured' };
  }

  const response = await fetch(
    `https://api.telegram.org/bot${config.csTelegramBotToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramUserId,
        text,
      }),
    }
  );
  const payload = (await response.json().catch(() => null)) as TelegramSendResponse | null;

  if (!response.ok || !payload?.ok) {
    return {
      ok: false,
      error: normalizeTelegramSendError(
        payload?.description ?? `Telegram API error: ${response.status}`
      ),
    };
  }

  return {
    ok: true,
    telegramMessageId: payload.result?.message_id ? String(payload.result.message_id) : undefined,
  };
}

async function checkTelegramReachability(
  telegramUserId: string
): Promise<CsTelegramReachabilityData> {
  if (!config.csTelegramBotToken) {
    return { reachable: false, reason: '当前环境未配置 Telegram Bot' };
  }
  const response = await fetch(
    `https://api.telegram.org/bot${config.csTelegramBotToken}/getChat?chat_id=${encodeURIComponent(telegramUserId)}`
  );
  if (response.ok) return { reachable: true, reason: null };
  const payload = (await response.json().catch(() => null)) as TelegramSendResponse | null;
  return {
    reachable: false,
    reason: normalizeTelegramSendError(
      payload?.description ?? `Telegram API error: ${response.status}`
    ),
  };
}

function normalizeTelegramSendError(description: string): string {
  const normalized = description.toLowerCase();
  if (
    normalized.includes('chat not found') ||
    normalized.includes('bot was blocked') ||
    normalized.includes('user is deactivated')
  ) {
    return '用户未启动或已屏蔽当前环境的 Telegram Bot，暂时无法主动发送消息';
  }
  return description;
}
