// chat_sessions + chat_history 会话模型的真库集成测试。
// 运行前提：072 已在 DATABASE_ENV=test 指向的库执行；无凭证或不可达时自动跳过。

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../platform/config.js';
import { getDomainDb } from '../../lib/supabase.js';
import { ChatSessionRepository, type ChatSessionRow } from './ChatSessionRepository.js';
import {
  ConversationHistoryRepository,
  type ConversationHistoryRow,
} from './ConversationHistoryRepository.js';
import { ConversationRepositoryError } from './conversation-errors.js';
import { MiniappUserSettingsRepository } from './MiniappUserSettingsRepository.js';
import {
  fetchPlatformInstructions,
  toPublicWordCountTiersFromEngine,
} from '../../features/engine/platform-instructions.js';

const DB_TEST_TIMEOUT_MS = 30_000;
const PROBE_TIMEOUT_MS = 10_000;
const FIRST_MES = '【开场白】你终于来了。';
const MODEL = 'test/model';

function reportSkip(reason: string): void {
  process.stderr.write(`[会话集成测试] 跳过：${reason}\n`);
}

async function probeTestDatabase(): Promise<boolean> {
  if (
    !config.supabase.url ||
    !config.supabase.serviceRoleKey ||
    config.database.environment !== 'test'
  ) {
    reportSkip('未配置 DATABASE_ENV=test 或 TEST_SUPABASE_* 凭证');
    return false;
  }
  try {
    const { error } = await getDomainDb('experience')
      .from('chat_history')
      .select('id, turn_index, revision')
      .limit(1)
      .abortSignal(AbortSignal.timeout(PROBE_TIMEOUT_MS));
    if (error) {
      reportSkip(`目标库不可用或 072 未执行（${error.message}）`);
      return false;
    }
    const { error: windowError } = await getDomainDb('experience')
      .from('chat_sessions')
      .select('id, context_window_start_turn')
      .limit(1)
      .abortSignal(AbortSignal.timeout(PROBE_TIMEOUT_MS));
    if (windowError) {
      reportSkip(`目标库不可用或 077 未执行（${windowError.message}）`);
      return false;
    }
    return true;
  } catch (error) {
    reportSkip(`连接目标库失败（${(error as Error).message}）`);
    return false;
  }
}

const canRunAgainstDatabase = await probeTestDatabase();

describe.skipIf(!canRunAgainstDatabase)(
  'chat_sessions + chat_history 会话模型',
  { timeout: DB_TEST_TIMEOUT_MS },
  () => {
    let sessions: ChatSessionRepository;
    let history: ConversationHistoryRepository;
    let settings: MiniappUserSettingsRepository;
    // 会话与逐轮日志在 experience，用户与角色卡在 app_core（migration 099）
    let experienceDb: ReturnType<typeof getDomainDb>;
    let appCoreDb: ReturnType<typeof getDomainDb>;
    let userId: string;
    let otherUserId: string;
    let characterId: string;
    let characterName: string;

    async function createCompletedTurn(
      sessionId: string,
      userInput: string,
      reply: string,
      window?: { maxContextTurns: number; retainContextTurns: number }
    ) {
      const started = await history.startTurn({
        sessionId,
        userContent: userInput,
        model: MODEL,
        ...window,
      });
      await history.setPromptHistory(started.historyId, [
        { role: 'system', content: 'system' },
        { role: 'assistant', content: FIRST_MES },
        { role: 'user', content: userInput },
      ]);
      await history.finalizeTurn({
        historyId: started.historyId,
        content: reply,
        status: 'success',
        finishReason: 'stop',
      });
      return started;
    }

    async function listTurnRows(sessionId: string, turnIndex: number) {
      const { data, error } = await experienceDb
        .from('chat_history')
        .select('*')
        .eq('session_id', sessionId)
        .eq('turn_index', turnIndex)
        .order('revision', { ascending: true });
      if (error) throw new Error(error.message);
      return (data ?? []) as ConversationHistoryRow[];
    }

    beforeAll(async () => {
      sessions = new ChatSessionRepository();
      history = new ConversationHistoryRepository();
      settings = new MiniappUserSettingsRepository();
      experienceDb = getDomainDb('experience');
      appCoreDb = getDomainDb('app_core');

      const suffix = Date.now().toString(36);
      const { data: users, error: userError } = await appCoreDb
        .from('users')
        .insert([
          { tg_id: `history-test-${suffix}-a`, st_handle: `history_test_${suffix}_a` },
          { tg_id: `history-test-${suffix}-b`, st_handle: `history_test_${suffix}_b` },
        ])
        .select('id');
      if (userError) throw new Error(`创建测试用户失败：${userError.message}`);
      const insertedUsers = (users ?? []) as Array<{ id: string }>;
      userId = insertedUsers[0]!.id;
      otherUserId = insertedUsers[1]!.id;

      characterName = `会话模型测试角色 ${suffix}`;
      const { data: character, error: characterError } = await appCoreDb
        .from('characters')
        .insert({
          name: characterName,
          first_mes: FIRST_MES,
          system_prompt: '测试 system prompt',
          enabled: false,
          is_test: true,
          card_hash: `history-test-${suffix}`,
        })
        .select('id')
        .single();
      if (characterError) throw new Error(`创建测试角色卡失败：${characterError.message}`);
      characterId = (character as { id: string }).id;
    }, DB_TEST_TIMEOUT_MS);

    afterAll(async () => {
      if (!userId) return;
      await experienceDb.from('chat_history').delete().in('user_id', [userId, otherUserId]);
      await experienceDb.from('chat_sessions').delete().in('user_id', [userId, otherUserId]);
      await appCoreDb.from('characters').delete().eq('id', characterId);
      await appCoreDb.from('users').delete().in('id', [userId, otherUserId]);
    }, DB_TEST_TIMEOUT_MS);

    it('建会话只返回虚拟开场白，不写 chat_history', async () => {
      const { session, messages } = await sessions.createSession(userId, characterId);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        id: `opening:${session.id}`,
        turn_index: 0,
        role: 'assistant',
        content: FIRST_MES,
      });
      expect(session.message_count).toBe(0);
      expect(session.title).toBe(characterName);

      const { count, error } = await experienceDb
        .from('chat_history')
        .select('id', { count: 'exact', head: true })
        .eq('session_id', session.id);
      expect(error).toBeNull();
      expect(count).toBe(0);
    });

    it('已有空会话时复用它，不再插新行', async () => {
      const first = await sessions.createSession(userId, characterId);
      const second = await sessions.createSession(userId, characterId);
      expect(second.session.id).toBe(first.session.id);

      await createCompletedTurn(first.session.id, '开口', '回应');
      const third = await sessions.createSession(userId, characterId);
      expect(third.session.id).not.toBe(first.session.id);
    });

    it('列表不返回一句话都没发的会话', async () => {
      const { session } = await sessions.createSession(userId, characterId);
      const { sessions: visible } = await sessions.listSessions(userId, { characterId });
      expect(visible.map((row) => row.id)).not.toContain(session.id);
    });

    it('新消息分配递增 turn_index，并刷新会话摘要', async () => {
      const { session } = await sessions.createSession(userId, characterId);
      const first = await createCompletedTurn(session.id, '第一句', '第一次回复');
      const second = await createCompletedTurn(session.id, '第二句', '第二次回复');
      expect([first.turnIndex, second.turnIndex]).toEqual([1, 2]);

      const refreshed = (await sessions.getSession(session.id, userId)) as ChatSessionRow;
      expect(refreshed.message_count).toBe(4);
      expect(refreshed.last_message_preview).toBe('第二次回复');
    });

    it('重生成保留全部 revision，最大 revision 是当前版本', async () => {
      const { session } = await sessions.createSession(userId, characterId);
      const original = await createCompletedTurn(session.id, '讲个故事', '版本 0');

      for (let revision = 1; revision <= 3; revision += 1) {
        const started = await history.startRegeneration({ sessionId: session.id, model: MODEL });
        expect(started).toMatchObject({
          turnIndex: original.turnIndex,
          revision,
          userContent: '讲个故事',
        });
        await history.setPromptHistory(started.historyId, [
          { role: 'assistant', content: FIRST_MES },
          { role: 'user', content: '讲个故事' },
        ]);
        await history.finalizeTurn({
          historyId: started.historyId,
          content: `版本 ${revision}`,
          status: 'success',
        });
      }

      const rows = await listTurnRows(session.id, original.turnIndex);
      expect(rows.map((row) => row.revision)).toEqual([0, 1, 2, 3]);
      expect(rows.at(-1)?.assistant_reply).toBe('版本 3');

      const page = await history.listMessages(session.id, FIRST_MES);
      expect(page.messages.filter((message) => message.turn_index === 1)).toHaveLength(2);
      expect(page.messages.find((message) => message.role === 'assistant')?.content).toBe(
        FIRST_MES
      );
      expect(page.messages.at(-1)?.content).toBe('版本 3');
    });

    it('拒绝重生成非最后一轮，也拒绝空会话重生成', async () => {
      const { session } = await sessions.createSession(userId, characterId);
      await expect(
        history.startRegeneration({ sessionId: session.id, model: MODEL })
      ).rejects.toMatchObject({ code: 'regenerate_not_allowed' });

      const first = await createCompletedTurn(session.id, '第一轮', '第一轮回复');
      await createCompletedTurn(session.id, '第二轮', '第二轮回复');
      await expect(
        history.startRegeneration({
          sessionId: session.id,
          turnIndex: first.turnIndex,
          model: MODEL,
        })
      ).rejects.toMatchObject({ code: 'regenerate_not_allowed' });
    });

    it('上下文取每轮最大 revision，并从首轮 prompt 恢复开场白', async () => {
      const { session } = await sessions.createSession(userId, characterId);
      await createCompletedTurn(session.id, '你好', '旧回复');
      const regenerated = await history.startRegeneration({ sessionId: session.id, model: MODEL });
      await history.setPromptHistory(regenerated.historyId, [
        { role: 'system', content: 'system' },
        { role: 'assistant', content: FIRST_MES },
        { role: 'user', content: '你好' },
      ]);
      await history.finalizeTurn({
        historyId: regenerated.historyId,
        content: '新回复',
        status: 'success',
      });
      const next = await history.startTurn({
        sessionId: session.id,
        userContent: '继续',
        model: MODEL,
      });

      const context = await history.getContextBeforeTurn(session.id, next.turnIndex);
      expect(context).toEqual({
        openingMessage: FIRST_MES,
        truncatedTurns: 0,
        messages: [
          { role: 'user', content: '你好' },
          { role: 'assistant', content: '新回复' },
        ],
      });
      await history.finalizeTurn({
        historyId: next.historyId,
        content: '',
        status: 'upstream_error',
      });
    });

    it('并发重生成通过 session 行锁只放行一个 streaming revision', async () => {
      const { session } = await sessions.createSession(userId, characterId);
      await createCompletedTurn(session.id, '并发', '原始回复');
      const results = await Promise.allSettled([
        history.startRegeneration({ sessionId: session.id, model: MODEL }),
        history.startRegeneration({ sessionId: session.id, model: MODEL }),
      ]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const fulfilled = results.find(
        (
          result
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<typeof history.startRegeneration>>
        > => result.status === 'fulfilled'
      );
      if (fulfilled) {
        await history.finalizeTurn({
          historyId: fulfilled.value.historyId,
          content: '并发新版本',
          status: 'success',
        });
      }
    });

    it('超过高水位后入模窗口收到低水位，开场白仍在，全量历史仍可翻', async () => {
      const { session } = await sessions.createSession(userId, characterId);
      const window = { maxContextTurns: 3, retainContextTurns: 2 };
      for (let turn = 1; turn <= 4; turn += 1) {
        await createCompletedTurn(session.id, `用户${turn}`, `回复${turn}`, window);
      }

      const next = await history.startTurn({
        sessionId: session.id,
        userContent: '第五句',
        model: MODEL,
        ...window,
      });
      expect(next.turnIndex).toBe(5);
      expect(next.contextWindowStartTurn).toBe(3);

      const context = await history.getContextBeforeTurn(session.id, next.turnIndex);
      expect(context.truncatedTurns).toBe(2);
      expect(context.openingMessage).toBe(FIRST_MES);
      expect(context.messages).toEqual([
        { role: 'user', content: '用户3' },
        { role: 'assistant', content: '回复3' },
        { role: 'user', content: '用户4' },
        { role: 'assistant', content: '回复4' },
      ]);

      const page = await history.listMessages(session.id, FIRST_MES);
      expect(page.messages.map((message) => message.content)).toContain('用户1');
      expect(page.messages[0]?.content).toBe(FIRST_MES);

      await history.finalizeTurn({
        historyId: next.historyId,
        content: '第五句回复',
        status: 'success',
      });
    });

    it('A=B 时退化为滑动窗口；重生成不把本轮旧回复带进 prompt', async () => {
      const { session } = await sessions.createSession(userId, characterId);
      const window = { maxContextTurns: 3, retainContextTurns: 3 };
      for (let turn = 1; turn <= 4; turn += 1) {
        await createCompletedTurn(session.id, `滑${turn}`, `滑回${turn}`, window);
      }

      const fifth = await history.startTurn({
        sessionId: session.id,
        userContent: '滑5',
        model: MODEL,
        ...window,
      });
      expect(fifth.contextWindowStartTurn).toBe(2);
      await history.finalizeTurn({
        historyId: fifth.historyId,
        content: '滑回5',
        status: 'success',
      });

      const regenerated = await history.startRegeneration({
        sessionId: session.id,
        model: MODEL,
        ...window,
      });
      expect(regenerated.turnIndex).toBe(5);
      expect(regenerated.contextWindowStartTurn).toBe(2);

      const context = await history.getContextBeforeTurn(session.id, regenerated.turnIndex);
      expect(context.truncatedTurns).toBe(1);
      expect(context.openingMessage).toBe(FIRST_MES);
      expect(context.messages.map((message) => message.content)).toEqual([
        '滑2',
        '滑回2',
        '滑3',
        '滑回3',
        '滑4',
        '滑回4',
      ]);
      expect(context.messages.map((message) => message.content)).not.toContain('滑回5');

      await history.finalizeTurn({
        historyId: regenerated.historyId,
        content: '新版本',
        status: 'success',
      });
    });

    it('建会话 title 默认为角色名，清空重命名恢复为角色名', async () => {
      const { session } = await sessions.createSession(userId, characterId);
      expect(session.title).toBe(characterName);

      const renamed = await sessions.updateSession(session.id, userId, { title: '自定义标题' });
      expect(renamed.title).toBe('自定义标题');

      const reset = await sessions.updateSession(session.id, userId, { title: null });
      expect(reset.title).toBe(characterName);

      const blank = await sessions.updateSession(session.id, userId, { title: '   ' });
      expect(blank.title).toBe(characterName);
    });

    it('ownership 和软删除语义保持不变，历史不会随软删除丢失', async () => {
      const { session } = await sessions.createSession(userId, characterId);
      await createCompletedTurn(session.id, '留痕', '留痕回复');

      expect(await sessions.getSession(session.id, otherUserId)).toBeNull();
      await expect(
        sessions.updateSession(session.id, otherUserId, { title: '抢占' })
      ).rejects.toBeInstanceOf(ConversationRepositoryError);

      await sessions.softDelete(session.id, userId);
      expect(await sessions.getSession(session.id, userId)).toBeNull();
      const rows = await listTurnRows(session.id, 1);
      expect(rows).toHaveLength(1);
    });

    it('用户生成配置读取通道保持不变，未选过档位时跟随运营台默认档', async () => {
      // 086 起新建的设置行 pref_word_count 为 NULL，生效档位取自 runtime_config 当前的
      // default_tier_id，不能在这里钉死某个 id——运营台随时会改档位表。
      const expectedDefault = toPublicWordCountTiersFromEngine(
        (await fetchPlatformInstructions()).instructions.wordCountTiers
      ).default_tier_id;

      await expect(settings.getGenerationConfig(userId)).resolves.toEqual({
        selected_model_id: null,
        pref_word_count: expectedDefault,
        pref_show_options: true,
        pref_custom_instructions: null,
      });
    });
  }
);
