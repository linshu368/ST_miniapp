import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { splitBoldSegments } from '../src/patches/markdown-bold-fallback.js';
import { resolveReasoningUiState } from '../src/patches/reasoning-stream-ui.js';
import {
  resolveMiniappAppearance,
  shouldExpandComposer,
} from '../src/patches/mobile-chat-theme.js';
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

describe('resolveMiniappAppearance', () => {
  it('keeps light explicit and defaults invalid values to dark', () => {
    assert.equal(resolveMiniappAppearance('dark'), 'dark');
    assert.equal(resolveMiniappAppearance('light'), 'light');
    assert.equal(resolveMiniappAppearance(null), 'dark');
    assert.equal(resolveMiniappAppearance('system'), 'dark');
  });
});

describe('shouldExpandComposer', () => {
  it('keeps short messages compact and expands long or multiline input', () => {
    assert.equal(shouldExpandComposer('你好', 48, false), false);
    assert.equal(shouldExpandComposer('第一行\n第二行', 48, false), true);
    assert.equal(shouldExpandComposer('很长的输入'.repeat(5), 48, false), true);
    assert.equal(shouldExpandComposer('仍然有较多文字内容不能反复抖动', 48, true), true);
    assert.equal(shouldExpandComposer('视觉上已经换行', 56, false), true);
    assert.equal(shouldExpandComposer('已清空', 48, true), false);
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
