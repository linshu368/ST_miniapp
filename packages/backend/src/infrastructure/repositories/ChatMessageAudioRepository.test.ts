import { describe, expect, it } from 'vitest';

import { resolveMessageVoice, type ChatMessageAudioRow } from './ChatMessageAudioRepository.js';

/**
 * resolveMessageVoice 的关键不变量（需求 Q3：失败不让位）：
 *   - 首次生成失败 → status=failed，无 audio_url，无 last_error_code
 *   - 有上一版可播 + 本次重生成失败 → status=ready + 旧 audio_url + last_error_code
 *   - 未过期 pending（即使 inactive）→ status=pending
 *   - 卡死 pending 视为 failed；与旧 ready 共存时计入 last_error_code=voice_generation_stalled
 */

const NOW = Date.now();
const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

function row(overrides: Partial<ChatMessageAudioRow>): ChatMessageAudioRow {
  return {
    id: 'r1',
    message_id: 'm1',
    session_id: 's1',
    user_id: 'u1',
    revision: 0,
    is_active: true,
    status: 'pending',
    voice_id: 'v1',
    tts_model: 'speech-02-hd',
    tts_speed: 1,
    source_chars: 0,
    spoken_chars: 0,
    spoken_text: null,
    storage_path: null,
    audio_url: null,
    duration_ms: null,
    latency_ms: null,
    error_code: null,
    credits_charged: 0,
    debit_ledger_id: null,
    charged_at: null,
    created_at: iso(1000),
    updated_at: iso(1000),
    ...overrides,
  };
}

describe('resolveMessageVoice — 首次生成', () => {
  it('未过期 pending → status=pending，无 audio_url', () => {
    const voice = resolveMessageVoice([row({ status: 'pending', is_active: true })]);
    expect(voice).toMatchObject({ status: 'pending', audio_url: null, last_error_code: null });
  });

  it('成功 → status=ready + audio_url，无 last_error_code', () => {
    const voice = resolveMessageVoice([
      row({
        status: 'ready',
        is_active: true,
        audio_url: 'https://storage/old.mp3',
        duration_ms: 1000,
        spoken_text: '你好',
      }),
    ]);
    expect(voice).toMatchObject({
      status: 'ready',
      audio_url: 'https://storage/old.mp3',
      last_error_code: null,
    });
  });

  it('首次失败 → status=failed + error_code，无 audio_url，无 last_error_code', () => {
    const voice = resolveMessageVoice([
      row({ status: 'failed', is_active: true, error_code: 'voice_tts_timeout' }),
    ]);
    expect(voice).toMatchObject({
      status: 'failed',
      audio_url: null,
      error_code: 'voice_tts_timeout',
      last_error_code: null,
    });
  });

  it('卡死 pending 且无旧 ready → 视为 failed + voice_generation_stalled', () => {
    const stale = iso(10 * 60 * 60 * 1000); // 10h ago，远超 PENDING_STALE_MS
    const voice = resolveMessageVoice([
      row({ status: 'pending', is_active: true, created_at: stale, updated_at: stale }),
    ]);
    expect(voice).toMatchObject({
      status: 'failed',
      error_code: 'voice_generation_stalled',
      audio_url: null,
      last_error_code: null,
    });
  });
});

describe('resolveMessageVoice — 重新生成失败保留上一版可播（Q3）', () => {
  it('旧 ready 仍 active + 本次重生成超限失败 → ready + 旧 audio_url + last_error_code=voice_text_too_long', () => {
    const voice = resolveMessageVoice([
      row({
        id: 'ready1',
        revision: 0,
        status: 'ready',
        is_active: true,
        audio_url: 'https://storage/old.mp3',
        duration_ms: 1000,
        spoken_text: '旧台词',
      }),
      row({
        id: 'failed1',
        revision: 1,
        status: 'failed',
        is_active: false,
        error_code: 'voice_text_too_long',
      }),
    ]);
    expect(voice).toMatchObject({
      status: 'ready',
      audio_url: 'https://storage/old.mp3',
      spoken_text: '旧台词',
      error_code: null,
      last_error_code: 'voice_text_too_long',
    });
  });

  it('旧 ready + 本次 TTS 失败 → last_error_code=voice_tts_timeout，仍可播', () => {
    const voice = resolveMessageVoice([
      row({
        id: 'ready1',
        revision: 0,
        status: 'ready',
        is_active: true,
        audio_url: 'https://storage/old.mp3',
      }),
      row({
        id: 'failed1',
        revision: 1,
        status: 'failed',
        is_active: false,
        error_code: 'voice_tts_timeout',
      }),
    ]);
    expect(voice).toMatchObject({
      status: 'ready',
      audio_url: 'https://storage/old.mp3',
      last_error_code: 'voice_tts_timeout',
    });
  });

  it('旧 ready + 卡死 pending（重生成中途进程重启）→ last_error_code=voice_generation_stalled', () => {
    const stale = iso(10 * 60 * 60 * 1000);
    const voice = resolveMessageVoice([
      row({
        id: 'ready1',
        revision: 0,
        status: 'ready',
        is_active: true,
        audio_url: 'https://storage/old.mp3',
      }),
      row({
        id: 'pending1',
        revision: 1,
        status: 'pending',
        is_active: false,
        created_at: stale,
        updated_at: stale,
      }),
    ]);
    expect(voice).toMatchObject({
      status: 'ready',
      audio_url: 'https://storage/old.mp3',
      last_error_code: 'voice_generation_stalled',
    });
  });

  it('未过期 pending（旧 ready 仍 active）→ status=pending，隐藏播放条', () => {
    const voice = resolveMessageVoice([
      row({
        id: 'ready1',
        revision: 0,
        status: 'ready',
        is_active: true,
        audio_url: 'https://storage/old.mp3',
      }),
      row({
        id: 'pending1',
        revision: 1,
        status: 'pending',
        is_active: false,
      }),
    ]);
    expect(voice).toMatchObject({ status: 'pending', audio_url: null, last_error_code: null });
  });

  it('多次重生成失败 → 取最新一次失败码作为 last_error_code', () => {
    const voice = resolveMessageVoice([
      row({
        id: 'ready1',
        revision: 0,
        status: 'ready',
        is_active: true,
        audio_url: 'https://storage/old.mp3',
      }),
      row({
        id: 'failed1',
        revision: 1,
        status: 'failed',
        is_active: false,
        error_code: 'voice_tts_timeout',
      }),
      row({
        id: 'failed2',
        revision: 2,
        status: 'failed',
        is_active: false,
        error_code: 'voice_text_too_long',
      }),
    ]);
    expect(voice).toMatchObject({
      status: 'ready',
      last_error_code: 'voice_text_too_long',
    });
  });

  it('旧 ready 之前的失败尝试不计入 last_error_code（只看比当前 ready 更新的）', () => {
    const voice = resolveMessageVoice([
      row({
        id: 'failed0',
        revision: 0,
        status: 'failed',
        is_active: false,
        error_code: 'voice_tts_timeout',
      }),
      row({
        id: 'ready1',
        revision: 1,
        status: 'ready',
        is_active: true,
        audio_url: 'https://storage/new.mp3',
      }),
    ]);
    expect(voice).toMatchObject({
      status: 'ready',
      audio_url: 'https://storage/new.mp3',
      last_error_code: null,
    });
  });
});

describe('resolveMessageVoice — 边界', () => {
  it('空数组 → null', () => {
    expect(resolveMessageVoice([])).toBeNull();
  });

  it('没有 active 行时取最大 revision 兜底', () => {
    const voice = resolveMessageVoice([
      row({
        id: 'failed0',
        revision: 0,
        status: 'failed',
        is_active: false,
        error_code: 'voice_tts_timeout',
      }),
      row({
        id: 'failed1',
        revision: 1,
        status: 'failed',
        is_active: false,
        error_code: 'voice_text_too_long',
      }),
    ]);
    expect(voice).toMatchObject({ status: 'failed', error_code: 'voice_text_too_long' });
  });
});
