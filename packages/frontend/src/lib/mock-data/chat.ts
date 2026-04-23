import type { Message, SessionSummary } from '@miniapp/shared';

// 三段跨角色历史，按最近活动倒序
// 时间戳人工铺陈成"今晚 / 昨夜 / 前天夜里"的节奏，便于展示时间格式化
const NOW = Date.now();
const minutesAgo = (n: number) => new Date(NOW - n * 60_000).toISOString();
const hoursAgo = (n: number) => new Date(NOW - n * 3_600_000).toISOString();
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

export const mockSessions: SessionSummary[] = [
  {
    id: 'sess-001',
    character_id: 'char-001',
    character_name: '林枝',
    last_message_preview: '这么晚了还没睡。',
    last_message_at: minutesAgo(12),
  },
  {
    id: 'sess-002',
    character_id: 'char-004',
    character_name: '陆晞',
    last_message_preview: '那你陪我坐一会。',
    last_message_at: hoursAgo(14),
  },
  {
    id: 'sess-003',
    character_id: 'char-003',
    character_name: '周屿',
    last_message_preview: '信就放你那儿吧，别看。',
    last_message_at: daysAgo(4),
  },
];

export const mockMessagesBySession: Record<string, Message[]> = {
  'sess-001': [
    {
      id: 'msg-001-1',
      session_id: 'sess-001',
      role: 'assistant',
      content: '门没锁。',
      created_at: minutesAgo(30),
    },
    {
      id: 'msg-001-2',
      session_id: 'sess-001',
      role: 'user',
      content: '我知道。',
      created_at: minutesAgo(28),
    },
    {
      id: 'msg-001-3',
      session_id: 'sess-001',
      role: 'assistant',
      content: '灯我没关，等你。',
      created_at: minutesAgo(20),
    },
    {
      id: 'msg-001-4',
      session_id: 'sess-001',
      role: 'assistant',
      content: '这么晚了还没睡。',
      created_at: minutesAgo(12),
    },
  ],
  'sess-002': [
    {
      id: 'msg-002-1',
      session_id: 'sess-002',
      role: 'assistant',
      content: '你也睡不着？',
      created_at: hoursAgo(15),
    },
    {
      id: 'msg-002-2',
      session_id: 'sess-002',
      role: 'user',
      content: '嗯。',
      created_at: hoursAgo(14.8),
    },
    {
      id: 'msg-002-3',
      session_id: 'sess-002',
      role: 'assistant',
      content: '那你陪我坐一会。',
      created_at: hoursAgo(14),
    },
  ],
  'sess-003': [
    {
      id: 'msg-003-1',
      session_id: 'sess-003',
      role: 'assistant',
      content: '这封信我一直没写完。',
      created_at: daysAgo(4.2),
    },
    {
      id: 'msg-003-2',
      session_id: 'sess-003',
      role: 'user',
      content: '给谁的？',
      created_at: daysAgo(4.1),
    },
    {
      id: 'msg-003-3',
      session_id: 'sess-003',
      role: 'assistant',
      content: '信就放你那儿吧，别看。',
      created_at: daysAgo(4),
    },
  ],
};

// 发送消息后的 mock 回复池：短促、耳语感、不喧哗
export const mockAssistantReplies: string[] = [
  '嗯。',
  '我在。',
  '……',
  '别说话。',
  '你继续。',
  '再近一点。',
  '我听着。',
  '这一刻先留着。',
];
