// M1 验收（docs/ST_remove-MVP实施方案.md §5.8 的九条）。
//
// 这是打真库的集成测试：M1 不出 HTTP 接口，会话语义几乎全部由 migration 069 / 070 的
// 约束与 RPC 承担（唯一索引、会话行锁、最后一轮判定），mock 掉数据库等于什么都没验。
//
// 运行前提：
//   1. 069 / 070 已在目标库执行
//   2. packages/backend/.env 里 DATABASE_ENV=test 且 TEST_SUPABASE_* 齐备
// 两条前提由启动时的探活统一判定，缺任一条跳过并在 stderr 说明原因，
// 因此 CI（无库凭证）与本地断网时 `pnpm test` 都不会因此变红。
//
//   pnpm --filter @miniapp/backend test conversations.integration

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../platform/config.js';
import { getSupabaseClient } from '../../lib/supabase.js';
import { ChatSessionRepository, type ChatSessionRow } from './ChatSessionRepository.js';
import { ChatMessageRepository, type GenerationSnapshot } from './ChatMessageRepository.js';
import { ConversationRepositoryError } from './conversation-errors.js';
import { MiniappUserSettingsRepository } from './MiniappUserSettingsRepository.js';

/** 打真库的用例每条都要走十几个到 Supabase 的往返，vitest 默认的 5s 不够，与两个钩子取齐 */
const DB_TEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;

const hasTestDatabaseConfig = Boolean(
  config.supabase.url && config.supabase.serviceRoleKey && config.database.environment === 'test'
);

/**
 * 整个文件被 skip 时 vitest 没有任务可以挂 console 输出，走 console.warn 会被静默吞掉。
 * 「为什么跳过」正是这里要传出去的信息，所以直接写 stderr。
 */
function reportSkip(reason: string): void {
  process.stderr.write(`[M1 集成测试] 跳过：${reason}\n`);
}

/**
 * 凭证齐备不等于库可用——本地断网、库停机、069 还没执行都会让上面那个判断为真而实际跑不了。
 * 只判凭证的话这些情况会在 beforeAll 里炸成「创建测试用户失败：fetch failed」把整个 suite 染红，
 * 与文件头声明的「缺任一条自动跳过」不符。这里补一次探活，顺带确认 069 的表确实存在。
 */
async function probeTestDatabase(): Promise<boolean> {
  if (!hasTestDatabaseConfig) {
    reportSkip('未配置 DATABASE_ENV=test 或 TEST_SUPABASE_* 凭证');
    return false;
  }
  try {
    const { error } = await getSupabaseClient()
      .schema('miniapp')
      .from('chat_sessions')
      .select('id')
      .limit(1)
      .abortSignal(AbortSignal.timeout(PROBE_TIMEOUT_MS));
    if (error) {
      reportSkip(`目标库不可用或 069 未执行（${error.message}）`);
      return false;
    }
    return true;
  } catch (error) {
    reportSkip(`连接目标库失败（${(error as Error).message}）`);
    return false;
  }
}

const canRunAgainstDatabase = await probeTestDatabase();

const FIRST_MES = '【开场白】你终于来了。';
const SNAPSHOT: GenerationSnapshot = {
  modelId: 'test-model',
  modelOpenrouterId: 'test/model',
  presetId: null,
  genConfig: {
    selected_model_id: 'test-model',
    pref_word_count: '300-500',
    pref_show_options: true,
    pref_custom_instructions: null,
  },
};

describe.skipIf(!canRunAgainstDatabase)(
  'M1 会话数据模型与会话管理',
  { timeout: DB_TEST_TIMEOUT_MS },
  () => {
    let sessions: ChatSessionRepository;
    let messages: ChatMessageRepository;
    let settings: MiniappUserSettingsRepository;
    let db: ReturnType<ReturnType<typeof getSupabaseClient>['schema']>;

    let userId: string;
    let otherUserId: string;
    let characterId: string;

    /** 建会话 + 走完一轮完整问答，返回会话与该轮 turn_index */
    async function createSessionWithTurn(userInput: string, reply: string) {
      const { session } = await sessions.createSession(userId, characterId);

      const { turnIndex } = await messages.appendUserTurn(session.id, userInput);
      const assistant = await messages.startAssistantMessage({
        sessionId: session.id,
        turnIndex,
        snapshot: SNAPSHOT,
      });
      await messages.finalizeAssistantMessage({
        messageId: assistant.id,
        content: reply,
        status: 'complete',
        finishReason: 'stop',
      });

      return { session, turnIndex };
    }

    async function listAssistantRows(sessionId: string, turnIndex: number) {
      const { data, error } = await db
        .from('chat_messages')
        .select('id, revision, is_active, content, status')
        .eq('session_id', sessionId)
        .eq('turn_index', turnIndex)
        .eq('role', 'assistant')
        .order('revision', { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{ revision: number; is_active: boolean; content: string }>;
    }

    beforeAll(async () => {
      sessions = new ChatSessionRepository();
      messages = new ChatMessageRepository();
      settings = new MiniappUserSettingsRepository();
      db = getSupabaseClient().schema('miniapp');

      const suffix = Date.now().toString(36);
      const { data: users, error: userError } = await db
        .from('users')
        .insert([
          { tg_id: `m1-test-${suffix}-a`, st_handle: `m1_test_${suffix}_a` },
          { tg_id: `m1-test-${suffix}-b`, st_handle: `m1_test_${suffix}_b` },
        ])
        .select('id');
      if (userError) throw new Error(`创建测试用户失败：${userError.message}`);
      const insertedUsers = (users ?? []) as Array<{ id: string }>;
      if (insertedUsers.length !== 2) throw new Error('测试用户创建数量不符');
      userId = insertedUsers[0]!.id;
      otherUserId = insertedUsers[1]!.id;

      const { data: character, error: characterError } = await db
        .from('characters')
        .insert({
          name: `M1 测试角色 ${suffix}`,
          first_mes: FIRST_MES,
          system_prompt: '你是一个用于 M1 集成测试的角色。',
          // 测试卡不进大厅，且 062 的 characters_test_cards_disabled 要求它必须
          // enabled = false 且带 card_hash
          enabled: false,
          is_test: true,
          card_hash: `m1-test-${suffix}`,
        })
        .select('id')
        .single();
      if (characterError) throw new Error(`创建测试角色卡失败：${characterError.message}`);
      characterId = (character as { id: string }).id;
    }, 30_000);

    afterAll(async () => {
      if (!userId) return;
      await db.from('chat_history').delete().in('user_id', [userId, otherUserId]);
      // 硬删会话（软删只改 deleted_at），否则 characters 的 ON DELETE RESTRICT 会挡住清理
      await db.from('chat_sessions').delete().in('user_id', [userId, otherUserId]);
      await db.from('characters').delete().eq('id', characterId);
      await db.from('users').delete().in('id', [userId, otherUserId]);
    }, 30_000);

    // ① 建会话自动落开场白
    it('建会话时把开场白落成 turn 0 的 assistant 消息', async () => {
      const { session, messages: seeded } = await sessions.createSession(userId, characterId);

      expect(seeded).toHaveLength(1);
      expect(seeded[0]).toMatchObject({
        turn_index: 0,
        role: 'assistant',
        revision: 0,
        is_active: true,
        content: FIRST_MES,
        status: 'complete',
      });
      expect(session.message_count).toBe(1);
      expect(session.last_message_preview).toBe(FIRST_MES);
      expect(session.title).toBeNull();
    });

    // ② turn_index 递增 + 会话冗余字段同步
    it('追加一问一答后 turn_index 递增、会话冗余字段跟着刷新', async () => {
      const { session, turnIndex } = await createSessionWithTurn('第一句', '第一次回复');
      expect(turnIndex).toBe(1);

      const refreshed = (await sessions.getSession(session.id, userId)) as ChatSessionRow;
      expect(refreshed.message_count).toBe(3);
      expect(refreshed.last_message_preview).toBe('第一次回复');
      expect(refreshed.last_message_at).not.toBeNull();

      const second = await messages.appendUserTurn(session.id, '第二句');
      expect(second.turnIndex).toBe(2);
    });

    // ③ 重生成 3 次 → 4 个版本，恰好一条 active
    it('对最后一轮重生成三次后保留四个版本且只有一条生效', async () => {
      const { session, turnIndex } = await createSessionWithTurn('讲个故事', '版本 0');

      for (let round = 1; round <= 3; round += 1) {
        const started = await messages.startRegeneration({
          sessionId: session.id,
          snapshot: SNAPSHOT,
        });
        expect(started).toMatchObject({ turnIndex, revision: round, userContent: '讲个故事' });
        await messages.finalizeAssistantMessage({
          messageId: started.assistantMessageId,
          content: `版本 ${round}`,
          status: 'complete',
        });
      }

      const rows = await listAssistantRows(session.id, turnIndex);
      expect(rows.map((row) => row.revision)).toEqual([0, 1, 2, 3]);
      expect(rows.filter((row) => row.is_active)).toHaveLength(1);
      expect(rows.find((row) => row.is_active)?.content).toBe('版本 3');

      // 重生成不算新消息，冗余计数保持 user + assistant 两条加开场白
      const refreshed = (await sessions.getSession(session.id, userId)) as ChatSessionRow;
      expect(refreshed.message_count).toBe(3);
      expect(refreshed.last_message_preview).toBe('版本 3');
    });

    // ④ 非最后一轮不可重生成
    it('拒绝对非最后一轮的重生成', async () => {
      const { session, turnIndex } = await createSessionWithTurn('第一轮', '第一轮回复');
      const next = await messages.appendUserTurn(session.id, '第二轮');
      const assistant = await messages.startAssistantMessage({
        sessionId: session.id,
        turnIndex: next.turnIndex,
        snapshot: SNAPSHOT,
      });
      await messages.finalizeAssistantMessage({
        messageId: assistant.id,
        content: '第二轮回复',
        status: 'complete',
      });

      await expect(
        messages.startRegeneration({ sessionId: session.id, turnIndex, snapshot: SNAPSHOT })
      ).rejects.toMatchObject({ code: 'regenerate_not_allowed' });
    });

    // ⑤ 只有开场白的会话不可重生成（该轮无 user 消息）
    it('拒绝对只有开场白的会话发起重生成', async () => {
      const { session } = await sessions.createSession(userId, characterId);

      await expect(
        messages.startRegeneration({ sessionId: session.id, snapshot: SNAPSHOT })
      ).rejects.toMatchObject({ code: 'regenerate_not_allowed' });
    });

    // ⑥ 上下文顺序稳定：开场白在前，其后 user / assistant 严格交替
    it('上下文按开场白 + user/assistant 交替的顺序返回全量', async () => {
      const { session } = await createSessionWithTurn('你好', '你好呀');
      const second = await messages.appendUserTurn(session.id, '再聊聊');
      const assistant = await messages.startAssistantMessage({
        sessionId: session.id,
        turnIndex: second.turnIndex,
        snapshot: SNAPSHOT,
      });
      await messages.finalizeAssistantMessage({
        messageId: assistant.id,
        content: '好啊',
        status: 'complete',
      });

      const context = await messages.getContextMessages(session.id);
      expect(context).toEqual([
        { role: 'assistant', content: FIRST_MES },
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '你好呀' },
        { role: 'user', content: '再聊聊' },
        { role: 'assistant', content: '好啊' },
      ]);
    });

    // ⑦ 并发重生成同一轮：只允许一条生效版本
    it('并发重生成同一轮不会产生两条生效版本', async () => {
      const { session, turnIndex } = await createSessionWithTurn('并发', '原始回复');

      const results = await Promise.allSettled([
        messages.startRegeneration({ sessionId: session.id, snapshot: SNAPSHOT }),
        messages.startRegeneration({ sessionId: session.id, snapshot: SNAPSHOT }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

      const rows = await listAssistantRows(session.id, turnIndex);
      expect(rows.filter((row) => row.is_active)).toHaveLength(1);
    });

    // ⑧ 跨用户访问被 ownership 校验拒绝
    it('他人会话对当前用户不可见、不可改', async () => {
      const { session } = await sessions.createSession(userId, characterId);

      expect(await sessions.getSession(session.id, otherUserId)).toBeNull();
      await expect(sessions.rename(session.id, otherUserId, '抢占')).rejects.toBeInstanceOf(
        ConversationRepositoryError
      );
      await expect(sessions.softDelete(session.id, otherUserId)).rejects.toMatchObject({
        code: 'session_not_found',
      });

      const list = await sessions.listSessions(otherUserId, { characterId });
      expect(list.sessions).toHaveLength(0);
    });

    // ⑨ 软删后不出现在列表，chat_history 关联行仍可查
    it('软删会话后列表不再返回它，chat_history 关联行仍可查', async () => {
      const { session } = await createSessionWithTurn('留痕', '留痕回复');

      const { error: historyError } = await db.from('chat_history').insert({
        user_id: userId,
        model: 'test/model',
        user_input: '留痕',
        assistant_reply: '留痕回复',
        history: [{ role: 'user', content: '留痕' }],
        character_id: characterId,
        session_id: session.id,
      });
      expect(historyError).toBeNull();

      await sessions.softDelete(session.id, userId);

      const list = await sessions.listSessions(userId, { characterId });
      expect(list.sessions.map((row) => row.id)).not.toContain(session.id);
      expect(await sessions.getSession(session.id, userId)).toBeNull();

      const { data: history } = await db
        .from('chat_history')
        .select('id, session_id')
        .eq('session_id', session.id);
      expect(history).toHaveLength(1);
    });

    // 用户生成配置读取通道（§5.7 的 getGenerationConfig）
    it('没有设置行的用户也能读到与建表默认值一致的生成配置', async () => {
      const generationConfig = await settings.getGenerationConfig(userId);
      expect(generationConfig).toEqual({
        selected_model_id: null,
        pref_word_count: '300-500',
        pref_show_options: true,
        pref_custom_instructions: null,
      });
    });
  }
);
