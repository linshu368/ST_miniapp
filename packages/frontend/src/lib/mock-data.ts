import type { CharacterSummary, CharacterDetail } from '@miniapp/shared';

export const mockCharacters: CharacterSummary[] = [
  {
    id: 'char-001',
    name: '示例角色',
    description: '这是一个用于验证框架的示例角色',
    avatar_url: '',
    tags: ['示例'],
  },
];

export const mockCharacterDetail: CharacterDetail = {
  id: 'char-001',
  name: '示例角色',
  description: '这是一个用于验证框架的示例角色',
  avatar_url: '',
  tags: ['示例'],
  greeting: '你好，有什么想聊的？',
  creator_notes: '',
};