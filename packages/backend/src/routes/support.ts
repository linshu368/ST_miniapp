import type { FastifyInstance } from 'fastify';
import {
  fail,
  ok,
  type GetSupportConversationData,
  type GetSupportMessagesData,
  type SendSupportMessageData,
  type SendSupportMessageRequest,
  type SupportMessage,
} from '@miniapp/shared';
import { getSupabaseClient } from '../lib/supabase.js';
import { getOrCreateDbUser } from '../lib/user.js';
import { requireTelegramAuth } from '../middleware/auth.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface ConversationRow {
  id: string;
  status: 'open' | 'resolved';
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
            ...conversation,
            messages: await listMessages(conversation.id),
          },
        })
      );
    }
  );

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
      const db = getSupabaseClient().schema('miniapp');
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
  const { data, error } = await getSupabaseClient()
    .schema('miniapp')
    .from('support_conversations')
    .select('id,status,agent_unread_count')
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw new Error(`读取客服会话失败：${error.message}`);
  return data as (ConversationRow & { agent_unread_count: number }) | null;
}

async function getOrCreateConversation(
  userId: string
): Promise<ConversationRow & { agent_unread_count: number }> {
  const existing = await findConversation(userId);
  if (existing) return existing as ConversationRow & { agent_unread_count: number };
  const { data, error } = await getSupabaseClient()
    .schema('miniapp')
    .from('support_conversations')
    .upsert({ user_id: userId }, { onConflict: 'user_id', ignoreDuplicates: true })
    .select('id,status,agent_unread_count')
    .maybeSingle();
  if (error) throw new Error(`创建客服会话失败：${error.message}`);
  if (data) return data as ConversationRow & { agent_unread_count: number };
  const afterRace = await findConversation(userId);
  if (!afterRace) throw new Error('创建客服会话后回读失败');
  return afterRace as ConversationRow & { agent_unread_count: number };
}

async function listMessages(conversationId: string, after?: string): Promise<SupportMessage[]> {
  let query = getSupabaseClient()
    .schema('miniapp')
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
  const { data, error } = await getSupabaseClient()
    .schema('miniapp')
    .from('support_messages')
    .select('id,sender,body,client_msg_id,created_at')
    .eq('conversation_id', conversationId)
    .eq('client_msg_id', clientMsgId)
    .maybeSingle();
  if (error) throw new Error(`回读客服消息失败：${error.message}`);
  return data as SupportMessage | null;
}
