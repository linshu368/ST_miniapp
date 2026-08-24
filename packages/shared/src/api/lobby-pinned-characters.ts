import { z } from 'zod';

import { LOBBY_FEATURED_POSITION_COUNT } from '../lobby-featured';

/**
 * 首页「推荐」页的运营固定位。
 *
 * v3 排序把「运营固定前八」整个去掉了，前八完全由 D30/R48 分数跑出来。这解决了旧版
 * 靠人肉排位的问题，但也让运营没法做「这周主推哪八张」——而主推位是有真实运营需求的。
 * 本配置把固定位还回来，同时不动第九张起的 v3 排序。
 *
 * 存 id 不存位次：位次会随任何一次角色卡布局调整漂移，运营点选的是具体那张卡。
 */

/** 固定位上限＝金框位数。配到第 9 张就会有卡拿不到金框，位置和样式对不上 */
export const LOBBY_MAX_PINNED_CHARACTERS = LOBBY_FEATURED_POSITION_COUNT;

export const LobbyPinnedCharactersSchema = z.object({
  /**
   * 按展示顺序排列的角色卡 id，占据推荐列表最前面的几个位置。
   *
   * 空数组 = 不固定，退回纯 v3 排序，同时也是这个功能的关闭开关。
   * 不校验 id 是否真的存在：卡可能被下架或归档，读路径按「不在候选池里就跳过」处理，
   * 所以配置里留着一张已下架的卡不会把首页打空，只是少一个固定位。
   */
  character_ids: z
    .array(z.string().uuid())
    .max(LOBBY_MAX_PINNED_CHARACTERS)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: '固定位不能重复放同一张卡',
    }),
});

export type LobbyPinnedCharacters = z.infer<typeof LobbyPinnedCharactersSchema>;

export const LOBBY_PINNED_CHARACTERS_CONFIG_KEY = 'lobby_pinned_characters';

export const DEFAULT_LOBBY_PINNED_CHARACTERS: LobbyPinnedCharacters = {
  character_ids: [],
};
