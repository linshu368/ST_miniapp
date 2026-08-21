import type { RequestLogger } from '../../lib/logger.js';
import { storeMessageVoice } from '../../lib/chat-voice-storage.js';
import { ChatMessageAudioRepository } from '../../infrastructure/repositories/ChatMessageAudioRepository.js';
import { synthesizeSpeech } from './minimax.js';
import { draftSpokenText, type DraftGate } from './voice-draft.js';
import { VoiceUpstreamError } from './voice-upstream.js';

/**
 * 一次语音生成的完整流程：写稿 → 落台词 → 合成 → 落对象存储 → 收口记录。
 *
 * 调用方 fire-and-forget 地调它，本函数自己吞掉所有异常并把失败写回记录——
 * 抛出去没有人接得住（HTTP 响应早就发完了），只会变成 unhandledRejection。
 */
export async function runVoiceGeneration(input: {
  audioId: string;
  messageId: string;
  userId: string;
  sourceText: string;
  voiceId: string;
  ttsModel: string;
  ttsSpeed: number;
  log: RequestLogger;
}): Promise<void> {
  const audio = new ChatMessageAudioRepository();
  const startedAt = Date.now();

  try {
    // 上次失败留下的台词直接拿来用，写稿不重跑
    const reused = await audio.findReusableDraft(input.messageId);
    let spoken: string;
    let gate: DraftGate | 'reused';

    if (reused) {
      spoken = reused;
      gate = 'reused';
      await audio.saveDraft(input.audioId, spoken);
    } else {
      const draft = await draftSpokenText(input.sourceText);
      spoken = draft.text;
      gate = draft.gate;
      // 先落库再合成：合成失败时这份台词还在，下次重试不用再付一遍写稿
      await audio.saveDraft(input.audioId, spoken);
    }

    const synthesized = await synthesizeSpeech({
      text: spoken,
      voiceId: input.voiceId,
      speed: input.ttsSpeed,
      model: input.ttsModel,
    });

    const stored = await storeMessageVoice({
      userId: input.userId,
      messageId: input.messageId,
      audioId: input.audioId,
      audio: synthesized.audio,
    });

    await audio.markReady(input.audioId, {
      spokenText: spoken,
      storagePath: stored.path,
      audioUrl: stored.url,
      durationMs: synthesized.durationMs,
      latencyMs: Date.now() - startedAt,
    });

    input.log.biz.info(
      {
        event: 'voice.generate.done',
        audioId: input.audioId,
        voiceId: input.voiceId,
        gate,
        sourceChars: input.sourceText.length,
        spokenChars: spoken.length,
        durationMs: synthesized.durationMs,
        latencyMs: Date.now() - startedAt,
      },
      '语音生成完成'
    );
  } catch (error) {
    const stage = error instanceof VoiceUpstreamError ? error.stage : null;
    const code = error instanceof VoiceUpstreamError ? error.code : 'voice_generation_failed';
    input.log.sys.error(
      {
        event: 'voice.generate.failed',
        audioId: input.audioId,
        voiceId: input.voiceId,
        stage,
        errorCode: code,
        latencyMs: Date.now() - startedAt,
        err: error,
      },
      '语音生成失败'
    );

    // 连收口都失败就只能放着：那一行会停在 pending，由读路径的超时判定兜住
    try {
      await audio.markFailed(input.audioId, code, Date.now() - startedAt);
    } catch (markError) {
      input.log.sys.error(
        { event: 'voice.generate.mark_failed_error', audioId: input.audioId, err: markError },
        '标记语音生成失败时再次出错'
      );
    }
  }
}
