// 列表页用的精简结构
export interface CharacterSummary {
  id: string;
  name: string;
  /** 角色一句话氛围描述，卡片上截断展示 */
  description: string;
  avatar_url: string;
  /** 性格/特质标签，3-5 个，卡片和详情页都展示 */
  personality_tags: string[];
  /** 创作者展示名 */
  author_name: string;
  /** 是否属于大厅固定前八角色 */
  is_featured: boolean;
}

// 详情页 / 对话页用的完整结构
export interface CharacterDetail extends CharacterSummary {
  /** 角色开场第一句话 */
  greeting: string;
  /** 创作者写给读者的补充说明（可为空） */
  creator_notes: string;
}

// GET /api/characters 的响应体
export interface GetCharactersData {
  characters: CharacterSummary[];
}

// GET /api/characters/:id 的响应体
export interface GetCharacterByIdData {
  character: CharacterDetail;
}
