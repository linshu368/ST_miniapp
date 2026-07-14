/** 大厅固定前八角色。顺序即最终展示顺序，UUID 与各环境角色数据保持一致。 */
export const LOBBY_FEATURED_CHARACTER_IDS = [
  'e8f83f2b-8966-41fc-8bb3-f2eeb872fece', // 秦若岚
  '4caa9b65-0e20-42be-809a-d5d5ecf0b096', // 追夫火葬场
  '04568b85-2578-4f80-9834-fc98d09a2b3a', // 人权崩坏
  'e576e2a7-e26e-4780-bfb2-bee0df0ca1e6', // 重生小学时代
  '7fe07b78-3ca7-439c-99a9-9869b50b9dc5', // 独自起飞
  'ec9ac155-9018-4569-9730-133ec4688dd1', // 清纯女大包养日记
  '0135ebfe-6d1d-4f2f-b67d-eb5bf39aa623', // 伊莉丝
  '4259f0f6-57fa-463f-b341-045560d21d61', // 冰山青梅竹马
] as const;

const FEATURED_ID_SET = new Set<string>(LOBBY_FEATURED_CHARACTER_IDS);

export function isLobbyFeaturedCharacter(characterId: string): boolean {
  return FEATURED_ID_SET.has(characterId);
}

export function partitionLobbyCharacters<T extends { id: string }>(
  characters: readonly T[]
): { featured: T[]; others: T[] } {
  const byId = new Map(characters.map((character) => [character.id, character]));
  const featured = LOBBY_FEATURED_CHARACTER_IDS.flatMap((id) => {
    const character = byId.get(id);
    return character ? [character] : [];
  });
  const others = characters.filter((character) => !FEATURED_ID_SET.has(character.id));
  return { featured, others };
}
