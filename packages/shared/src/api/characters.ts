// 列表页用的精简结构
export interface CharacterSummary {
    id: string;
    name: string;
    description: string;
    avatar_url: string;
    tags: string[];
  }
  
  // 详情页 / 对话页用的完整结构
  export interface CharacterDetail extends CharacterSummary {
    greeting: string;
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