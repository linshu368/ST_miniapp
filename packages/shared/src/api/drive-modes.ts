import { z } from 'zod';

/**
 * 剧情模式：用户选择“剧情由谁推动”。运营在 runtime_config.drive_mode_options 维护四档左右的
 * 名称、说明和注入主体模板 {{DRIVE_RULES}} 的规则；用户的选择存在 miniapp_user_settings.pref_drive_mode。
 */
export const DRIVE_MODE_OPTIONS_KEY = 'drive_mode_options';
export const MAX_DRIVE_MODES = 8;

/** 稳定 id，写进用户偏好与每轮诊断；改名只改 ui_label，不改 id。 */
export const DriveModeIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);

export const DriveModeOptionSchema = z
  .object({
    id: DriveModeIdSchema,
    /** 抽屉按钮上的名字，四档并排，必须短 */
    ui_label: z.string().trim().min(1, '请填写名称').max(8, '名称不超过 8 个字'),
    /** 选中后显示的一句白话说明 */
    description: z.string().trim().max(60, '说明不超过 60 个字'),
    /** 注入主体模板 {{DRIVE_RULES}} 的完整规则；模型每次只看到一档，必须自成一体 */
    rules: z.string().trim().min(1, '请填写规则').max(4000),
    enabled: z.boolean(),
    sort_order: z.number().int().nonnegative(),
  })
  .strict();

export const DriveModesConfigSchema = z
  .object({
    modes: z.array(DriveModeOptionSchema).min(1).max(MAX_DRIVE_MODES),
    default_mode_id: DriveModeIdSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.modes.map((mode) => mode.id);
    if (new Set(ids).size !== ids.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['modes'], message: '模式 id 不能重复' });
    }
    const fallback = value.modes.find((mode) => mode.id === value.default_mode_id);
    if (!fallback) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default_mode_id'],
        message: '默认模式必须是列表里的某一档',
      });
    } else if (!fallback.enabled) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['default_mode_id'],
        message: '默认模式必须处于启用状态',
      });
    }
  });

export type DriveModeOption = z.infer<typeof DriveModeOptionSchema>;
export type DriveModesConfig = z.infer<typeof DriveModesConfigSchema>;

/**
 * 配置缺失或损坏时注入 {{DRIVE_RULES}} 的保守规则：等同上线前主体模板里的防抢话，
 * 即用户主导、角色只反应。宁可退回旧体验，也不能让槽位空着或放开对用户角色的书写。
 */
export const FALLBACK_DRIVE_RULES = [
  '当前剧情模式：跟随用户。剧情由用户推动。',
  '- 用户角色：不写用户的台词、动作、决定和心理，只写用户已经做出的言行带来的后果。',
  '- 角色：对用户的言行作出真实反应，不主动提出新的话题、去处或计划，不做改变局面的举动。',
  '- 新元素：不引入用户没有提到的人物、物品和事件；不换场景，不跳时间。',
  '- 用户输入很少或含糊时：让角色把当前的反应自然延续一点，然后把话头交还给用户。',
].join('\n');

/** 运营平台首次编辑时的起点：只有保守的一档，正式内容由运营发布。 */
export const DEFAULT_DRIVE_MODES_CONFIG: DriveModesConfig = {
  modes: [
    {
      id: 'follow',
      ui_label: '我来带',
      description: '你说一句，TA 接一句，剧情只听你的。',
      rules: FALLBACK_DRIVE_RULES,
      enabled: true,
      sort_order: 0,
    },
  ],
  default_mode_id: 'follow',
};

/** 下发给 MiniApp 的公开部分：不含规则正文，只含启用档位。 */
export const PublicDriveModesSchema = z
  .object({
    modes: z.array(
      z
        .object({
          id: DriveModeIdSchema,
          ui_label: z.string().min(1).max(8),
          description: z.string().max(60),
        })
        .strict()
    ),
    default_mode_id: DriveModeIdSchema,
  })
  .strict();
export type PublicDriveModes = z.infer<typeof PublicDriveModesSchema>;

export function enabledDriveModes(config: DriveModesConfig): DriveModeOption[] {
  return config.modes
    .filter((mode) => mode.enabled)
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order);
}

/**
 * 用户存的 id 只在启用档位里匹配；未选、已停用或已删除都回落到默认档。
 * 与回复长度同一口径：存值保留原样，生效值在读取时解析。
 */
export function resolveDriveMode(
  storedId: string | null | undefined,
  config: DriveModesConfig
): DriveModeOption {
  const enabled = enabledDriveModes(config);
  const resolved =
    enabled.find((mode) => mode.id === storedId) ??
    enabled.find((mode) => mode.id === config.default_mode_id) ??
    // superRefine 保证默认档存在且启用；以下两层只为让函数对任意入参都有确定结果。
    enabled[0] ??
    config.modes[0];
  if (!resolved) throw new Error('drive mode config has no modes');
  return resolved;
}

export function toPublicDriveModes(config: DriveModesConfig): PublicDriveModes {
  return {
    modes: enabledDriveModes(config).map(({ id, ui_label, description }) => ({
      id,
      ui_label,
      description,
    })),
    default_mode_id: resolveDriveMode(null, config).id,
  };
}
