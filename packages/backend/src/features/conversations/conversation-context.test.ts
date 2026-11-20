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
  displayOpening?: string | null
): ConversationHistoryRow {
  return {
    id: `row-${turnIndex}`,
    user_id: 'user',
    model: 'test/model',
    user_input: userInput,
    assistant_reply: assistantReply,
    ...(displayOpening !== undefined ? { display_opening_message: displayOpening } : {}),
    character_id: null,
    status: 'success',
    deduction_rate: null,
    created_at: '2026-08-13T00:00:00.000Z',
    llm_finish_reason: 'stop',
    llm_charge_id: null,
    session_id: 'session',
    turn_index: turnIndex,
    revision: 0,
  };
}

describe('assembleConversationContext', () => {
  it('未截断时 truncatedTurns=0，开场白取窗口首轮的展示投影', () => {
    const context = assembleConversationContext({
      windowStartTurn: 1,
      windowRows: [row(1, '你好', '新回复', OPENING)],
    });
    expect(context).toEqual({
      openingMessage: OPENING,
      truncatedTurns: 0,
      messages: [
        { role: 'user', content: '你好' },
        { role: 'assistant', content: '新回复' },
      ],
      turns: [{ turnIndex: 1, userInput: '你好', assistantReply: '新回复', status: 'success' }],
    });
  });

  it('截断后开场白仍取 turn 1 的投影，不取窗口内第一轮', () => {
    const context = assembleConversationContext({
      windowStartTurn: 27,
      windowRows: [row(27, '窗口内', '窗口回复', '不是开场白')],
      openingMessage: OPENING,
    });
    expect(context.openingMessage).toBe(OPENING);
    expect(context.truncatedTurns).toBe(26);
    expect(context.messages).toEqual([
      { role: 'user', content: '窗口内' },
      { role: 'assistant', content: '窗口回复' },
    ]);
  });

  it('没有投影时开场白为空，不从别处猜', () => {
    expect(
      assembleConversationContext({ windowStartTurn: 1, windowRows: [row(1, '问', '答')] })
        .openingMessage
    ).toBeNull();
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
