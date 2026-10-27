import {
  DEFAULT_PAYMENT_CHANNELS_CONFIG,
  DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG,
  DEFAULT_RECHARGE_PAGE_CONFIG,
  DEFAULT_WORD_COUNT_TIERS_CONFIG,
  GetImagePlazaConfigDataSchema,
  GetModelCatalogDataSchema,
  ImagePlazaWorkSchema,
  toPublicWordCountTiers,
  UserGenerationConfigSchema,
  UserSettingsSchema,
  VipStatusSchema,
  type CharacterDetail,
  type ChatMessage,
  type ChatSession,
  type GetPaymentPlansData,
  type GetWalletBalanceData,
  type ImagePlazaConversation,
  type GetVoiceConfigData,
  type GetImageConfigData,
  type DramaDetail,
} from '@miniapp/shared';

export const IDS = {
  character: '10000000-0000-4000-8000-000000000001',
  session: '20000000-0000-4000-8000-000000000001',
  work: '30000000-0000-4000-8000-000000000001',
  studio: '40000000-0000-4000-8000-000000000001',
} as const;
export const stamp = () => new Date().toISOString();
export const later = () => new Date(Date.now() + 31 * 86_400_000).toISOString();

export const scenarios = {
  standard: {
    label: '普通用户',
    description: '签到、会员引导、角色和影像完整路径',
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
  dramas: {
    label: '短剧体验',
    description: '沉浸刷剧、收藏、点赞、评论、选集和本设备续看',
    path: '/',
  },
  'drama-interaction-error': {
    label: '短剧互动失败',
    description: '点赞失败恢复、评论草稿保留、重试不重复',
    path: '/',
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
  'chat-error': {
    label: '聊天生成失败',
    description: '失败与重新生成入口',
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

export function makeData(api: string) {
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
  const characters: CharacterDetail[] = Array.from({ length: 18 }, (_, index) => ({
    id:
      index === 0
        ? IDS.character
        : `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    name: index === 0 ? '林间旅人' : `故事旅人 ${index + 1}`,
    description: '沿着森林小径，开启一段轻松的冒险。',
    avatar_url: `${api}/assets/scene.svg?tone=${index % 3}`,
    personality_tags: ['冒险', '温暖'],
    author_name: '预览创作者',
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
      pref_custom_instructions: null,
    }),
    word_count_tiers: toPublicWordCountTiers(DEFAULT_WORD_COUNT_TIERS_CONFIG),
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
              is_free: true,
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
    page_config: DEFAULT_RECHARGE_PAGE_CONFIG,
    payment_prompt_dialog_config: DEFAULT_PAYMENT_PROMPT_DIALOG_CONFIG,
    insufficient_credits_notice: '星尘不足，补充后继续体验。',
  };
  const imageConfig = GetImagePlazaConfigDataSchema.parse({
    enabled: true,
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
    tags: [{ id: 'landscape', label: '风景' }],
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
    works: [work],
    studios: [studio],
  };
}

export type PreviewData = ReturnType<typeof makeData>;

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
export const chatImageConfig: GetImageConfigData = {
  enabled: false,
  billing: { enabled: false, credits_per_generation: 20, price_label: '免费体验' },
  tier: {
    tier: 'basic',
    enabled: false,
    available: false,
    billing: { enabled: false, credits_per_generation: 20, price_label: '免费体验' },
    wallet_policy: 'main_only',
    requires_vip: false,
    free_trial: { ...trial, feature: 'basic_image' },
    next_billing: nextBilling,
    locked_reason: null,
  },
  limits: { max_prompt_chars: 1000, width: 768, height: 1024, max_output_bytes: 20_000_000 },
  hints: {
    prompt_policy: '',
    prompt_over_limit: '描述太长',
    description_failed: '未生成描述',
    generation_failed: '未生成图片',
    failed_unknown: '结果未知',
  },
};
