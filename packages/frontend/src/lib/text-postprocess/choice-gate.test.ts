import { describe, expect, it } from 'vitest';
import { TEXT_POSTPROCESS_LIMITS, type ChatMessage } from '@miniapp/shared';

import {
  choiceButtonsDisabled,
  emptyChoiceLock,
  markChoiceAwaitingConfirmation,
  normalizeChoiceText,
  settleChoiceLock,
  tryAdoptChoice,
  type ChoiceGates,
  type ChoiceLockState,
} from './choice-gate';

const OPEN: ChoiceGates = { generating: false, serverBusy: false, sessionReady: true };

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'a1',
    session_id: 's1',
    turn_index: 1,
    role: 'assistant',
    revision: 0,
    content: 'See [Yes]',
    status: 'complete',
    error_code: null,
    finish_reason: 'stop',
    model_id: null,
    created_at: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

function adopt(
  state: ChoiceLockState,
  messages: ChatMessage[],
  target = messages.at(-1) ?? message(),
  text = '  Yes  ',
  gates: ChoiceGates = OPEN
) {
  return tryAdoptChoice(state, {
    message: target,
    messages,
    text,
    gates,
    baselineUpdatedAt: 10,
  });
}

describe('choice gate', () => {
  it('rejects blank and over-long payloads before locking', () => {
    expect(normalizeChoiceText('   ')).toBeNull();
    expect(normalizeChoiceText('x'.repeat(TEXT_POSTPROCESS_LIMITS.maxOptionUnits + 1))).toBeNull();
    const latest = message();
    const rejected = adopt(emptyChoiceLock(), [latest], latest, '   ');
    expect(rejected.text).toBeNull();
    expect(rejected.state).toEqual(emptyChoiceLock());
  });

  it('disables choices while streaming, for turn 0, and for older replies', () => {
    const opening = message({ id: 'open', turn_index: 0 });
    const older = message({ id: 'old', turn_index: 1 });
    const latest = message({ id: 'new', turn_index: 2 });
    const streaming = message({ id: 'live', turn_index: 3, status: 'streaming', content: '...' });
    const history = [opening, older, latest];
    expect(
      choiceButtonsDisabled({
        message: opening,
        messages: [opening],
        gates: OPEN,
        lock: emptyChoiceLock(),
      })
    ).toBe(true);
    expect(
      choiceButtonsDisabled({
        message: older,
        messages: history,
        gates: OPEN,
        lock: emptyChoiceLock(),
      })
    ).toBe(true);
    expect(
      choiceButtonsDisabled({
        message: latest,
        messages: history,
        gates: OPEN,
        lock: emptyChoiceLock(),
      })
    ).toBe(false);
    expect(
      choiceButtonsDisabled({
        message: latest,
        messages: [...history, streaming],
        gates: { ...OPEN, generating: true },
        lock: emptyChoiceLock(),
      })
    ).toBe(true);
    expect(
      choiceButtonsDisabled({
        message: message({ role: 'user', id: 'u' }),
        messages: [message({ role: 'user', id: 'u' })],
        gates: OPEN,
        lock: emptyChoiceLock(),
      })
    ).toBe(true);
  });

  it('locks synchronously so a second click cannot submit', () => {
    const latest = message();
    const first = adopt(emptyChoiceLock(), [latest]);
    const second = adopt(first.state, [latest]);
    expect(first.text).toBe('Yes');
    expect(second.text).toBeNull();
    expect(second.state).toBe(first.state);
    expect(
      choiceButtonsDisabled({ message: latest, messages: [latest], gates: OPEN, lock: first.state })
    ).toBe(true);
  });

  it('does not revive an old choice after revision change, refresh, or the next turn', () => {
    const original = message({ revision: 0 });
    const first = adopt(emptyChoiceLock(), [original]);
    const revised = message({ revision: 1 });
    expect(
      choiceButtonsDisabled({
        message: revised,
        messages: [revised],
        gates: OPEN,
        lock: first.state,
      })
    ).toBe(false);
    expect(
      choiceButtonsDisabled({
        message: original,
        messages: [original],
        gates: OPEN,
        lock: first.state,
      })
    ).toBe(true);

    const confirming = markChoiceAwaitingConfirmation(first.state);
    const stillArmed = settleChoiceLock(first.state, {
      messages: [original],
      refreshing: false,
      querySettled: true,
      dataUpdatedAt: 20,
    });
    expect(stillArmed).toBe(first.state);

    const waiting = settleChoiceLock(confirming, {
      messages: [original],
      refreshing: false,
      querySettled: true,
      dataUpdatedAt: 10,
    });
    expect(waiting).toBe(confirming);

    const user = message({ id: 'u2', role: 'user', turn_index: 2, content: 'Yes' });
    const consumed = settleChoiceLock(confirming, {
      messages: [original, user],
      refreshing: false,
      querySettled: true,
      dataUpdatedAt: 30,
    });
    expect(consumed.held).toBeNull();
    expect(consumed.consumed).toEqual([`a1:0`]);
    expect(
      choiceButtonsDisabled({
        message: original,
        messages: [original, user, message({ id: 'a2', turn_index: 2 })],
        gates: OPEN,
        lock: consumed,
      })
    ).toBe(true);
  });

  it('reopens only after a settled refresh shows the same tail', () => {
    const latest = message();
    const confirming = markChoiceAwaitingConfirmation(adopt(emptyChoiceLock(), [latest]).state);
    const refreshing = settleChoiceLock(confirming, {
      messages: [latest],
      refreshing: true,
      querySettled: true,
      dataUpdatedAt: 30,
    });
    expect(refreshing).toBe(confirming);
    const released = settleChoiceLock(confirming, {
      messages: [latest],
      refreshing: false,
      querySettled: true,
      dataUpdatedAt: 30,
    });
    expect(released.held).toBeNull();
    expect(released.consumed).toEqual([]);
    expect(
      choiceButtonsDisabled({ message: latest, messages: [latest], gates: OPEN, lock: released })
    ).toBe(false);
  });
});
