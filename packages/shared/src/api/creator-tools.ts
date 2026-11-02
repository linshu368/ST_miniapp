import { z } from 'zod';
import { CharacterDraftSchema } from './creator-characters.js';

export const CreatorCoverRequestSchema = z.discriminatedUnion('source', [
  z
    .object({
      id: z.string().uuid(),
      source: z.literal('upload'),
      image_base64: z.string().min(1).max(28_000_000),
      mime_type: z.enum(['image/png', 'image/jpeg', 'image/webp']),
    })
    .strict(),
  z
    .object({
      id: z.string().uuid(),
      source: z.literal('artifact'),
      artifact_id: z.string().uuid(),
    })
    .strict(),
]);
export type CreatorCoverRequest = z.infer<typeof CreatorCoverRequestSchema>;
export const CreatorCoverAssetSchema = z.object({
  id: z.string().uuid(),
  image_url: z.string().url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export type CreatorCoverAsset = z.infer<typeof CreatorCoverAssetSchema>;
export interface CreatorCoverData {
  asset: CreatorCoverAsset;
}

export const CreatorPolishTargetSchema = z.enum(['opening', 'background']);
export type CreatorPolishTarget = z.infer<typeof CreatorPolishTargetSchema>;
export const CREATOR_POLISH_LABELS = { opening: '开场白', background: '背景' } as const;
export const CreatorPolishRequestSchema = z
  .object({ target: CreatorPolishTargetSchema, draft: CharacterDraftSchema })
  .strict()
  .superRefine(({ draft }, ctx) => {
    if (
      ![
        draft.name,
        draft.description,
        draft.opening,
        draft.background,
        draft.preset,
        ...draft.backgroundFiles.map((file) => file.content),
        ...draft.presetFiles.map((file) => file.content),
      ].some((text) => text.trim())
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: '先写几句想法，再让 AI 帮你完善。' });
    }
    if (JSON.stringify(draft).length > 200_000)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: '当前资料太长，请精简到20万字以内再润色。',
      });
  });
export type CreatorPolishRequest = z.infer<typeof CreatorPolishRequestSchema>;
export const CreatorPolishEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('done') }),
  z.object({ type: z.literal('error'), message: z.string() }),
]);
export type CreatorPolishEvent = z.infer<typeof CreatorPolishEventSchema>;

/** Only internal editor routes may receive a generated cover. No arbitrary redirect URLs. */
export function parseCreatorCoverReturn(value: string | null | undefined): string | null {
  if (!value || !value.startsWith('/creation/characters/') || value.length > 240) return null;
  try {
    const url = new URL(value, 'https://creator.invalid');
    if (url.origin !== 'https://creator.invalid' || url.hash) return null;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (
      url.pathname === '/creation/characters/new' &&
      uuid.test(url.searchParams.get('draft') ?? '') &&
      [...url.searchParams.keys()].every((key) => key === 'draft')
    )
      return url.pathname + url.search;
    if (
      /^\/creation\/characters\/[0-9a-f-]{36}\/edit$/.test(url.pathname) &&
      uuid.test(url.pathname.split('/')[3] ?? '') &&
      !url.search
    )
      return url.pathname;
  } catch {
    /* Invalid paths never leave the existing studio. */
  }
  return null;
}
