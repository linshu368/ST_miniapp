import {
  CharacterWishDetailDataSchema,
  CharacterWishListDataSchema,
  CharacterWishMutationDataSchema,
  CharacterWishResponseDataSchema,
  CharacterWishWithdrawDataSchema,
  type CharacterWishQuery,
  type CreateCharacterWish,
} from '@miniapp/shared';
import { getDomainDb } from '../../lib/supabase.js';
import { resolveCreatorCoverUrl } from '../creator/covers.js';

const TIMEOUT_MS = 8_000;

/** Server identities only: browser roles cannot invoke these privileged feature RPCs. */
export class CharacterWishRepository {
  private get db() {
    return getDomainDb('miniapp_features');
  }

  async list(userId: string, query: CharacterWishQuery) {
    const { data, error } = await this.db
      .rpc('list_character_wishes', {
        p_user_id: userId,
        p_scope: query.scope,
        p_sort: query.sort,
        p_page: query.page,
        p_page_size: query.page_size,
      })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (error) throw error;
    return CharacterWishListDataSchema.parse(data);
  }

  async get(userId: string, wishId: string) {
    const { data, error } = await this.db
      .rpc('read_character_wish', { p_user_id: userId, p_wish_id: wishId })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (error) throw error;
    const detail = CharacterWishDetailDataSchema.parse(data);
    detail.cards = await Promise.all(
      detail.cards.map(async (card) => {
        const assetId = card.cover_url?.startsWith('creator-cover:')
          ? card.cover_url.slice('creator-cover:'.length)
          : null;
        // Card authorization happened in the read RPC. A failed image must not hide the wish.
        return assetId
          ? { ...card, cover_url: await resolveCreatorCoverUrl(assetId).catch(() => null) }
          : card;
      })
    );
    return detail;
  }

  private async mutate(
    userId: string,
    wishId: string,
    action: 'create' | 'support' | 'withdraw' | 'respond',
    payload: Record<string, unknown>
  ) {
    const { data, error } = await this.db
      .rpc('mutate_character_wish', {
        p_user_id: userId,
        p_wish_id: wishId,
        p_action: action,
        p_payload: payload,
      })
      .abortSignal(AbortSignal.timeout(TIMEOUT_MS));
    if (error) throw error;
    return data;
  }

  async create(userId: string, input: CreateCharacterWish) {
    return CharacterWishMutationDataSchema.parse(
      await this.mutate(userId, input.id, 'create', {
        body: input.body,
        visibility: input.visibility,
      })
    );
  }

  async setSupported(userId: string, wishId: string, supported: boolean) {
    return CharacterWishMutationDataSchema.parse(
      await this.mutate(userId, wishId, 'support', { supported })
    );
  }

  async withdraw(userId: string, wishId: string) {
    return CharacterWishWithdrawDataSchema.parse(await this.mutate(userId, wishId, 'withdraw', {}));
  }

  async linkResponse(input: { userId: string; wishId: string; characterId: string }) {
    return CharacterWishResponseDataSchema.parse(
      await this.mutate(input.userId, input.wishId, 'respond', {
        character_id: input.characterId,
      })
    );
  }
}
