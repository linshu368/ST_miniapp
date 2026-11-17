import { getDomainDb } from '../../lib/supabase.js';
import {
  enabledDriveModes,
  normalizeTelegramAvatarUrl,
  ReplyStylePreferencesSchema,
  resolveDriveMode,
  type PatchUserSettingsRequest,
  type UserGenerationConfig,
  type VoiceConfig,
} from '@miniapp/shared';
import {
  DEFAULT_PLAYBACK_RATE,
  isAllowedPlaybackRate,
  isKnownVoiceId,
  resolvePlaybackRate,
  resolveVoiceId,
} from '../../features/voice/voice-catalog.js';
import { resolveEffectiveDisplayName } from './effective-display-name.js';
import { config } from '../../platform/config.js';
import type { TelegramUser } from '../../middleware/auth.js';
import {
  fetchPlatformInstructions,
  toPublicWordCountTiersFromEngine,
  type PlatformInstructionsSnapshot,
} from '../../features/engine/platform-instructions.js';
import {
  MiniappUserSettingsRow,
  MutableUserSettingsFields,
  pickInstructionSlotPreferences,
  omitInstructionSlotPreferences,
  normalizeReplyStylePreferences,
  normalizeNullableText,
} from './user-settings-model.js';

export { type MiniappUserSettingsRow, toUserSettings } from './user-settings-model.js';

export class MiniappUserSettingsRepository {
  private readonly db = getDomainDb('app_core');

  async getOrCreate(userId: string, tgUser: TelegramUser): Promise<MiniappUserSettingsRow> {
    const existing = await this.findByUserId(userId);
    if (existing) {
      return await this.refreshTelegramProfile(userId, tgUser);
    }

    // pref_word_count 刻意不写：留 NULL 才表示「未选过」，新用户才会跟随运营台的默认档（086）
    const { data, error } = await this.db
      .from('miniapp_user_settings')
      .insert({
        user_id: userId,
        ...this.telegramProfileFields(tgUser),
      })
      .select('*')
      .single();

    if (error) {
      const afterRace = await this.findByUserId(userId);
      if (afterRace) return afterRace;
      throw new Error(`创建 MiniApp 用户设置失败：${error.message}`, { cause: error });
    }

    return data as MiniappUserSettingsRow;
  }

  async patch(
    userId: string,
    tgUser: TelegramUser,
    patch: PatchUserSettingsRequest
  ): Promise<MiniappUserSettingsRow> {
    await this.getOrCreate(userId, tgUser);

    const update = await this.normalizePatch(patch);
    const { pref_reply_styles: replyStyles, ...ordinaryUpdate } = update;
    const slotPreferences = pickInstructionSlotPreferences(ordinaryUpdate);
    const otherFields = omitInstructionSlotPreferences(ordinaryUpdate);

    if (replyStyles && Object.keys(replyStyles).length > 0) {
      // Never read/replace the whole map: different switches must merge atomically in SQL.
      const { error } = await this.db
        .rpc('update_reply_style_preferences', { p_user_id: userId, p_patch: replyStyles })
        .abortSignal(AbortSignal.timeout(5_000));
      if (error) throw new Error(`原子更新回复风格偏好失败：${error.message}`, { cause: error });
    }

    // The migration owns false -> true window resets in this RPC. Keeping these
    // fields out of any normal update prevents a concurrent profile write from
    // replacing a just-reset counter with a stale direct write.
    if (Object.keys(slotPreferences).length > 0) {
      const { error } = await this.db
        .rpc('update_instruction_slot_preferences', {
          p_user_id: userId,
          p_pref_show_options: slotPreferences.pref_show_options ?? null,
          p_pref_show_status: slotPreferences.pref_show_status ?? null,
          p_pref_show_memory: slotPreferences.pref_show_memory ?? null,
        })
        .abortSignal(AbortSignal.timeout(5_000));
      if (error) throw new Error(`原子更新生成偏好失败：${error.message}`, { cause: error });
    }

    if (Object.keys(otherFields).length > 0) {
      const { error } = await this.db
        .from('miniapp_user_settings')
        .update({
          ...this.telegramProfileFields(tgUser),
          ...otherFields,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', userId);
      if (error) throw new Error(`更新 MiniApp 用户设置失败：${error.message}`, { cause: error });
    }

    const row = await this.findByUserId(userId);
    if (!row) throw new Error('更新 MiniApp 用户设置后未找到用户设置');
    return row;
  }

  async setCustomAvatar(
    userId: string,
    tgUser: TelegramUser,
    avatarUrl: string
  ): Promise<MiniappUserSettingsRow> {
    await this.getOrCreate(userId, tgUser);
    const { data, error } = await this.db
      .from('miniapp_user_settings')
      .update({
        ...this.telegramProfileFields(tgUser),
        custom_avatar_url: avatarUrl,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .select('*')
      .single();
    if (error) throw new Error(`更新用户头像失败：${error.message}`, { cause: error });
    return data as MiniappUserSettingsRow;
  }

  async setSelectedModelId(
    userId: string,
    tgUser: TelegramUser,
    selectedModelId: string
  ): Promise<MiniappUserSettingsRow> {
    await this.getOrCreate(userId, tgUser);
    const { data, error } = await this.db
      .from('miniapp_user_settings')
      .update({
        ...this.telegramProfileFields(tgUser),
        selected_model_id: selectedModelId,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error) throw new Error(`更新模型选择失败：${error.message}`, { cause: error });
    return data as MiniappUserSettingsRow;
  }

  /**
   * 生成路径没有 Telegram 资料，只改模型选择，避免把展示名写成空。
   * 没有设置行时更新 0 行，调用方照样用本轮解析结果。
   */
  async correctSelectedModelId(userId: string, selectedModelId: string): Promise<void> {
    const { error } = await this.db
      .from('miniapp_user_settings')
      .update({
        selected_model_id: selectedModelId,
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId);
    if (error) throw new Error(`修正模型选择失败：${error.message}`, { cause: error });
  }

  async getSelectedModelId(userId: string): Promise<string | null> {
    const { data, error } = await this.db
      .from('miniapp_user_settings')
      .select('selected_model_id')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new Error(`查询用户模型选择失败：${error.message}`, { cause: error });
    return (
      (data as Pick<MiniappUserSettingsRow, 'selected_model_id'> | null)?.selected_model_id ?? null
    );
  }

  /**
   * 自研引擎的用户生成配置读取通道（M1）。
   *
   * 三个 pref_* 字段自 migration 015 就已存在，此前从未被任何生成路径消费；
   * 引擎侧的用法见 M2（{{WORD_COUNT}} / {{USER_CUSTOM_INSTRUCTIONS}}）。
   * 配置属于用户层、对该用户所有会话生效（总方案决策 10），因此不接受 session 维度入参。
   *
   * 用户还没有设置行、或存档档位为 NULL（从未选过，见 086）时，回复长度回落到运营台当前的
   * default_tier_id——这是运营台改默认档能被用户看到的唯一通路，不要在这里改成硬编码档位。
   * 若存档 id 已从启用档位中下线，同样回落，避免 UI 出现无选中态。
   */
  async getGenerationConfig(userId: string): Promise<UserGenerationConfig> {
    return (await this.getGenerationContext(userId)).config;
  }

  /** One request-local read keeps model, prompt preferences and persona consistent. */
  async getGenerationContext(
    userId: string,
    instructionPromise?: Promise<PlatformInstructionsSnapshot>
  ): Promise<{ config: UserGenerationConfig; displayName: string }> {
    const [result, instructions] = await Promise.all([
      this.db
        .from('miniapp_user_settings')
        .select(
          'selected_model_id, pref_word_count, pref_show_options, pref_show_status, pref_show_memory, pref_reply_styles, pref_drive_mode, pref_custom_instructions, display_name, tg_first_name, tg_username'
        )
        .eq('user_id', userId)
        .abortSignal(AbortSignal.timeout(5_000))
        .maybeSingle(),
      instructionPromise ?? fetchPlatformInstructions(),
    ]);
    const { data, error } = result;

    if (error) throw new Error(`查询用户生成配置失败：${error.message}`, { cause: error });

    const row = data as Pick<
      MiniappUserSettingsRow,
      | 'selected_model_id'
      | 'pref_word_count'
      | 'pref_show_options'
      | 'pref_show_status'
      | 'pref_show_memory'
      | 'pref_reply_styles'
      | 'pref_drive_mode'
      | 'pref_custom_instructions'
      | 'display_name'
      | 'tg_first_name'
      | 'tg_username'
    > | null;

    const publicTiers = toPublicWordCountTiersFromEngine(instructions.instructions.wordCountTiers);
    const driveModes = instructions.instructions.driveModes;
    const stored = row?.pref_word_count ?? null;
    const pref_word_count =
      stored !== null && publicTiers.tiers.some((tier) => tier.id === stored)
        ? stored
        : publicTiers.default_tier_id;

    const config: UserGenerationConfig = {
      selected_model_id: row?.selected_model_id ?? null,
      pref_word_count,
      pref_show_options: row?.pref_show_options ?? true,
      pref_show_status: row?.pref_show_status ?? true,
      pref_show_memory: row?.pref_show_memory ?? true,
      pref_reply_styles: normalizeReplyStylePreferences(row?.pref_reply_styles),
      ...(driveModes
        ? { pref_drive_mode: resolveDriveMode(row?.pref_drive_mode, driveModes).id }
        : {}),
      pref_custom_instructions: row?.pref_custom_instructions ?? null,
    };
    return { config, displayName: resolveEffectiveDisplayName(row) };
  }

  /**
   * 角色语音偏好。与生成偏好同域：用户级、对所有角色生效。
   *
   * 存的可能是已下线的音色或不在档位里的倍速（改了目录、改了档位），
   * 一律在这里回落成有效值，UI 才不会出现无选中态。
   */
  async getVoiceConfig(userId: string): Promise<VoiceConfig> {
    const { data, error } = await this.db
      .from('miniapp_user_settings')
      .select('pref_voice_id, pref_voice_playback_rate')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new Error(`查询语音偏好失败：${error.message}`, { cause: error });

    const row = data as Pick<
      MiniappUserSettingsRow,
      'pref_voice_id' | 'pref_voice_playback_rate'
    > | null;

    return {
      voice_id: resolveVoiceId(row?.pref_voice_id),
      // NUMERIC 经 PostgREST 回来可能是字符串，Number() 一道保证类型
      playback_rate: resolvePlaybackRate(
        row ? Number(row.pref_voice_playback_rate) : DEFAULT_PLAYBACK_RATE
      ),
    };
  }

  async setVoiceConfig(
    userId: string,
    tgUser: TelegramUser,
    patch: { voiceId?: string; playbackRate?: number }
  ): Promise<VoiceConfig> {
    await this.getOrCreate(userId, tgUser);

    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.voiceId !== undefined) {
      if (!isKnownVoiceId(patch.voiceId)) throw new Error('无效的音色');
      update.pref_voice_id = patch.voiceId;
    }
    if (patch.playbackRate !== undefined) {
      if (!isAllowedPlaybackRate(patch.playbackRate)) throw new Error('无效的播放速度');
      update.pref_voice_playback_rate = patch.playbackRate;
    }

    const { error } = await this.db
      .from('miniapp_user_settings')
      .update(update)
      .eq('user_id', userId);

    if (error) throw new Error(`更新语音偏好失败：${error.message}`, { cause: error });
    return await this.getVoiceConfig(userId);
  }

  /**
   * 引擎 persona 与 {{user}} 注入的取数通道。
   *
   * 返回「我的」页同一套生效名：自定义 display_name > TG first_name > TG username > 「你」。
   * 与 getGenerationConfig 分开是因为 UserGenerationConfig 是对外契约，显示名属于用户资料。
   */
  async getDisplayName(userId: string): Promise<string> {
    const { data, error } = await this.db
      .from('miniapp_user_settings')
      .select('display_name, tg_first_name, tg_username')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new Error(`查询用户昵称失败：${error.message}`, { cause: error });
    return resolveEffectiveDisplayName(
      data as Pick<MiniappUserSettingsRow, 'display_name' | 'tg_first_name' | 'tg_username'> | null
    );
  }

  private async findByUserId(userId: string): Promise<MiniappUserSettingsRow | null> {
    const { data, error } = await this.db
      .from('miniapp_user_settings')
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new Error(`查询 MiniApp 用户设置失败：${error.message}`, { cause: error });
    return (data as MiniappUserSettingsRow | null) ?? null;
  }

  private async refreshTelegramProfile(
    userId: string,
    tgUser: TelegramUser
  ): Promise<MiniappUserSettingsRow> {
    const { data, error } = await this.db
      .from('miniapp_user_settings')
      .update({
        ...this.telegramProfileFields(tgUser),
        updated_at: new Date().toISOString(),
      })
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error) throw new Error(`刷新 Telegram 用户信息失败：${error.message}`, { cause: error });
    return data as MiniappUserSettingsRow;
  }

  private telegramProfileFields(tgUser: TelegramUser) {
    return {
      tg_username: tgUser.username ?? null,
      tg_first_name: tgUser.first_name ?? null,
      tg_last_name: tgUser.last_name ?? null,
      tg_avatar_url: normalizeTelegramAvatarUrl(tgUser.photo_url),
    };
  }

  private async normalizePatch(
    patch: PatchUserSettingsRequest
  ): Promise<MutableUserSettingsFields> {
    const update: MutableUserSettingsFields = {};

    if ('display_name' in patch) {
      update.display_name = normalizeNullableText(patch.display_name, 32);
    }
    if ('avatar_url' in patch) {
      if (patch.avatar_url !== null) {
        throw new Error('自定义头像必须通过头像导入接口设置');
      }
      update.custom_avatar_url = null;
    }
    if ('pref_word_count' in patch) {
      const next = typeof patch.pref_word_count === 'string' ? patch.pref_word_count.trim() : '';
      const publicTiers = toPublicWordCountTiersFromEngine(
        (await fetchPlatformInstructions()).instructions.wordCountTiers
      );
      if (!next || !publicTiers.tiers.some((tier) => tier.id === next)) {
        throw new Error('无效的字数偏好');
      }
      update.pref_word_count = next;
    }
    if ('pref_show_options' in patch) {
      update.pref_show_options = Boolean(patch.pref_show_options);
    }
    if ('pref_show_status' in patch) {
      update.pref_show_status = Boolean(patch.pref_show_status);
    }
    if ('pref_show_memory' in patch) {
      update.pref_show_memory = Boolean(patch.pref_show_memory);
    }
    if ('pref_reply_styles' in patch) {
      const parsed = ReplyStylePreferencesSchema.safeParse(patch.pref_reply_styles);
      if (!parsed.success) throw new Error('无效的回复风格偏好');
      update.pref_reply_styles = parsed.data;
    }
    if ('pref_drive_mode' in patch) {
      const next = typeof patch.pref_drive_mode === 'string' ? patch.pref_drive_mode.trim() : '';
      const config = (await fetchPlatformInstructions()).instructions.driveModes;
      // 只接受当前启用的档位；配置不可用时拒绝写入，避免存下一个日后才失效的值。
      if (!config || !enabledDriveModes(config).some((mode) => mode.id === next)) {
        throw new Error('无效的剧情模式');
      }
      update.pref_drive_mode = next;
    }
    if ('pref_custom_instructions' in patch) {
      update.pref_custom_instructions = normalizeNullableText(patch.pref_custom_instructions, 2000);
    }

    return update;
  }
}
