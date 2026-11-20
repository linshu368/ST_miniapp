import {
  DEFAULT_PAYMENT_CHANNELS_CONFIG,
  DEFAULT_WORD_COUNT_TIERS_CONFIG,
  GetImagePlazaConfigDataSchema,
  GetModelCatalogDataSchema,
  ImagePlazaWorkSchema,
  PlazaVideoWorkSchema,
  PublicDriveModesSchema,
  toPublicWordCountTiers,
  UserGenerationConfigSchema,
  UserSettingsSchema,
  VipStatusSchema,
  type CharacterDetail,
  type ChatMessage,
  type ChatSession,
  type DramaDetail,
  type GetPaymentPlansData,
  type GetVoiceConfigData,
  type GetWalletBalanceData,
  type ImagePlazaConversation,
} from '@miniapp/shared';
import { FREE_ZONE_SCENARIOS } from './free-zone.js';

export const IDS = {
  character: '10000000-0000-4000-8000-000000000001',
  session: '20000000-0000-4000-8000-000000000001',
  work: '30000000-0000-4000-8000-000000000001',
  videoWork: '30000000-0000-4000-8000-000000000002',
  studio: '40000000-0000-4000-8000-000000000001',
} as const;
export const stamp = () => new Date().toISOString();
export const later = () => new Date(Date.now() + 31 * 86_400_000).toISOString();

export const publicCreatorFixture = {
  id: '71000000-0000-4000-8000-000000000001',
  nickname: '预览创作者',
  characterIds: [IDS.character, '10000000-0000-4000-8000-000000000002'],
};

export const WISH_IDS = {
  adventure: 'a1000000-0000-4000-8000-000000000001',
  detective: 'a1000000-0000-4000-8000-000000000002',
  minePublic: 'a1000000-0000-4000-8000-000000000003',
  mineGarden: 'a1000000-0000-4000-8000-000000000004',
  notification: 'a2000000-0000-4000-8000-000000000001',
  ownCard: 'a3000000-0000-4000-8000-000000000001',
} as const;

export const scenarios = {
  'spending-video': {
    label: '视频消费与退款明细',
    description: '同一虚构任务的预扣和原路退回，核对正负号、通用/专项与只读余额',
    path: '/profile/spending',
  },
  'image-masonry': {
    label: '影像广场多页瀑布流',
    description: '60条虚构图片/视频，横竖比例混合、三页加载与媒体筛选',
    path: '/create',
  },
  'new-user': {
    label: '新人主线引导',
    description: '选角色、第一句话、编辑与分支、返回找对话；可跳过（虚构新账号）',
    path: '/characters',
  },
  'new-user-replied': {
    label: '新人编辑与分支',
    description: '已有第一轮回复，点击玩法提示可定位真实编辑和分支入口',
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'new-user-near-creator': {
    label: '新人创作邀请 · 第9轮',
    description: '累计9轮，再完成一轮并结束基础引导，返回推荐可看到创作福利邀请',
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'new-user-creator-ready': {
    label: '新人创作邀请 · 满10轮',
    description: '累计10轮，仅已入组且结束基础引导的用户主动返回推荐才会受邀',
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'onboarding-error': {
    label: '引导不可用',
    description: '资格读取失败，不影响角色浏览与发送',
    path: '/characters',
  },
  wishes: {
    label: '角色心愿墙',
    description: '匿名公开许愿、我的心愿、支持、用作品回应与站内通知（虚构数据）',
    path: '/wishes',
  },
  'wishes-response-error': {
    label: '作品回应失败恢复',
    description: '角色已公开，心愿关联首次失败，可单独重新回应',
    path: '/wishes',
  },
  'wishes-error': {
    label: '心愿提交失败',
    description: '首次提交失败保留输入，再次提交成功；同 UUID 重试不重复',
    path: '/wishes',
  },
  'lobby-rotation': {
    label: '推荐优质轮换',
    description: '36张虚构角色，24小时轮换、换一批、撤回与试聊返回',
    path: '/characters',
  },
  'lobby-rotation-error': {
    label: '换批失败恢复',
    description: '首次手动换批失败，保留原列表并可重试',
    path: '/characters',
  },
  'lobby-rotation-lost-response': {
    label: '换批丢响应',
    description: '批次已经更换但响应失败，同请求重试不多换一次',
    path: '/characters',
  },
  'creator-data': {
    label: '创作数据',
    description: '多角色总览、单卡表现、奖励明细与玩家反馈（本地示例）',
    path: '/creation/data',
  },
  'creator-data-empty': {
    label: '创作数据为空',
    description: '暂无作品与奖励，可返回创作',
    path: '/creation/data?state=empty',
  },
  'creator-data-error': {
    label: '创作数据读取失败',
    description: '重试后恢复，不把失败显示为零',
    path: '/creation/data?state=error',
  },
  creation: {
    label: '创作与我的空间',
    description: '创作编辑、封面回流、草稿、发布、私密切换与角色试聊',
    path: '/creation',
  },
  'creator-polish-partial': {
    label: '角色润色中断',
    description: '保留部分内容，可采用、编辑、撤回',
    path: '/creation/characters/new',
  },
  'creator-polish-stop': {
    label: '主动停止角色润色',
    description: '开场白停在第一段，背景停在首字前，可手动停止生成',
    path: '/creation/characters/new',
  },
  'creator-save-error': {
    label: '角色发布失败',
    description: '草稿保留并可重试，不重复创建',
    path: '/creation/characters/new',
  },
  'creator-review-rejected': {
    label: '角色公开审核未通过',
    description: '显示具体原因、保留原稿；修改后可重试，已公开卡更新被拒绝时保留旧版',
    path: '/creation/characters/new',
  },
  'creator-review-unavailable': {
    label: '角色审核暂不可用',
    description: '模拟模型回包格式错误，不放行，原稿保留并可重试',
    path: '/creation/characters/new',
  },

  standard: {
    label: '普通用户',
    description: '签到、会员引导、角色和影像完整路径',
    path: '/profile',
  },
  'vip-mixed': {
    label: 'VIP混合奖励',
    description: '120专项＋30通用签到，月卡2000专项＋1000通用',
    path: '/profile',
  },
  vip: { label: '已开通 VIP', description: '会员身份、每日 150 星尘、续费入口', path: '/profile' },
  recharge: {
    label: '星尘充值',
    description: '四档虚构套餐、到账明细、VIP搭配与支付失败反馈',
    path: '/profile/recharge',
  },
  'recharge-error': {
    label: '充值加载失败',
    description: '重试、订单和客服仍可访问',
    path: '/profile/recharge',
  },
  'recharge-empty': {
    label: '暂无充值套餐',
    description: '空态不创建订单',
    path: '/profile/recharge',
  },
  'recharge-unavailable': {
    label: '支付渠道关闭',
    description: '可查看套餐、禁止下单',
    path: '/profile/recharge',
  },

  'character-social': {
    label: '角色互动',
    description: '点赞、已有收藏、公开评论、分页与跨页面状态同步',
    path: '/characters',
  },
  'character-interaction-error': {
    label: '角色互动失败',
    description: '点赞和收藏失败恢复、评论丢响应后的草稿与幂等重试',
    path: '/characters',
  },
  dramas: {
    label: '短剧体验',
    description: '沉浸刷剧、收藏、点赞、评论、选集和本设备续看',
    path: '/watch',
  },
  'drama-interaction-error': {
    label: '短剧互动失败',
    description: '点赞失败恢复、评论草稿保留、重试不重复',
    path: '/watch',
  },
  'drama-list-error': {
    label: '短剧列表失败',
    description: '目录读取失败与重试入口',
    path: '/dramas',
  },
  'drama-play-error': {
    label: '短剧播放失败',
    description: '视频地址失败，保留重试和换剧',
    path: '/dramas',
  },
  checked: { label: '今日已签到', description: '已领取状态及会员引导', path: '/profile' },
  'checkin-error': { label: '签到失败', description: '失败反馈与再次操作', path: '/profile' },
  'vip-error': { label: '权益暂不可读', description: '不展示未经确认的会员收益', path: '/profile' },
  'growth-community': {
    label: '增长弹窗 · 进群',
    description: '累计 13 轮，聊天页弹出进群礼券；点主按钮后社群入口改报已领取，回到页面提示到账',
    path: `/chat/${IDS.character}?session=${IDS.session}&from=chats`,
  },
  'growth-vip': {
    label: '增长弹窗 · VIP',
    description: '累计 50 轮，对话页弹出 VIP 月卡礼券；主按钮进入 VIP 支付页',
    path: '/chats',
  },
  'community-joined': {
    label: '社群奖励已领取',
    description: '官方社群入口隐藏',
    path: '/profile',
  },
  empty: { label: '空列表', description: '角色、对话与影像的空状态', path: '/characters' },
  'chat-slow': {
    label: '慢速思考',
    description: '先显示思考，正文开始后自动折叠',
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'chat-surplus': {
    label: 'Surplus Intelligence 聊天',
    description: '虚构 Surplus 模型目录、发送、重答与取消；不连接供应商',
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'chat-surplus-fallback': {
    label: 'Surplus Intelligence 兜底',
    description: '模拟 Surplus 主调用慢、OpenRouter 兜底交付；原模型选择保持',
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'free-zone': {
    ...FREE_ZONE_SCENARIOS['free-zone'],
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'free-zone-not-started': {
    ...FREE_ZONE_SCENARIOS['free-zone-not-started'],
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'free-zone-own-card': {
    ...FREE_ZONE_SCENARIOS['free-zone-own-card'],
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'free-zone-replaced': {
    ...FREE_ZONE_SCENARIOS['free-zone-replaced'],
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'free-zone-vip-offer': { ...FREE_ZONE_SCENARIOS['free-zone-vip-offer'], path: '/profile' },
  'free-zone-vip-member': { ...FREE_ZONE_SCENARIOS['free-zone-vip-member'], path: '/profile' },
  'chat-late-first-token': {
    label: '首字迟到',
    description: '客户端计时到点只提示网络慢，回复到达后提示消失，不误报重试',
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'chat-folders': {
    label: '对话分组与整理',
    description: '32 段对话、多角色多段、2 个分组，含只聊一两句与 30 天没聊',
    path: '/chats',
  },
  'chat-sessions': {
    label: '同角色多段对话',
    description: '日期区分、长名称、分支来源、当前对话和收纳管理',
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'chat-edit': {
    label: '消息编辑与删除',
    description: '12轮对话，最近10轮可局部修改，其他分支保留',
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'chat-edit-error': {
    label: '消息保存失败',
    description: '首次失败保留草稿，再次保存成功',
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'chat-branch': {
    label: '历史对话分支',
    description: '200轮虚构对话，从早期或近期回复开启独立分支',
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'chat-branch-error': {
    label: '分支失败恢复',
    description: '创建已完成但响应丢失，同请求重试不重复创建',
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'chat-like-error': {
    label: '回复点赞失败',
    description: '即时点亮、保存失败恢复与再次点赞，不打断输入',
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'chat-error': {
    label: '聊天生成失败',
    description: '失败与重新生成入口',
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'chat-partial-error': {
    label: '文字与失败同批返回',
    description: '已收到的文字保留，首字只确认一次',
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'no-balance': {
    label: '余额不足',
    description: '聊天、影像的余额不足提示',
    path: `/chat/${IDS.character}?session=${IDS.session}&from=discover`,
  },
  'image-error': {
    label: '图片生成失败',
    description: '失败反馈、重试与未扣除提示',
    path: `/create/studio/${IDS.studio}`,
  },
  'image-pending': {
    label: '图片生成中',
    description: '等待、返回广场、记录回读',
    path: `/create/studio/${IDS.studio}`,
  },
} as const;
export type Scenario = keyof typeof scenarios;
export function isScenario(value: unknown): value is Scenario {
  return typeof value === 'string' && Object.hasOwn(scenarios, value);
}

export const CHAT_SESSION_IDS = {
  earlier: '20000000-0000-4000-8000-000000000002',
  named: '20000000-0000-4000-8000-000000000003',
  branch: '20000000-0000-4000-8000-000000000004',
  namedBranch: '20000000-0000-4000-8000-000000000005',
} as const;
export const LONG_SESSION_TITLE = '雨夜重逢后一起寻找山谷尽头的那封信';

/** 固定创建时间使默认标题可复验；内容只用于本机虚构场景。 */
export function makeChatSessionSamples(base: ChatSession): ChatSession[] {
  const samples = [
    { id: IDS.session, title: '林间旅人', day: 2, preview: '沿着小径，一起出发吧。' },
    { id: CHAT_SESSION_IDS.earlier, title: '林间旅人', day: 1, preview: '我们约好明天再来。' },
    {
      id: CHAT_SESSION_IDS.named,
      title: LONG_SESSION_TITLE,
      day: 3,
      preview: '信封上留着熟悉的字迹。',
    },
    {
      id: CHAT_SESSION_IDS.branch,
      title: '分支 · 林间旅人',
      day: 4,
      preview: '这次选择另一条路。',
    },
    {
      id: CHAT_SESSION_IDS.namedBranch,
      title: '分支 · 雨夜的约定',
      day: 5,
      preview: '雨停以前，我们还会再见。',
    },
  ];
  return samples.map((sample) => {
    const createdAt = new Date(Date.UTC(2026, 10, sample.day, 14, 18)).toISOString();
    return {
      ...base,
      id: sample.id,
      title: sample.title,
      created_at: createdAt,
      updated_at: createdAt,
      last_message_at: createdAt,
      last_message_preview: sample.preview,
      pinned_at:
        sample.id === CHAT_SESSION_IDS.named
          ? new Date(Date.now() - 86_400_000).toISOString()
          : null,
      ...(sample.id === CHAT_SESSION_IDS.branch || sample.id === CHAT_SESSION_IDS.namedBranch
        ? { branch: { source_session_id: IDS.session, source_turn_index: 20, inherited_turns: 20 } }
        : {}),
    };
  });
}

export function makeData(api: string, characterCount = 18) {
  const now = stamp();
  const dramas: DramaDetail[] = (
    [
      ['雾城来信', '悬疑'],
      ['长安月未央', '古风'],
      ['星期五的告白', '恋爱'],
      ['星海之外', '科幻'],
      ['今天也要笑', '喜剧'],
      ['山间有晴', '治愈'],
      ['回到昨天的便利店', '脑洞'],
      ['借你一场夏天', '恋爱'],
      ['无人到站', '悬疑'],
      ['晚风不迟', '治愈'],
      ['她的第七封信', '古风'],
      ['时光旅人', '科幻'],
    ] as const
  ).map(([title, category], index) => ({
    id: `60000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    title,
    tags:
      index === 0
        ? ['悬疑', '剧情反转', '双向试探', '久别重逢', '身份谜团', '层层揭开真相']
        : index === 1
          ? ['古风', '宫廷故事', '克制心动', '棋逢对手', '暗藏心事']
          : index === 2
            ? ['恋爱', '双向暗恋', '青春校园', '甜蜜日常']
            : index === 3
              ? [
                  '科幻',
                  '跨越星海寻找失落的记忆',
                  '时空交错',
                  '未知文明',
                  '命运重逢',
                  '星际冒险',
                  '温柔守护',
                  '寻找答案',
                ]
              : index === 9
                ? []
                : [category, index % 2 ? '温暖故事' : '剧情反转'],
    description: `${title}：一次意外的相遇，让平静的生活有了新的方向。本地预览示例，用于体验列表、播放、选集和返回。`,
    cover_url: `${api}/assets/scene.svg?tone=${index % 3}`,
    first_published_at: new Date(Date.UTC(2026, 9, 27 - index)).toISOString(),
    // 保留前几部短素材，最后一部覆盖窄屏长选集与跨分组定位。
    episode_count: index === 4 ? 1 : index === 11 ? 66 : 8 + index,
    duration_seconds: index === 4 ? 5 : null,
    videos: Array.from(
      { length: index === 4 ? 1 : index === 11 ? 66 : 8 + index },
      (_, episode) => ({
        id: `70000000-0000-4000-8000-${String(index * 100 + episode + 1).padStart(12, '0')}`,
        title: `第 ${episode + 1} 集`,
        tags: [],
        description: '',
        episode: String(episode + 1),
        playable: true,
      })
    ),
  }));
  const characters: CharacterDetail[] = Array.from({ length: characterCount }, (_, index) => ({
    id:
      index === 0
        ? IDS.character
        : `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name: index === 0 ? '林间旅人' : `故事旅人 ${index + 1}`,
    description: '沿着森林小径，开启一段轻松的冒险。',
    avatar_url: `${api}/assets/scene.svg?tone=${index % 3}`,
    personality_tags: ['冒险', '温暖'],
    author_name: index < 2 ? '' : '平台作品',
    is_featured: index < 4,
    greeting: '「你也在找通往山谷的路吗？」旅人收起地图，微笑着为你留出位置。',
    creator_notes: '本地验收用的虚构角色，不关联线上内容。',
  }));
  const session: ChatSession = {
    id: IDS.session,
    character_id: IDS.character,
    title: '林间旅人',
    last_message_at: now,
    last_message_preview: '沿着小径，一起出发吧。',
    message_count: 3,
    pinned_at: null,
    created_at: now,
    updated_at: now,
  };
  const messages: ChatMessage[] = [
    {
      id: '50000000-0000-4000-8000-000000000001',
      session_id: IDS.session,
      turn_index: 0,
      revision: 1,
      role: 'assistant',
      content: characters[0]!.greeting,
      status: 'complete',
      error_code: null,
      finish_reason: 'stop',
      model_id: null,
      created_at: now,
    },
    {
      id: '50000000-0000-4000-8000-000000000002',
      session_id: IDS.session,
      turn_index: 1,
      revision: 1,
      role: 'user',
      content: '我们一起出发吧。',
      status: 'complete',
      error_code: null,
      finish_reason: null,
      model_id: null,
      created_at: now,
    },
    {
      id: '50000000-0000-4000-8000-000000000003',
      session_id: IDS.session,
      turn_index: 1,
      revision: 1,
      role: 'assistant',
      content: '「当然。」旅人指向林间的小径，等你决定下一步。',
      status: 'complete',
      error_code: null,
      finish_reason: 'stop',
      model_id: 'preview-light',
      created_at: now,
    },
  ];
  const generation = {
    config: UserGenerationConfigSchema.parse({
      selected_model_id: 'preview-light',
      pref_word_count: '300-500',
      pref_show_options: true,
      pref_show_status: true,
      pref_show_memory: false,
      pref_reply_styles: {},
      pref_drive_mode: 'active',
      pref_custom_instructions: null,
    }),
    word_count_tiers: toPublicWordCountTiers(DEFAULT_WORD_COUNT_TIERS_CONFIG),
    // 虚构文案，只验证界面消费公开字段；正式名称和说明由运营配置。
    drive_modes: PublicDriveModesSchema.parse({
      modes: [
        { id: 'follow', ui_label: '我来带', description: '你说一句，TA 接一句，剧情只听你的。' },
        {
          id: 'active',
          ui_label: '等 TA 撩',
          description: 'TA 会主动撩你、提要求，不用你一直找话。',
        },
        {
          id: 'plot',
          ui_label: '来点意外',
          description: '时不时出点事、来个新人，故事自己往前走。',
        },
        { id: 'novel', ui_label: '替我演', description: '你只管定方向，连你的戏份也一起写好。' },
      ],
      default_mode_id: 'active',
    }),
    reply_style_options: [
      { id: 'style-dialogue', name: '角色多说话', description: '以角色对白为主，减少环境旁白。' },
      { id: 'style-concise', name: '节奏紧凑', description: '保持简洁，让对话自然向前。' },
    ],
  };
  const settings = UserSettingsSchema.parse({
    display_name: '预览体验官',
    avatar_url: `${api}/assets/scene.svg`,
    avatar_source: 'custom',
    pref_word_count: '300-500',
    pref_show_options: true,
    pref_show_status: true,
    pref_show_memory: false,
    pref_custom_instructions: null,
    updated_at: now,
  });
  const vip = VipStatusSchema.parse({
    active: false,
    valid_from: null,
    valid_until: null,
    remaining_days: 0,
    last_plan_id: null,
    entry_badge_visible: true,
    benefits: { text_discount_rate: 0.7, checkin_base_credits: 30, checkin_vip_credits: 150 },
  });
  const wallet: GetWalletBalanceData = {
    credits: 3600,
    main_credits: 3000,
    bonus_credits: 600,
    total_credits: 3600,
    first_paid_at: null,
    last_paid_at: null,
    total_paid_amount: '0',
  };
  const models = GetModelCatalogDataSchema.parse({
    catalog: {
      default_model_id: 'preview-light',
      first_token_deadline_ms: 10_000,
      tiers: [
        {
          key: 'light',
          label: '轻量',
          color: '#a78bfa',
          cost_hint: '免费体验',
          sort_order: 0,
          models: [
            {
              id: 'preview-light',
              display_name: '林间引擎',
              tagline: '本地模拟回复',
              sort_order: 0,
            },
          ],
        },
      ],
    },
    selected_model_id: 'preview-light',
    selected_openrouter_model_id: 'preview/model',
    selected_provider: 'openrouter',
    selected_provider_model_id: 'preview/model',
    catalog_version: 1,
  });
  const plans: GetPaymentPlansData = {
    plans: [
      {
        id: 'preview-credits',
        price_cents: 1000,
        original_price_cents: null,
        credits_amount: 6000,
        bonus_credits: 600,
        variant: 'recommended',
        badge_text: '推荐',
        sub_copy: '本地展示套餐',
        highlight_text: '加赠 600 星尘',
      },
    ],
    payment_channels: DEFAULT_PAYMENT_CHANNELS_CONFIG,
    vip_plans: [
      {
        id: 'month',
        price_cents: 200,
        duration_days: 31,
        bonus_credits: 3000,
        title: 'VIP 月卡',
        description: '本地展示权益',
        badge_text: '推荐',
        available: true,
      },
    ],
    insufficient_credits_notice: '星尘不足，补充后继续体验。',
  };
  const imageConfig = GetImagePlazaConfigDataSchema.parse({
    enabled: true,
    default_video_model_id: 'wan-3-0-pro',
    video_models: [
      {
        id: 'wan-3-0-pro',
        name: 'Wan 3.0 Pro',
        description: '本地预览图生视频模型',
        image_input: 'optional_first_frame',
        durations: [5, 10],
        resolutions: ['720p', '1080p'],
        aspect_ratios: ['16:9', '9:16', '1:1'],
        audio_configurable: true,
        default_audio: true,
        default_duration: 5,
        default_resolution: '720p',
        default_aspect_ratio: '16:9',
        image_constraints: { min_short_side: 240 },
      },
      {
        id: 'preview-text-video',
        name: '纯文本视频',
        description: '不接收参考图，用于验证保留状态',
        image_input: 'none',
        durations: [5, 10],
        resolutions: ['720p', '1080p'],
        aspect_ratios: ['16:9', '9:16', '1:1'],
        audio_configurable: true,
        default_audio: false,
        default_duration: 5,
        default_resolution: '720p',
        default_aspect_ratio: '16:9',
        image_constraints: {},
      },
    ],
    models: [
      {
        id: 'preview-image',
        name: 'Dream Canvas',
        description: '本地预览模型',
        supports_i2i: true,
        supports_edit: false,
        aspect_ratios: ['1:1', '3:4', '16:9'],
        resolutions: [
          { id: '1K', label: '1K', credits: 20 },
          { id: '2K', label: '2K', credits: 40 },
        ],
      },
    ],
    tags: [
      {
        id: 'landscape',
        label: '风景',
        group_id: 'style',
        group_label: '风格',
        group_sort_order: 0,
        group_layout: 'chips',
      },
      {
        id: 'portrait',
        label: '人像',
        group_id: 'style',
        group_label: '风格',
        group_sort_order: 0,
        group_layout: 'chips',
      },
      {
        id: 'anime',
        label: '动漫',
        group_id: 'style',
        group_label: '风格',
        group_sort_order: 0,
        group_layout: 'chips',
      },
      {
        id: 'poster',
        label: '海报',
        group_id: 'style',
        group_label: '风格',
        group_sort_order: 0,
        group_layout: 'chips',
      },
      {
        id: 'indoor',
        label: '室内居家',
        group_id: 'scene',
        group_label: '场景',
        group_sort_order: 1,
        group_layout: 'chips',
      },
      {
        id: 'outdoor',
        label: '户外',
        group_id: 'scene',
        group_label: '场景',
        group_sort_order: 1,
        group_layout: 'chips',
      },
      {
        id: 'water',
        label: '水中',
        group_id: 'scene',
        group_label: '场景',
        group_sort_order: 1,
        group_layout: 'chips',
      },
      {
        id: 'dream-canvas',
        label: 'Dream Canvas',
        group_id: 'model',
        group_label: '模型',
        group_sort_order: 2,
        group_layout: 'grid',
      },
      {
        id: 'preview-image',
        label: 'Preview Image Pro',
        group_id: 'model',
        group_label: '模型',
        group_sort_order: 2,
        group_layout: 'grid',
      },
    ],
    share_rebate_rate: 0.1,
    has_completed_first_share: false,
    share_tip: {
      enabled: true,
      title: '分享灵感',
      description: '分享作品，遇见同好。',
      reference_note: '',
      button_label: '分享作品',
    },
  });
  const work = ImagePlazaWorkSchema.parse({
    id: IDS.work,
    title: '薄雾中的山谷',
    image_url: `${api}/assets/scene.svg`,
    reference_image_url: null,
    model_id: 'preview-image',
    model_name: 'Dream Canvas',
    width: 768,
    height: 1024,
    tags: ['风景'],
    like_count: 12,
    liked: false,
    published_at: now,
    snapshot: {
      prompt: 'A quiet valley in the morning mist',
      model_id: 'preview-image',
      aspect_ratio: '3:4',
      resolution: '1K',
      reasoning: false,
      auto_optimize: true,
      mode: 't2i',
      reference_artifact_id: null,
      style: 'None',
    },
  });
  const videoWork = PlazaVideoWorkSchema.parse({
    id: IDS.videoWork,
    media_type: 'video',
    title: '林间微风短片',
    poster_url: `${api}/assets/scene.svg?tone=1`,
    duration_ms: 5000,
    description: '树叶随风轻轻摇动。',
    model_id: 'wan-3-0-pro',
    model_name: 'Wan 3.0 Pro',
    width: 1280,
    height: 720,
    tags: ['风景'],
    like_count: 8,
    liked: false,
    published_at: now,
    artifact_id: '41000000-0000-4000-8000-000000000001',
    playback: {
      format: 'hls',
      play_url: `${api}/assets/plaza-video/master.m3u8`,
      expires_at: new Date(Date.now() + 900_000).toISOString(),
    },
    snapshot: {
      prompt: 'A gentle breeze moves through a quiet forest',
      model_id: 'wan-3-0-pro',
      input_mode: 't2v',
      duration_s: 5,
      resolution: '720p',
      aspect_ratio: '16:9',
      audio: true,
      reference_artifact_id: null,
    },
  });
  const studio: ImagePlazaConversation = {
    id: IDS.studio,
    title: '山谷灵感',
    snapshot: work.snapshot,
    messages: [],
    created_at: now,
    updated_at: now,
  };
  return {
    dramas,
    characters,
    sessions: [session],
    messages,
    generation,
    settings,
    vip,
    wallet,
    models,
    plans,
    imageConfig,
    works: [work, videoWork],
    studios: [studio],
  };
}

export type PreviewData = ReturnType<typeof makeData>;

/** Fictional model IDs; only the public provider label matches the real platform. */
export const SURPLUS_PREVIEW_MODEL = {
  id: 'preview-surplus',
  provider: 'surplus',
  provider_model_id: 'preview-surplus-text',
  display_name: 'Surplus Intelligence',
} as const;

export function useSurplusPreviewCatalog(data: PreviewData): void {
  const tier = data.models.catalog.tiers[0]!;
  tier.models.push({
    id: SURPLUS_PREVIEW_MODEL.id,
    display_name: SURPLUS_PREVIEW_MODEL.display_name,
    tagline: 'Surplus Intelligence 本地虚构回复',
    sort_order: 1,
  });
  data.models.catalog.default_model_id = SURPLUS_PREVIEW_MODEL.id;
  selectPreviewModel(data, SURPLUS_PREVIEW_MODEL.id);
}

export function selectPreviewModel(data: PreviewData, modelId: string): boolean {
  if (!data.models.catalog.tiers.some((tier) => tier.models.some((model) => model.id === modelId)))
    return false;
  const surplus = modelId === SURPLUS_PREVIEW_MODEL.id;
  const providerModelId = surplus ? SURPLUS_PREVIEW_MODEL.provider_model_id : 'preview/model';
  Object.assign(data.models, {
    selected_model_id: modelId,
    selected_openrouter_model_id: providerModelId,
    selected_provider: surplus ? SURPLUS_PREVIEW_MODEL.provider : 'openrouter',
    selected_provider_model_id: providerModelId,
  });
  data.generation.config.selected_model_id = modelId;
  return true;
}

const nextBilling = {
  billing_mode: 'free_trial' as const,
  wallet_policy: 'main_only' as const,
  price_credits: 20,
  price_label: '免费体验',
  free_trial_limit: 3,
  free_trial_ordinal: 1,
  free_trials_remaining: 3,
};
const trial = {
  free_trial_limit: 3,
  free_trials_used: 0,
  free_trials_reserved: 0,
  free_trials_remaining: 3,
  next_trial_ordinal: 1,
};
export const voiceConfig: GetVoiceConfigData = {
  config: { voice_id: 'preview-voice', playback_rate: 1 },
  voices: [{ id: 'preview-voice', label: '温暖', group: '预览' }],
  playback_rates: [1, 1.25, 1.5],
  billing: { enabled: false, credits_per_generation: 20, price_label: '免费体验' },
  free_trial: { ...trial, feature: 'voice' },
  next_billing: nextBilling,
  limits: { max_spoken_chars: 300 },
  hints: { over_limit: '文字太长', draft_failed: '未生成台词', tts_failed: '暂未提供语音模拟' },
};
export const EDIT_REPLY_PANELS =
  '\n\n[choices][choice]继续往前走[/choice][choice]问问路上的故事[/choice][choice]停下来休息[/choice][/choices]\n[status]<details><summary>当前状态</summary>\n\n```markdown\n地点：林间小路\n心情：平静\n```\n</details>[/status]\n[memory]<details><summary>故事记忆</summary>\n\n```markdown\n一起走到了路口。\n```\n</details>[/memory]';
