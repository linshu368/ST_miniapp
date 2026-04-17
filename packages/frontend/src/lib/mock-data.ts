import type { CharacterSummary, CharacterDetail } from '@miniapp/shared';

export const mockCharacters: CharacterSummary[] = [
  {
    id: 'char-001',
    name: '示例数据',
    description: '用于验证PR自动审查pipeline',
    avatar_url: '',
    tags: ['示例'],
  },
];

export const mockCharacterDetail: CharacterDetail = {
  id: 'char-001',
  name: '示例数据',
  description: '用于验证PR自动审查pipeline',
  avatar_url: '',
  tags: ['示例'],
  greeting: '你好，有什么想聊的？',
  creator_notes: '',
};