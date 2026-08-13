import { describe, expect, it } from 'vitest';
import {
  assembleConversationContext,
  type ConversationHistoryRow,
} from '../../infrastructure/repositories/ConversationHistoryRepository.js';

const OPENING = '【开场白】你终于来了。';

function row(
  turnIndex: number,
  userInput: string,
  assistantReply: string,
  history: unknown[] = []
): ConversationHistoryRow {
  return {
    id: `row-${turnIndex}`,
    user_id: 'user',
    model: 'test/model',
    user_input: userInput,
    assistant_reply: assistantReply,
    history,
    character_id: null,
    preset_id: null,
    status: 'success',
    upstream_status: 200,
    deduction_rate: null,
    created_at: '2026-08-13T00:00:00.000Z',
    llm_finish_reason: 'stop',
    llm_generation_id: null,
    llm_charge_id: null,
    session_id: 'session',
    turn_index: turnIndex,
    revision: 0,
  };
}

describe('assembleConversationContext', () => {
  it('未泄洪时 truncatedTurns=0，开场白取窗口首轮快照', () => {
    const context = assembleConversationContext({
      windowStartTurn: 1,
      windowRows: [
        row(1, '你好', '新回复', [
          { role: 'system', content: 'system' },
          { role: 'assistant', content: OPENING },
        ]),
      ],
    });
    expect(context).toEqual({
      openingMessage: OPENING,
      truncatedTurns: 0,
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '新回复' },
      ],
    });
  });

  it('泄洪后开场白仍取 turn 1 快照，不取窗口内第一轮', () => {
    const context = assembleConversationContext({
      windowStartTurn: 27,
      windowRows: [row(27, '窗口内', '窗口回复', [{ role: 'assistant', content: '不是开场白' }])],
      openingHistory: [{ role: 'assistant', content: OPENING }],
    });
    expect(context.openingMessage).toBe(OPENING);
    expect(context.truncatedTurns).toBe(26);
    expect(context.messages).toEqual([
      { role: 'user', content: '窗口内' },
      { role: 'assistant', content: '窗口回复' },
    ]);
  });

  it('空回复不进 messages，但仍占窗口轮次', () => {
    const context = assembleConversationContext({
      windowStartTurn: 1,
      windowRows: [row(1, '问', ''), row(2, '再问', '答')],
    });
    expect(context.messages).toEqual([
      { role: 'user', content: '问' },
      { role: 'user', content: '再问' },
      { role: 'assistant', content: '答' },
    ]);
  });
});
