import type { RequestLogger } from '../../lib/logger.js';
import { storeMessageVoice } from '../../lib/chat-voice-storage.js';
import { ChatMessageAudioRepository } from '../../infrastructure/repositories/ChatMessageAudioRepository.js';
import { convertToVoiceText, synthesizeSpeech, VoiceUpstreamError } from './minimax.js';
import { normalizeConvertedText, toSpokenText } from './voice-text.js';

/**
 * 一次语音生成的完整流程：改写 → 清洗 → 合成 → 落对象存储 → 收口记录。
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
    const converted = normalizeConvertedText(await convertToVoiceText(input.sourceText));
    const spoken = toSpokenText(converted);

    // 模板要求「原文没有就不要编」，遇到纯动作描写的回复它会正确地什么都不输出。
    // 这不是异常，但也没法合成，按失败收口让用户知道这条不适合转语音。
    if (!spoken.trim()) {
      throw new VoiceUpstreamError('convert', 'voice_nothing_to_speak', '这条回复没有可朗读的内容');
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
      spokenText: converted,
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
        sourceChars: input.sourceText.length,
        spokenChars: spoken.length,
        durationMs: synthesized.durationMs,
        latencyMs: Date.now() - startedAt,
      },
      '语音生成完成'
    );
  } catch (error) {
    const code = error instanceof VoiceUpstreamError ? error.code : 'voice_generation_failed';
    input.log.sys.error(
      {
        event: 'voice.generate.failed',
        audioId: input.audioId,
        voiceId: input.voiceId,
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
