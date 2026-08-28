import { MAX_SPOKEN_VOICE_CHARS } from '@miniapp/shared';
import type { RequestLogger } from '../../lib/logger.js';
import { storeMessageVoice } from '../../lib/chat-voice-storage.js';
import { ChatMessageAudioRepository } from '../../infrastructure/repositories/ChatMessageAudioRepository.js';
import { MiniappWalletRepository } from '../../infrastructure/repositories/MiniappWalletRepository.js';
import { synthesizeSpeech } from './minimax.js';
import { draftSpokenText, type DraftGate } from './voice-draft.js';
import { VoiceUpstreamError } from './voice-upstream.js';

/**
 * 一次语音生成的完整流程：写稿 → 最终长度闸 → 合成 → 落对象存储 → 扣费 → 收口记录。
 *
 * 调用方 fire-and-forget 地调它，本函数自己吞掉所有异常并把失败写回记录——
 * 抛出去没有人接得住（HTTP 响应早就发完了），只会变成 unhandledRejection。
 *
 * 计费硬规则：「只有听到（可播放）才会扣」，对齐对话「未见 [DONE] 不扣」：
 *   - 终检 >300：不调 TTS、不扣费，markFailed(voice_text_too_long)。
 *   - 写稿 / TTS / 上传失败：不扣费，markFailed(对应 code)。
 *   - 仅在 Storage 已有可播 URL 之后、markReady 之前调用 charge_voice_usage。
 *
 * billingEnabled=false 时跳过扣费，credits_charged=0、charge_id=null，行为与现网一致。
 */
export async function runVoiceGeneration(input: {
  audioId: string;
  messageId: string;
  userId: string;
  sourceText: string;
  /**
   * 用户指定的台词，已在受理时清洗与校验过。
   *
   * 非空时整个写稿阶段跳过：用户既然自己写了念什么，再交给模型改一遍就是帮倒忙。
   * 仍要走最终长度闸——清洗几乎只变短，但终检是硬约束，不能只在输入层放行。
   */
  customText: string | null;
  voiceId: string;
  ttsModel: string;
  ttsSpeed: number;
  /** 计费开关：false 时跳过扣费（现网免费行为）；true 时见到可播音频后扣 creditsPerGeneration */
  billingEnabled: boolean;
  /** 单次成功扣费额（voice_generation_credits，默认 15） */
  creditsPerGeneration: number;
  /** 价格展示文案（voice_price_label，如 "15 星尘"），写入扣费 metadata 供消费明细展示 */
  priceLabel: string;
  log: RequestLogger;
}): Promise<void> {
  const audio = new ChatMessageAudioRepository();
  const wallets = new MiniappWalletRepository();
  const startedAt = Date.now();

  try {
    let spoken: string;
    let gate: DraftGate | 'custom';

    if (input.customText) {
      spoken = input.customText;
      gate = 'custom';
    } else {
      const draft = await draftSpokenText(input.sourceText);
      spoken = draft.text;
      gate = draft.gate;
    }

    // 最终长度闸：送进 TTS 前再拦一次。模型「说自己没超」不算数，写稿与自定义共用。
    // 超限是业务失败，不是 TTS 失败：不创建 MiniMax 请求，credits_charged=0。
    if (spoken.length > MAX_SPOKEN_VOICE_CHARS) {
      await audio.markFailed(input.audioId, 'voice_text_too_long', Date.now() - startedAt);
      input.log.biz.warn(
        {
          event: 'voice.generate.over_limit',
          audioId: input.audioId,
          gate,
          spokenChars: spoken.length,
          limit: MAX_SPOKEN_VOICE_CHARS,
          latencyMs: Date.now() - startedAt,
        },
        '语音文本超过 300 字上限，已拦截'
      );
      return;
    }

    // 先落库再合成：合成失败时还能回答「到底送了什么进 TTS」
    await audio.saveDraft(input.audioId, spoken);

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

    // 见到可播音频后才扣费。幂等键 = audioId（每次生成一行，天然一费一单）。
    let creditsCharged = 0;
    let chargeId: string | null = null;
    if (input.billingEnabled) {
      try {
        const charge = await wallets.chargeVoiceUsage({
          chargeKey: input.audioId,
          userId: input.userId,
          audioId: input.audioId,
          amount: input.creditsPerGeneration,
          metadata: {
            voice_id: input.voiceId,
            tts_model: input.ttsModel,
            spoken_chars: spoken.length,
            gate,
            voice_price_label: input.priceLabel,
          },
        });
        if (charge.charged) {
          creditsCharged = input.creditsPerGeneration;
          chargeId = input.audioId;
          input.log.biz.info(
            {
              event: 'voice.charge.ok',
              audioId: input.audioId,
              credits: input.creditsPerGeneration,
              latencyMs: Date.now() - startedAt,
            },
            '语音扣费成功'
          );
        } else if (charge.chargeStatus === 'already_charged') {
          // 幂等命中：轮询重试、进程重复收口不得扣第二次。仍按已扣记账。
          creditsCharged = input.creditsPerGeneration;
          chargeId = input.audioId;
          input.log.biz.info(
            {
              event: 'voice.charge.skip',
              audioId: input.audioId,
              reason: 'already_charged',
            },
            '语音扣费幂等命中，跳过'
          );
        } else if (charge.chargeStatus === 'insufficient_balance') {
          // Q4：TTS 已成功、扣费时余额被对话回合花光。音频给听、打 error、人工补扣。
          // 不出现「扣了费但没音频」。
          input.log.sys.error(
            {
              event: 'voice.charge.fail',
              audioId: input.audioId,
              chargeStatus: charge.chargeStatus,
              credits: input.creditsPerGeneration,
              latencyMs: Date.now() - startedAt,
            },
            '语音扣费失败：余额不足，音频已生成需人工补扣'
          );
        }
      } catch (chargeError) {
        // 扣费 RPC 自身异常：音频仍给听，打 error，人工补扣。
        input.log.sys.error(
          {
            event: 'voice.charge.fail',
            audioId: input.audioId,
            err: chargeError,
            latencyMs: Date.now() - startedAt,
          },
          '语音扣费异常，音频已生成需人工补扣'
        );
      }
    }

    await audio.markReady(input.audioId, {
      spokenText: spoken,
      storagePath: stored.path,
      audioUrl: stored.url,
      durationMs: synthesized.durationMs,
      latencyMs: Date.now() - startedAt,
      creditsCharged,
      chargeId,
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
        creditsCharged,
        billingEnabled: input.billingEnabled,
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
