import type { FastifyInstance } from 'fastify';
import {
  fail,
  ok,
  type GetSupportConversationData,
  type GetSupportMessagesData,
  type SendSupportMessageData,
  type SendSupportMessageRequest,
  type SupportMessage,
  type SupportUnreadData,
} from '@miniapp/shared';
import { getDomainDb } from '../lib/supabase.js';
import { hasUnreadAgentReply } from '../lib/support-unread.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requireTelegramAuth } from '../middleware/auth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONVERSATION_COLUMNS = 'id,status,agent_unread_count,last_agent_message_at,user_last_read_at';

interface ConversationRow {
  id: string;
  status: 'open' | 'resolved';
  agent_unread_count: number;
  last_agent_message_at: string | null;
  user_last_read_at: string | null;
}

export default async function supportRoutes(app: FastifyInstance) {
  app.get(
    '/api/support/conversation',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const user = await getOrCreateDbUser(request.user);
      const conversation = await findConversation(user.id);
      if (!conversation) {
        return reply.send(ok<GetSupportConversationData>({ conversation: null }));
      }
      return reply.send(
        ok<GetSupportConversationData>({
          conversation: {
            id: conversation.id,
            status: conversation.status,
            messages: await listMessages(conversation.id),
          },
        })
      );
    }
  );

  // 「我的」页和底部导航的客服红点都读这里，判定完全在服务端，多端进出不会各自算出不同结果。
  app.get('/api/support/unread', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    const user = await getOrCreateDbUser(request.user);
    const conversation = await findConversation(user.id);
    return reply.send(
      ok<SupportUnreadData>({
        has_unread: hasUnreadAgentReply(
          conversation?.last_agent_message_at,
          conversation?.user_last_read_at
        ),
      })
    );
  });

  // 进入客服聊天页即视为读过；聊天页开着又来新回复时会再调一次，推进水位线。
  app.post('/api/support/read', { preHandler: [requireTelegramAuth] }, async (request, reply) => {
    if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
    const user = await getOrCreateDbUser(request.user);
    const conversation = await findConversation(user.id);
    if (!conversation) return reply.send(ok<SupportUnreadData>({ has_unread: false }));

    const now = new Date().toISOString();
    const { error } = await getDomainDb('cs_platform')
      .from('support_conversations')
      .update({ user_last_read_at: now, updated_at: now })
      .eq('id', conversation.id);
    if (error) throw new Error(`更新客服已读状态失败：${error.message}`);
    return reply.send(ok<SupportUnreadData>({ has_unread: false }));
  });

  app.get(
    '/api/support/messages',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const user = await getOrCreateDbUser(request.user);
      const conversation = await findConversation(user.id);
      if (!conversation) return reply.send(ok<GetSupportMessagesData>({ messages: [] }));
      const { after } = request.query as { after?: string };
      return reply.send(
        ok<GetSupportMessagesData>({
          messages: await listMessages(conversation.id, after),
        })
      );
    }
  );

  app.post(
    '/api/support/messages',
    { preHandler: [requireTelegramAuth] },
    async (request, reply) => {
      if (!request.user) return reply.status(401).send(fail('UNAUTHORIZED', 'Unauthorized'));
      const body = (request.body ?? {}) as Partial<SendSupportMessageRequest>;
      const text = body.body?.trim() ?? '';
      if (!text || text.length > 4000 || !body.client_msg_id || !UUID_RE.test(body.client_msg_id)) {
        return reply.status(400).send(fail('INVALID_MESSAGE', '消息内容或请求标识无效'));
      }

      const user = await getOrCreateDbUser(request.user);
      const conversation = await getOrCreateConversation(user.id);
      const db = getDomainDb('cs_platform');
      const now = new Date().toISOString();
      const { data, error } = await db
        .from('support_messages')
        .upsert(
          {
            conversation_id: conversation.id,
            sender: 'user',
            body: text,
            client_msg_id: body.client_msg_id,
            created_at: now,
          },
          { onConflict: 'conversation_id,client_msg_id', ignoreDuplicates: true }
        )
        .select('id,sender,body,client_msg_id,created_at')
        .maybeSingle();
      if (error) throw new Error(`发送客服消息失败：${error.message}`);

      const message =
        (data as SupportMessage | null) ??
        (await findMessageByClientId(conversation.id, body.client_msg_id));
      if (!message) throw new Error('发送客服消息后回读失败');

      const { error: updateError } = await db
        .from('support_conversations')
        .update({
          status: 'open',
          last_user_message_at: message.created_at,
          agent_unread_count: conversation.agent_unread_count + (data ? 1 : 0),
          updated_at: now,
        })
        .eq('id', conversation.id);
      if (updateError) throw new Error(`更新客服会话失败：${updateError.message}`);
      return reply.status(201).send(ok<SendSupportMessageData>({ message }));
    }
  );
}

async function findConversation(userId: string): Promise<ConversationRow | null> {
  const { data, error } = await getDomainDb('cs_platform')
    .from('support_conversations')
    .select(CONVERSATION_COLUMNS)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`读取客服会话失败：${error.message}`);
  return data as ConversationRow | null;
}

async function getOrCreateConversation(userId: string): Promise<ConversationRow> {
  const existing = await findConversation(userId);
  if (existing) return existing;
  const { data, error } = await getDomainDb('cs_platform')
    .from('support_conversations')
    .upsert({ user_id: userId }, { onConflict: 'user_id', ignoreDuplicates: true })
    .select(CONVERSATION_COLUMNS)
    .maybeSingle();
  if (error) throw new Error(`创建客服会话失败：${error.message}`);
  if (data) return data as ConversationRow;
  const afterRace = await findConversation(userId);
  if (!afterRace) throw new Error('创建客服会话后回读失败');
  return afterRace;
}

async function listMessages(conversationId: string, after?: string): Promise<SupportMessage[]> {
  let query = getDomainDb('cs_platform')
    .from('support_messages')
    .select('id,sender,body,client_msg_id,created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(200);
  if (after) query = query.gt('created_at', after);
  const { data, error } = await query;
  if (error) throw new Error(`读取客服消息失败：${error.message}`);
  return (data ?? []) as SupportMessage[];
}

async function findMessageByClientId(
  conversationId: string,
  clientMsgId: string
): Promise<SupportMessage | null> {
  const { data, error } = await getDomainDb('cs_platform')
    .from('support_messages')
    .select('id,sender,body,client_msg_id,created_at')
    .eq('conversation_id', conversationId)
    .eq('client_msg_id', clientMsgId)
    .maybeSingle();
  if (error) throw new Error(`回读客服消息失败：${error.message}`);
  return data as SupportMessage | null;
}
