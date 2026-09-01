import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * generate.ts 的关键不变量：终检 >300 时不调 TTS、不扣费，markFailed(voice_text_too_long)。
 *
 * 用 customText 走「跳过写稿」分支，直接喂 301 字给终检闸，避免依赖写稿上游的 mock。
 * synthesizeSpeech / chargeVoiceUsage / storeMessageVoice 全部 mock，断言它们没被碰到。
 */

const markFailed = vi.fn(async () => undefined);
const markReady = vi.fn(async () => undefined);
const saveDraft = vi.fn(async () => undefined);

vi.mock('../../infrastructure/repositories/ChatMessageAudioRepository.js', () => ({
  ChatMessageAudioRepository: class {
    markFailed = markFailed;
    markReady = markReady;
    saveDraft = saveDraft;
  },
}));

const settleVoiceGeneration = vi.fn(async () => ({
  wallet: { user_id: 'u1', main_credits: 0, bonus_credits: 0, total_credits: 0 },
  chargeStatus: 'charged',
  alreadyCharged: false,
  charged: true,
}));

vi.mock('../generation/index.js', () => ({
  settleVoiceGeneration: (...args: unknown[]) =>
    settleVoiceGeneration(...(args as Parameters<typeof settleVoiceGeneration>)),
}));

const synthesizeSpeech = vi.fn(async () => ({
  audio: new Uint8Array([1, 2, 3]),
  durationMs: 1000,
}));

vi.mock('./minimax.js', () => ({
  synthesizeSpeech: (...args: unknown[]) =>
    synthesizeSpeech(...(args as Parameters<typeof synthesizeSpeech>)),
}));

const storeMessageVoice = vi.fn(async () => ({
  path: 'voice/u1/m1.mp3',
  url: 'https://storage.example/voice/u1/m1.mp3',
}));

vi.mock('../../lib/chat-voice-storage.js', () => ({
  storeMessageVoice: (...args: unknown[]) =>
    storeMessageVoice(...(args as Parameters<typeof storeMessageVoice>)),
  deleteMessageVoice: vi.fn(async () => undefined),
}));

// 默认与自定义都经过文字处理；测试中让处理结果等于输入，专注验证编排不变量。
vi.mock('./voice-draft.js', () => ({
  draftSpokenText: vi.fn(async (sourceText: string) => ({
    text: sourceText,
    gate: 'thinking_off',
  })),
}));

const { runVoiceGeneration } = await import('./generate.js');

function makeLogger() {
  const sink = () => undefined;
  return {
    info: sink,
    warn: sink,
    error: sink,
    debug: sink,
    biz: { info: sink, warn: sink, error: sink, debug: sink },
    sys: { info: sink, warn: sink, error: sink, debug: sink },
  } as never;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('runVoiceGeneration — 最终长度闸', () => {
  it('301 字不调 synthesizeSpeech、不扣费，markFailed(voice_text_too_long)', async () => {
    const overLimit = '啊'.repeat(301);

    await runVoiceGeneration({
      audioId: 'a1',
      messageId: 'm1',
      userId: 'u1',
      sourceText: '原文',
      customText: overLimit,
      voiceId: 'v1',
      ttsModel: 'speech-02-hd',
      ttsSpeed: 1,
      billingEnabled: true,
      creditsPerGeneration: 15,
      priceLabel: '15 星尘',
      maxSpokenChars: 300,
      log: makeLogger(),
    });

    expect(synthesizeSpeech).not.toHaveBeenCalled();
    expect(storeMessageVoice).not.toHaveBeenCalled();
    expect(settleVoiceGeneration).not.toHaveBeenCalled();
    expect(markReady).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledTimes(1);
    expect(markFailed).toHaveBeenCalledWith('a1', 'voice_text_too_long', expect.any(Number));
  });

  it('刚好 300 字是合法的，走完合成 + 扣费 + markReady', async () => {
    const atLimit = '啊'.repeat(300);

    await runVoiceGeneration({
      audioId: 'a2',
      messageId: 'm2',
      userId: 'u1',
      sourceText: '原文',
      customText: atLimit,
      voiceId: 'v1',
      ttsModel: 'speech-02-hd',
      ttsSpeed: 1,
      billingEnabled: true,
      creditsPerGeneration: 15,
      priceLabel: '15 星尘',
      maxSpokenChars: 300,
      log: makeLogger(),
    });

    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(storeMessageVoice).toHaveBeenCalledTimes(1);
    expect(settleVoiceGeneration).toHaveBeenCalledTimes(1);
    expect(markReady).not.toHaveBeenCalled();
    expect(markFailed).not.toHaveBeenCalled();
  });
});

describe('runVoiceGeneration — 计费开关', () => {
  it('billingEnabled=false 时不扣费，markReady credits_charged=0', async () => {
    const text = '短台词';

    await runVoiceGeneration({
      audioId: 'a3',
      messageId: 'm3',
      userId: 'u1',
      sourceText: '原文',
      customText: text,
      voiceId: 'v1',
      ttsModel: 'speech-02-hd',
      ttsSpeed: 1,
      billingEnabled: false,
      creditsPerGeneration: 15,
      priceLabel: '15 星尘',
      maxSpokenChars: 300,
      log: makeLogger(),
    });

    expect(settleVoiceGeneration).not.toHaveBeenCalled();
    expect(markReady).toHaveBeenCalledWith(
      'a3',
      expect.objectContaining({ creditsCharged: 0, chargeId: null })
    );
  });
});

describe('runVoiceGeneration — Q4 扣费时余额不足', () => {
  it('TTS 已成功但扣费返回 insufficient_balance：标记失败且不 ready', async () => {
    settleVoiceGeneration.mockResolvedValueOnce({
      wallet: { user_id: 'u1', main_credits: 0, bonus_credits: 0, total_credits: 0 },
      chargeStatus: 'insufficient_balance',
      alreadyCharged: false,
      charged: false,
    });

    await runVoiceGeneration({
      audioId: 'a4',
      messageId: 'm4',
      userId: 'u1',
      sourceText: '原文',
      customText: '短台词',
      voiceId: 'v1',
      ttsModel: 'speech-02-hd',
      ttsSpeed: 1,
      billingEnabled: true,
      creditsPerGeneration: 15,
      priceLabel: '15 星尘',
      maxSpokenChars: 300,
      log: makeLogger(),
    });

    expect(synthesizeSpeech).toHaveBeenCalledTimes(1);
    expect(storeMessageVoice).toHaveBeenCalledTimes(1);
    expect(markReady).not.toHaveBeenCalled();
    expect(markFailed).toHaveBeenCalledWith('a4', 'voice_insufficient_balance', expect.any(Number));
  });

  it('扣费幂等命中 already_charged：按已扣记账，不重复扣', async () => {
    settleVoiceGeneration.mockResolvedValueOnce({
      wallet: { user_id: 'u1', main_credits: 0, bonus_credits: 0, total_credits: 0 },
      chargeStatus: 'already_charged',
      alreadyCharged: true,
      charged: false,
    });

    await runVoiceGeneration({
      audioId: 'a5',
      messageId: 'm5',
      userId: 'u1',
      sourceText: '原文',
      customText: '短台词',
      voiceId: 'v1',
      ttsModel: 'speech-02-hd',
      ttsSpeed: 1,
      billingEnabled: true,
      creditsPerGeneration: 15,
      priceLabel: '15 星尘',
      maxSpokenChars: 300,
      log: makeLogger(),
    });

    expect(settleVoiceGeneration).toHaveBeenCalledTimes(1);
    expect(markReady).not.toHaveBeenCalled();
  });
});
