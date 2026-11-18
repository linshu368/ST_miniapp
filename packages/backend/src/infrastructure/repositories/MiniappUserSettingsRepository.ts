import { getDomainDb } from '../../lib/supabase.js';
import {
  enabledDriveModes,
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
import type { TelegramUser } from '../../middleware/auth.js';
import {
  fetchPlatformInstructions,
  toPublicWordCountTiersFromEngine,
  type PlatformInstructionsSnapshot,
} from '../../features/engine/platform-instructions.js';
import {
  composeSettingsRow,
  MiniappUserSettingsRow,
  MutableUserSettingsFields,
  pickInstructionSlotPreferences,
  omitInstructionSlotPreferences,
  normalizeReplyStylePreferences,
  normalizeNullableText,
  splitProfileFields,
  type UserPreferencesRow,
} from './user-settings-model.js';
import { UserProfileRepository } from './UserProfileRepository.js';

export { type MiniappUserSettingsRow, toUserSettings } from './user-settings-model.js';

/** 偏好表（数据库重组 3b-2 起；资料在 app_core.users，经 UserProfileRepository）。 */
const PREFERENCES = 'user_preferences';
const GENERATION_PREFERENCE_COLUMNS =
  'selected_model_id, pref_word_count, pref_show_options, pref_show_status, pref_show_memory, pref_reply_styles, pref_drive_mode, pref_custom_instructions';

export class MiniappUserSettingsRepository {
  private readonly db = getDomainDb('app_core');
  private readonly profiles = new UserProfileRepository();

  /**
   * 刷新 TG 资料并确保偏好行存在，返回资料 + 偏好。
   * 先刷新资料再建偏好行：建行时数据库会从 users 带上资料，两边保持一致。
   */
  async getOrCreate(userId: string, tgUser: TelegramUser): Promise<MiniappUserSettingsRow> {
    const profile = await this.profiles.refreshTelegram(userId, tgUser);
    const preferences = await this.ensurePreferences(userId);
    return composeSettingsRow(preferences, profile);
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
    const { profile, preferences } = splitProfileFields(
      omitInstructionSlotPreferences(ordinaryUpdate)
    );

    if (replyStyles && Object.keys(replyStyles).length > 0) {
      // Never read/replace the whole map: different switches must merge atomically in SQL.
      const { error } = await this.db
        .rpc('update_reply_style_preferences', { p_user_id: userId, p_patch: replyStyles })
        .abortSignal(AbortSignal.timeout(5_000));
      if (error) throw new Error(`原子更新回复风格偏好失败：${error.message}`, { cause: error });
    }

    // The migration owns these three switches in one RPC so concurrent patches
    // cannot overwrite each other with a stale read-modify-write.
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

    await this.profiles.update(userId, profile);

    if (Object.keys(preferences).length > 0) {
      const { error } = await this.db
        .from(PREFERENCES)
        .update({ ...preferences, updated_at: new Date().toISOString() })
        .eq('user_id', userId);
      if (error) throw new Error(`更新 MiniApp 用户设置失败：${error.message}`, { cause: error });
    }

    return await this.findComposed(userId);
  }

  async setCustomAvatar(
    userId: string,
    tgUser: TelegramUser,
    avatarUrl: string
  ): Promise<MiniappUserSettingsRow> {
    await this.getOrCreate(userId, tgUser);
    await this.profiles.update(userId, { custom_avatar_url: avatarUrl });
    return await this.findComposed(userId);
  }

  async setSelectedModelId(
    userId: string,
    tgUser: TelegramUser,
    selectedModelId: string
  ): Promise<MiniappUserSettingsRow> {
    const current = await this.getOrCreate(userId, tgUser);
    const { data, error } = await this.db
      .from(PREFERENCES)
      .update({ selected_model_id: selectedModelId, updated_at: new Date().toISOString() })
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error) throw new Error(`更新模型选择失败：${error.message}`, { cause: error });
    return { ...current, ...(data as UserPreferencesRow) };
  }

  /**
   * 生成路径只改模型选择。没有偏好行时更新 0 行，调用方照样用本轮解析结果。
   */
  async correctSelectedModelId(userId: string, selectedModelId: string): Promise<void> {
    const { error } = await this.db
      .from(PREFERENCES)
      .update({ selected_model_id: selectedModelId, updated_at: new Date().toISOString() })
      .eq('user_id', userId);
    if (error) throw new Error(`修正模型选择失败：${error.message}`, { cause: error });
  }

  async getSelectedModelId(userId: string): Promise<string | null> {
    const { data, error } = await this.db
      .from(PREFERENCES)
      .select('selected_model_id')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new Error(`查询用户模型选择失败：${error.message}`, { cause: error });
    return (
      (data as Pick<UserPreferencesRow, 'selected_model_id'> | null)?.selected_model_id ?? null
    );
  }

  /**
   * 自研引擎的用户生成配置读取通道（M1）。
   *
   * 配置属于用户层、对该用户所有会话生效（总方案决策 10），因此不接受 session 维度入参。
   * 用户还没有偏好行、或存档档位为 NULL（从未选过，见 086）时，回复长度回落到运营台当前的
   * default_tier_id——这是运营台改默认档能被用户看到的唯一通路，不要在这里改成硬编码档位。
   * 若存档 id 已从启用档位中下线，同样回落，避免 UI 出现无选中态。
   */
  async getGenerationConfig(userId: string): Promise<UserGenerationConfig> {
    return (await this.getGenerationContext(userId)).config;
  }

  /**
   * 一轮只读一次：模型、提示偏好与 persona 昵称在本轮内冻结。
   * 偏好与资料分在两张表，同一请求内并行读取；任一失败即整体失败，不降级。
   */
  async getGenerationContext(
    userId: string,
    instructionPromise?: Promise<PlatformInstructionsSnapshot>
  ): Promise<{ config: UserGenerationConfig; displayName: string }> {
    const [preferenceResult, names, instructions] = await Promise.all([
      this.db
        .from(PREFERENCES)
        .select(GENERATION_PREFERENCE_COLUMNS)
        .eq('user_id', userId)
        .abortSignal(AbortSignal.timeout(5_000))
        .maybeSingle(),
      this.profiles.readNames(userId).catch((err: unknown) => {
        throw new Error(`查询用户生成配置失败：${(err as Error).message}`, { cause: err });
      }),
      instructionPromise ?? fetchPlatformInstructions(),
    ]);
    const { data, error } = preferenceResult;
    if (error) throw new Error(`查询用户生成配置失败：${error.message}`, { cause: error });

    const row = data as Pick<
      UserPreferencesRow,
      | 'selected_model_id'
      | 'pref_word_count'
      | 'pref_show_options'
      | 'pref_show_status'
      | 'pref_show_memory'
      | 'pref_reply_styles'
      | 'pref_drive_mode'
      | 'pref_custom_instructions'
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
    return { config, displayName: resolveEffectiveDisplayName(names) };
  }

  /**
   * 角色语音偏好。与生成偏好同域：用户级、对所有角色生效。
   *
   * 存的可能是已下线的音色或不在档位里的倍速（改了目录、改了档位），
   * 一律在这里回落成有效值，UI 才不会出现无选中态。
   */
  async getVoiceConfig(userId: string): Promise<VoiceConfig> {
    const { data, error } = await this.db
      .from(PREFERENCES)
      .select('pref_voice_id, pref_voice_playback_rate')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new Error(`查询语音偏好失败：${error.message}`, { cause: error });

    const row = data as Pick<
      UserPreferencesRow,
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

    const { error } = await this.db.from(PREFERENCES).update(update).eq('user_id', userId);

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
    return resolveEffectiveDisplayName(await this.profiles.readNames(userId));
  }

  /** pref_word_count 刻意不写：留 NULL 才表示「未选过」，新用户才会跟随运营台的默认档（086）。 */
  private async ensurePreferences(userId: string): Promise<UserPreferencesRow> {
    const existing = await this.findPreferences(userId);
    if (existing) return existing;

    const { data, error } = await this.db
      .from(PREFERENCES)
      .insert({ user_id: userId })
      .select('*')
      .single();
    if (!error) return data as UserPreferencesRow;

    const afterRace = await this.findPreferences(userId);
    if (afterRace) return afterRace;
    throw new Error(`创建 MiniApp 用户设置失败：${error.message}`, { cause: error });
  }

  private async findPreferences(userId: string): Promise<UserPreferencesRow | null> {
    const { data, error } = await this.db
      .from(PREFERENCES)
      .select('*')
      .eq('user_id', userId)
      .maybeSingle();

    if (error) throw new Error(`查询 MiniApp 用户设置失败：${error.message}`, { cause: error });
    return (data as UserPreferencesRow | null) ?? null;
  }

  private async findComposed(userId: string): Promise<MiniappUserSettingsRow> {
    const [preferences, profile] = await Promise.all([
      this.findPreferences(userId),
      this.profiles.read(userId),
    ]);
    if (!preferences) throw new Error('更新 MiniApp 用户设置后未找到用户设置');
    return composeSettingsRow(preferences, profile);
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
