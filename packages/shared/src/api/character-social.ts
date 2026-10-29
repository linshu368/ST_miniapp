import { z } from 'zod';

/** Counts describe the character, never the viewer's private conversation. */
export interface CharacterSocial {
  liked: boolean;
  like_count: number;
  favorite_count: number;
  comment_count: number;
}

export interface CharacterComment {
  id: string;
  /** Stable anonymous name; no Telegram/profile identity is exposed. */
  author: string;
  is_mine: boolean;
  body: string;
  created_at: string;
}

export const SetCharacterLikeSchema = z.object({ liked: z.boolean() }).strict();
export const CreateCharacterCommentSchema = z
  .object({
    /** Keep this UUID when retrying an uncertain submission. */
    id: z.string().uuid(),
    body: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((value) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(value)),
  })
  .strict();
export type CreateCharacterComment = z.infer<typeof CreateCharacterCommentSchema>;
export const ReportCharacterCommentSchema = z
  .object({ reason: z.enum(['inappropriate', 'spam', 'other']) })
  .strict();
export type ReportCharacterComment = z.infer<typeof ReportCharacterCommentSchema>;

export interface GetCharacterSocialData {
  social: CharacterSocial;
}
export interface GetCharacterSocialsData {
  socials: Array<CharacterSocial & { character_id: string }>;
}
export interface GetCharacterCommentsData {
  comments: CharacterComment[];
  next_cursor: string | null;
}
export interface CreateCharacterCommentData {
  comment: CharacterComment;
}
