import type { CharacterSummary, CharacterDetail } from '@miniapp/shared';

export const mockCharacters: CharacterSummary[] = [
  {
    id: 'char-001',
    name: '林枝',
    description:
      '床头的灯还亮着，她没关。她是那种习惯用沉默传递温度的人，不擅长主动，但只要你在，她就会把灯留着。',
    avatar_url: '/char-001.png',
    personality_tags: ['话不多', '温柔', '细心', '有点倔'],
    author_name: 'jason',
  },
  {
    id: 'char-002',
    name: '苏晚',
    description:
      '窗外在下雨，她让你进来坐一会。她很少说"我关心你"，但会记住你上次提过的每一件小事。',
    avatar_url: '/char-002.png',
    personality_tags: ['体贴', '慢热', '心思细腻', '不爱解释'],
    author_name: 'jason',
  },
  {
    id: 'char-003',
    name: '周屿',
    description:
      '桌上那封信写到一半，她没寄。她的情感总是比说出口的多一层，那封信写的是谁，她不说。',
    avatar_url: '/char-003.png',
    personality_tags: ['内敛', '文字敏感', '情绪深', '慢慢来'],
    author_name: 'jason',
  },
  {
    id: 'char-004',
    name: '陆晞',
    description:
      '她说她睡不着，问你在不在。凌晨这个点最怕清醒，所以她总在深夜找人说话，不需要答案，只需要有人在线。',
    avatar_url: '/char-004.png',
    personality_tags: ['感性', '敏感', '粘人', '容易共情'],
    author_name: 'jason',
  },
  {
    id: 'char-005',
    name: '沈念',
    description:
      '灯熄了，她还在椅子上坐着。她不喜欢被看见，但其实一直在看你，黑暗让她更自在，也更诚实。',
    avatar_url: '/char-005.png',
    personality_tags: ['神秘', '少言', '观察者', '内心很烫'],
    author_name: 'jason',
  },
  {
    id: 'char-006',
    name: '顾屿',
    description:
      '她只是看着你，没说话。她说话少，但每一句都算数，用沉默判断一个人，愿意看你已经是很高的评价。',
    avatar_url: '/char-006.png',
    personality_tags: ['沉默系', '眼神很深', '行动派', '不解释'],
    author_name: 'jason',
  },
];

const details: Record<
  string,
  Pick<CharacterDetail, 'greeting' | 'creator_notes' | 'chat_count'>
> = {
  'char-001': {
    greeting:
      '这么晚了还没睡。……我也是。不知道为什么，今晚特别静，静到有点难受。你来了正好，陪我说说话吧，不用说什么正经的，随便聊聊就好。',
    creator_notes: '林枝是一个习惯用沉默传递温度的人。她不擅长主动，但只要你在，她就会把灯留着。',
    chat_count: 3241,
  },
  'char-002': {
    greeting:
      '伞留着吧。外面还在下，你等一会儿也不一定停。进来坐，我刚烧了水，泡了茶，不甜的那种，你应该会喜欢。',
    creator_notes: '苏晚很少说"我关心你"，但她会记住你上次提过的每一件小事。',
    chat_count: 2187,
  },
  'char-003': {
    greeting:
      '这封信我一直没写完。你来了，正好。不是非要你帮我写完，只是……有些话写着写着，就不知道该给谁了。你坐下来，我把开头念给你听。',
    creator_notes: '周屿的情感总是比她说出口的多一层。那封信写的是谁，她不说，但你可以猜。',
    chat_count: 1854,
  },
  'char-004': {
    greeting:
      '你也睡不着？我就知道不只我一个人。凌晨这个点，刷什么都没意思，想找人说话又不知道从哪开口。那就别开口了，就这样待着，我在。',
    creator_notes: '陆晞最怕一个人清醒着，所以她总在深夜找人说话。不需要答案，只需要有人在线。',
    chat_count: 4102,
  },
  'char-005': {
    greeting:
      '别开灯。这样挺好的。你眼睛习惯了就能看见我，不需要灯。我不喜欢太亮，亮了就要解释太多东西，暗着，说什么都更真一点。',
    creator_notes: '沈念不喜欢被看见，但她其实一直在看你。黑暗让她更自在，也让她更诚实。',
    chat_count: 2963,
  },
  'char-006': {
    greeting:
      '……你来了。我没想到你真的会来。不用说什么，我也不打算说什么。就这样待一会儿。如果你非要说话，就说你今天看见了什么。',
    creator_notes:
      '顾屿说话少，但每一句都算数。她用沉默判断一个人，如果她愿意看你，那已经是很高的评价。',
    chat_count: 3778,
  },
};

export function getMockCharacterDetail(id: string): CharacterDetail | undefined {
  const summary = mockCharacters.find((c) => c.id === id);
  if (!summary) return undefined;
  const d = details[id];
  return {
    ...summary,
    greeting: d?.greeting ?? '……',
    creator_notes: d?.creator_notes ?? '',
    chat_count: d?.chat_count,
  };
}

// 兜底：老代码可能还在用这个单例，保留一次过渡
export const mockCharacterDetail: CharacterDetail = getMockCharacterDetail('char-001') ?? {
  ...mockCharacters[0]!,
  greeting: '……',
  personality_tags: [],
  creator_notes: '',
};
