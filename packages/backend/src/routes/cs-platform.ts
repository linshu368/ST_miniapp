import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as XLSX from 'xlsx';
import {
  ok,
  fail,
  type AdvanceCsSessionRequest,
  type CreateCsPersonaRequest,
  type CsMessageData,
  type CsPersonaDataResponse,
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
} from '@miniapp/shared';
import { config } from '../platform/config.js';
import { CsPlatformRepository } from '../infrastructure/repositories/CsPlatformRepository.js';

const ADMIN_HEADER = 'x-cs-admin-token';
const OPERATOR_HEADER = 'x-cs-operator-id';

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
    if (!body.name?.trim() || !body.sql?.trim() || !body.opening_script?.trim()) {
      return reply
        .status(400)
        .send(fail('INVALID_PERSONA', '画像名称、SQL 规则和开场话术不能为空'));
    }

    const persona = await repository.createPersona({
      name: body.name.trim(),
      description: body.description?.trim(),
      color: body.color,
      sql: body.sql,
      openingScript: body.opening_script,
      sop: body.sop,
      operatorId: getOperator(request),
    });

    return reply.send(ok<CsPersonaDataResponse>({ persona }));
  });

  app.patch('/api/cs/personas/:id', { preHandler: [requireCsAdmin] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as UpdateCsPersonaRequest;
    const persona = await repository.updatePersona(id, {
      name: body.name?.trim(),
      description: body.description?.trim(),
      color: body.color,
      sql: body.sql,
      openingScript: body.opening_script,
      sop: body.sop,
      status: body.status,
      operatorId: getOperator(request),
    });

    return reply.send(ok<CsPersonaDataResponse>({ persona }));
  });

  app.post(
    '/api/cs/personas/:id/refresh',
    { preHandler: [requireCsAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const result = await repository.refreshPersona(id, getOperator(request));
      const persona = await repository.getPersona(id);
      if (!persona) return reply.status(404).send(fail('PERSONA_NOT_FOUND', '画像簇不存在'));

      return reply.send(
        ok<RefreshCsPersonaData>({
          persona,
          run_id: result.run_id,
          active_count: result.active_count,
          entered_count: result.entered_count,
          chatted_left_count: result.chatted_left_count,
          refreshed_at: result.refreshed_at,
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

      return reply.status(sent.ok ? 200 : 502).send(ok<SendCsMessageData>({ message, session }));
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
      return reply.status(sent.ok ? 200 : 502).send(ok<SendCsMessageData>({ message, session }));
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
    if (config.csTelegramWebhookSecret && secret !== config.csTelegramWebhookSecret) {
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

async function sendTelegramMessage(
  telegramUserId: string,
  text: string
): Promise<{ ok: boolean; telegramMessageId?: string; error?: string }> {
  if (!config.telegramBotToken) {
    return { ok: false, error: 'TELEGRAM_BOT_TOKEN is not configured' };
  }

  const response = await fetch(
    `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`,
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
      error: payload?.description ?? `Telegram API error: ${response.status}`,
    };
  }

  return {
    ok: true,
    telegramMessageId: payload.result?.message_id ? String(payload.result.message_id) : undefined,
  };
}
