import { z } from 'zod';

/** UI metadata only. The selected rule text is stored exclusively in backend assets. */
export const CREATOR_PRESET_IDS = [
  'world-causality',
  'living-npcs',
  'player-boundaries',
  'gradual-intimacy',
] as const;
export const CreatorPresetIdSchema = z.enum(CREATOR_PRESET_IDS);
export type CreatorPresetId = z.infer<typeof CreatorPresetIdSchema>;
/** Full built-in text is loaded only when the reader explicitly opens details. */
export const CreatorPresetDetailDataSchema = z
  .object({
    preset: z.object({ id: CreatorPresetIdSchema, content: z.string().min(1) }).strict(),
  })
  .strict();
export type CreatorPresetDetailData = z.infer<typeof CreatorPresetDetailDataSchema>;

export const CREATOR_PRESET_CATALOG: ReadonlyArray<{
  id: CreatorPresetId;
  title: string;
  use_cases: string;
  effect: string;
}> = [
  {
    id: 'world-causality',
    title: '活的世界与真实因果',
    use_cases: '大世界、模拟经营、多势力沙盒、穿书/同人卡。',
    effect:
      '世界有真实的时间流逝和蝴蝶效应，玩家不在场时各方势力也在博弈，打架/办事成不成要看实力、环境和计谋，沉浸感极强。',
  },
  {
    id: 'living-npcs',
    title: '有灵魂的活人 NPC',
    use_cases: '高冷/傲娇/强者调教、宿敌、情感博弈、多人格深度卡。',
    effect:
      'NPC 有自己的脾气、算计和底线，哪怕表面顺从，心里也有自己的小九九，受挫时会咬牙隐忍或找机会反击，性格鲜活带感。',
  },
  {
    id: 'player-boundaries',
    title: '不抢话、不阴谋论的丝滑互动',
    use_cases: '所有高自由度角色扮演、纯爱日常、剧情推进卡。',
    effect: '严守玩家边界（不写玩家内心、不替玩家说话行动），NPC 对正常示好给正常正向反馈。',
  },
  {
    id: 'gradual-intimacy',
    title: '循序渐进的感情与慢镜头涩涩',
    use_cases: '恋爱养成、调教开发、后宫攻略、成人向亲密互动卡。',
    effect:
      '人设永远优先（高冷角色哪怕动情也是克制别扭的），从陌生到死心塌地、从抗拒到沉沦都有清晰的阶段递进；亲密戏强制慢镜头分层推进。',
  },
];

/** Resource limits reject oversized imports explicitly; they never truncate authored content. */
export const CREATOR_MAX_SOURCE_CHARS = 2_000_000;
export const CharacterSourceFileSchema = z
  .object({
    id: z.string().min(1).max(100),
    name: z.string().min(1).max(255),
    content: z.string().max(500_000),
  })
  .strict();
export type CharacterSourceFile = z.infer<typeof CharacterSourceFileSchema>;
export const CharacterDraftSchema = z
  .object({
    name: z.string().max(120),
    description: z.string().max(100_000),
    opening: z.string().max(20_000),
    background: z.string().max(1_000_000),
    preset: z.string().max(1_000_000),
    selectedPresetIds: z.array(CreatorPresetIdSchema).max(4).default([]),
    tags: z.array(z.string().trim().min(1).max(40)).max(10),
    backgroundFiles: z.array(CharacterSourceFileSchema).max(10),
    presetFiles: z.array(CharacterSourceFileSchema).max(10),
  })
  .strict()
  .superRefine((draft, ctx) => {
    const text = [
      draft.name,
      draft.description,
      draft.opening,
      draft.background,
      draft.preset,
      ...draft.backgroundFiles.map((file) => file.content),
      ...draft.presetFiles.map((file) => file.content),
    ];
    if (text.reduce((size, value) => size + value.length, 0) > CREATOR_MAX_SOURCE_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '角色资料总字数不能超过200万字，请精简导入文件',
      });
    }
    if (new Set(draft.selectedPresetIds).size !== draft.selectedPresetIds.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['selectedPresetIds'],
        message: '预设不能重复选择',
      });
    }
    if (new Set(draft.tags).size !== draft.tags.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['tags'], message: '标签不能重复' });
    }
  });
export type CharacterDraft = z.infer<typeof CharacterDraftSchema>;
export const CreatorVisibilitySchema = z.enum(['private', 'public']);
export type CreatorVisibility = z.infer<typeof CreatorVisibilitySchema>;
export const CreatorReviewStatusSchema = z.enum([
  'not_submitted',
  'pending',
  'approved',
  'rejected',
]);
export type CreatorReviewStatus = z.infer<typeof CreatorReviewStatusSchema>;
export const CreatorCharacterIdSchema = z.string().uuid();
export interface CreatorCharacterSummary {
  id: string;
  owner_user_id: string;
  name: string;
  description: string;
  cover_asset_id: string | null;
  cover_url: string | null;
  tags: string[];
  state: 'draft' | 'ready';
  visibility: CreatorVisibility;
  review_status: CreatorReviewStatus;
  review_message: string | null;
  revision: number;
  submitted_revision: number | null;
  published_revision: number | null;
  /** Effective public runtime approved for discovery; null while first submission awaits review. */
  approved_revision: number | null;
  created_at: string;
  updated_at: string;
}
export interface CreatorCharacter extends CreatorCharacterSummary {
  draft: CharacterDraft;
}
export interface ListCreatorCharactersData {
  owner_user_id: string;
  characters: CreatorCharacterSummary[];
}
export interface GetCreatorCharacterData {
  character: CreatorCharacter;
}
export interface ListCreatorReviewsData {
  characters: CreatorCharacterSummary[];
}
export const CreateCreatorCharacterSchema = z
  .object({
    id: z.string().uuid(),
    draft: CharacterDraftSchema.optional(),
    cover_asset_id: z.string().uuid().nullable().optional(),
  })
  .strict();
export const SaveCreatorCharacterSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    draft: CharacterDraftSchema,
    /** null explicitly removes a cover; temporary/signed URLs are not accepted. */
    cover_asset_id: z.string().uuid().nullable(),
  })
  .strict();
export const PublishCreatorCharacterSchema = z
  .object({
    expected_revision: z.number().int().positive(),
    visibility: CreatorVisibilitySchema,
  })
  .strict();
export const SetCreatorVisibilitySchema = PublishCreatorCharacterSchema;
export const ReviewCreatorCharacterSchema = z
  .object({
    submitted_revision: z.number().int().positive(),
    decision: z.enum(['approve', 'reject']),
    reason: z.string().trim().max(1000).optional(),
  })
  .strict()
  .refine((value) => value.decision !== 'reject' || Boolean(value.reason), {
    message: '请说明未通过的原因',
    path: ['reason'],
  });
export type CreateCreatorCharacterRequest = z.infer<typeof CreateCreatorCharacterSchema>;
export type SaveCreatorCharacterRequest = z.infer<typeof SaveCreatorCharacterSchema>;
export type PublishCreatorCharacterRequest = z.infer<typeof PublishCreatorCharacterSchema>;
export type SetCreatorVisibilityRequest = z.infer<typeof SetCreatorVisibilitySchema>;
export type ReviewCreatorCharacterRequest = z.infer<typeof ReviewCreatorCharacterSchema>;

export function emptyCharacterDraft(): CharacterDraft {
  return {
    name: '',
    description: '',
    opening: '',
    background: '',
    preset: '',
    selectedPresetIds: [],
    tags: [],
    backgroundFiles: [],
    presetFiles: [],
  };
}

/** Fixed assembly, preserving source verbatim. No model call or implicit rewriting. */
export function composeCharacterSystemPrompt(
  draft: Pick<CharacterDraft, 'preset' | 'background' | 'presetFiles' | 'backgroundFiles'>,
  resolvedPresets: readonly { title: string; content: string }[] = []
): string {
  const section = (
    title: string,
    text: string,
    files: CharacterSourceFile[],
    leading: string[] = []
  ) => {
    const parts = [...leading, ...(text.trim() ? [text] : [])];
    for (const file of files) {
      if (file.content.trim())
        parts.push(
          `### 文件：${file.name.replace(/[\r\n\u2028\u2029]+/g, ' ')}\n\n${file.content}`
        );
    }
    return parts.length ? `## ${title}\n\n${parts.join('\n\n')}` : '';
  };
  return [
    section(
      '预设',
      draft.preset,
      draft.presetFiles,
      resolvedPresets.map(({ title, content }) => `### ${title}\n\n${content}`)
    ),
    section('背景', draft.background, draft.backgroundFiles),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function creatorPublishMissingFields(
  draft: CharacterDraft,
  coverAssetId: string | null
): string[] {
  return [
    !coverAssetId && '角色形象',
    !draft.name.trim() && '名称',
    !draft.description.trim() && '描述',
    !draft.opening.trim() && '开场白',
    !(draft.background.trim() || draft.backgroundFiles.some((file) => file.content.trim())) &&
      '背景',
    draft.tags.length === 0 && '标签',
  ].filter((value): value is string => typeof value === 'string');
}
