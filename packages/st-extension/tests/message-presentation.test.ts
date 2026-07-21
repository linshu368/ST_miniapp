import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { splitBoldSegments } from '../src/patches/markdown-bold-fallback.js';
import { resolveReasoningUiState } from '../src/patches/reasoning-stream-ui.js';
import { resolveInsufficientBalanceEvent } from '../src/patches/billing-error-bridge.js';

describe('splitBoldSegments', () => {
  it('formats standard and spaced bold markers', () => {
    assert.deepEqual(splitBoldSegments('普通 **加粗** 与 ** 带空格 **'), [
      { text: '普通 ', bold: false },
      { text: '加粗', bold: true },
      { text: ' 与 ', bold: false },
      { text: '带空格', bold: true },
    ]);
  });

  it('leaves incomplete and multiline markers untouched', () => {
    assert.deepEqual(splitBoldSegments('未完成 **内容'), [{ text: '未完成 **内容', bold: false }]);
    assert.deepEqual(splitBoldSegments('**跨行\n内容**'), [
      { text: '**跨行\n内容**', bold: false },
    ]);
  });
});

describe('resolveReasoningUiState', () => {
  it('tracks streaming and completed reasoning', () => {
    assert.equal(resolveReasoningUiState('thinking', false), 'thinking');
    assert.equal(resolveReasoningUiState('done', true), 'completed');
    assert.equal(resolveReasoningUiState('hidden', true), 'completed');
  });

  it('does not expose empty reasoning blocks', () => {
    assert.equal(resolveReasoningUiState('done', false), 'idle');
    assert.equal(resolveReasoningUiState(undefined, false), 'idle');
  });
});

describe('resolveInsufficientBalanceEvent', () => {
  it('recognizes direct and ST-wrapped insufficient balance responses', () => {
    assert.deepEqual(
      resolveInsufficientBalanceEvent(
        {
          error: {
            type: 'insufficient_balance',
            credits_required: 20,
            credits_available: 0,
          },
        },
        false
      ),
      { creditsRequired: 20, creditsAvailable: 0 }
    );
    assert.deepEqual(
      resolveInsufficientBalanceEvent({ error: { message: 'MiniApp Insufficient Credits' } }, true),
      { creditsRequired: 0, creditsAvailable: 0 }
    );
    assert.equal(
      resolveInsufficientBalanceEvent({ error: { message: 'Unrelated error' } }, true),
      null
    );
  });
});
