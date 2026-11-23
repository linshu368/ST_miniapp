import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ChatMessageVoiceFooter, type MessageVoiceState } from './chat-message-voice';

import { isInstructionSlotEnabled } from './chat-generation-settings-state';

describe('isInstructionSlotEnabled', () => {
  it('keeps explicit server values and defaults a missing slot to enabled', () => {
    expect(isInstructionSlotEnabled(true)).toBe(true);
    expect(isInstructionSlotEnabled(false)).toBe(false);
    expect(isInstructionSlotEnabled(undefined)).toBe(true);
  });
});

describe('voice entry read readiness', () => {
  function voice(readState: MessageVoiceState['readState']): MessageVoiceState {
    return {
      readState,
      onLoad: vi.fn(),
      voice: undefined,
      playbackRate: 1,
      submitting: false,
      onGenerate: vi.fn(),
      customHref: null,
      freeTrialLimit: null,
      hints: { overLimit: '', draftFailed: '', ttsFailed: '' },
    };
  }
  function render(state: MessageVoiceState) {
    return renderToStaticMarkup(
      createElement(ChatMessageVoiceFooter, { charCount: 3, voice: state, regenerate: null })
    );
  }
  it.each([
    ['deferred', '加载语音'],
    ['loading', '语音加载中'],
    ['error', '重试加载语音'],
  ] as const)('shows %s as a read action instead of a generation action', (state, label) => {
    const html = render(voice(state));
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).not.toContain('aria-label="生成语音"');
  });
  it('offers generation only after records and config are confirmed', () => {
    expect(render(voice('ready'))).toContain('aria-label="生成语音"');
  });
  it('preserves an existing playable audio while config loading disables only regeneration', () => {
    const state = voice('error');
    state.voice = {
      message_id: 'm1',
      status: 'ready',
      audio_url: '/fixture-audio.mp3',
      duration_ms: 3000,
      spoken_text: 'fixture',
      voice_id: 'fixture',
      error_code: null,
      last_error_code: null,
      credits_charged: 0,
      billing_mode: 'legacy_free',
      free_trial_ordinal: null,
      price_credits: 0,
      price_label: '',
      created_at: '2026-11-23T00:00:00Z',
    };
    const html = render(state);
    expect(html).toContain('aria-label="播放"');
    expect(html).toContain('aria-label="重试加载语音"');
    expect(html).toMatch(/disabled="" aria-label="重新生成语音"/);
  });
});
