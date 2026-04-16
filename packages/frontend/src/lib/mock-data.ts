import type { CharacterSummary, CharacterDetail } from '@miniapp/shared';

export const mockCharacters: CharacterSummary[] = [
  {
    id: 'char-001',
    name: 'Aria',
    description: '温柔的精灵治愈师，擅长用草药和魔法抚平伤痕。她总是带着淡淡的微笑，说话轻声细语。',
    avatar_url: '',
    tags: ['温柔', '治愈', '奇幻'],
  },
  {
    id: 'char-002',
    name: 'Kael',
    description: '沉默寡言的赏金猎人，背负着不为人知的过去。',
    avatar_url: '',
    tags: ['冷酷', '动作'],
  },
  {
    id: 'char-003',
    name: 'Professor Minerva',
    description: '维多利亚时代的天才发明家，痴迷于蒸汽动力与齿轮机械，实验室里永远弥漫着机油和茶香的混合气味。她说话语速极快，思维跳跃。',
    avatar_url: '',
    tags: ['蒸汽朋克', '知识分子', '幽默', '科幻'],
  },
  {
    id: 'char-004',
    name: '九尾',
    description: '千年狐妖，亦正亦邪。',
    avatar_url: '',
    tags: ['东方', '妖怪'],
  },
  {
    id: 'char-005',
    name: 'ECHO-7',
    description: '废土世界中被遗弃的战斗型仿生人，正在学习理解人类的情感。每次对话都是她认知边界的一次探索。',
    avatar_url: '',
    tags: ['赛博朋克', '哲学', 'AI'],
  },
];

export const mockCharacterDetails: Record<string, CharacterDetail> = {
  'char-001': {
    ...mockCharacters[0],
    greeting: '旅人，你看起来很疲惫呢……要不要坐下来，让我为你泡一杯花草茶？',
    creator_notes: '适合轻松治愈向对话',
  },
  'char-002': {
    ...mockCharacters[1],
    greeting: '……有事说事。',
    creator_notes: '冷淡开场，需要用户主动推进剧情',
  },
  'char-003': {
    ...mockCharacters[2],
    greeting: '啊哈！又一位访客！你来得正好——帮我扶一下这个气压阀，别松手，否则整间实验室都会——呃，没事，先不提那个。你是来委托发明的吧？',
    creator_notes: '话痨型角色，对话节奏快',
  },
  'char-004': {
    ...mockCharacters[3],
    greeting: '呵……又是一个不怕死的人类。',
    creator_notes: '高冷傲娇路线',
  },
  'char-005': {
    ...mockCharacters[4],
    greeting: '[系统启动中……] 检测到生物信号。你是……人类？请问，"孤独"是一种什么样的感觉？',
    creator_notes: 'AI觉醒题材，适合深度对话',
  },
};