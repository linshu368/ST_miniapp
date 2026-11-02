import { z } from 'zod';

export const CHARACTER_WISH_MAX_LENGTH = 500;
export const CharacterWishVisibilitySchema = z.literal('public');
export const CharacterWishQuerySchema = z
  .object({
    scope: z.enum(['public', 'mine']).default('public'),
    sort: z.enum(['newest', 'popular']).default('newest'),
    page: z.coerce.number().int().min(1).max(10000).default(1),
    page_size: z.coerce.number().int().min(1).max(20).default(12),
  })
  .strict();
export type CharacterWishQuery = z.infer<typeof CharacterWishQuerySchema>;
export const CreateCharacterWishSchema = z
  .object({
    id: z.string().uuid(),
    body: z.string().trim().min(1, '写下你想玩什么样的角色').max(CHARACTER_WISH_MAX_LENGTH),
    visibility: CharacterWishVisibilitySchema,
  })
  .strict();
export type CreateCharacterWish = z.infer<typeof CreateCharacterWishSchema>;
export const SupportCharacterWishSchema = z.object({ supported: z.boolean() }).strict();
export const RespondCharacterWishSchema = z.object({ character_id: z.string().uuid() }).strict();
export const CharacterWishCardSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  description: z.string(),
  cover_url: z.string().nullable(),
});
export const CharacterWishSchema = z.object({
  id: z.string().uuid(),
  body: z.string(),
  visibility: CharacterWishVisibilitySchema,
  created_at: z.string(),
  is_mine: z.boolean(),
  supported: z.boolean(),
  /** Includes the person who wrote the wish; each other viewer can join once. */
  wanted_count: z.number().int().nonnegative(),
  response_count: z.number().int().nonnegative(),
});
export type CharacterWish = z.infer<typeof CharacterWishSchema>;
export type CharacterWishCard = z.infer<typeof CharacterWishCardSchema>;
export const CharacterWishListDataSchema = z.object({
  items: z.array(CharacterWishSchema),
  page: z.number().int().min(1),
  page_size: z.number().int().min(1).max(20),
  total: z.number().int().nonnegative(),
});
export type CharacterWishListData = z.infer<typeof CharacterWishListDataSchema>;
export const CharacterWishDetailDataSchema = z.object({
  wish: CharacterWishSchema,
  cards: z.array(CharacterWishCardSchema),
});
export type CharacterWishDetailData = z.infer<typeof CharacterWishDetailDataSchema>;
export const CharacterWishMutationDataSchema = z.object({ wish: CharacterWishSchema });
export const CharacterWishResponseDataSchema = z.object({ linked: z.literal(true) });
export const CharacterWishWithdrawDataSchema = z.object({ withdrawn: z.literal(true) });
