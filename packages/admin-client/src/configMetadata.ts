import {
  LLM_RELAY_PROVIDER_CONFIG_KEY,
  DEFAULT_LLM_RELAY_PROVIDER_CONFIG,
  CREATOR_REVIEW_PROMPT_KEY,
  DEFAULT_CHECKIN_NEW_USER_CREDITS,
  DEFAULT_CHECKIN_VETERAN_CREDITS,
  DEFAULT_CREATOR_REVIEW_PROMPT,
  DEFAULT_DRIVE_MODES_CONFIG,
  DEFAULT_FEATURE_FREE_TRIAL_LIMITS,
  DEFAULT_FREE_ZONE_CONFIG,
  DEFAULT_IMAGE_PLAZA_PRICING_FACTORS,
  DEFAULT_LLM_PROVIDER_ROUTING_CONFIG,
  DEFAULT_LOBBY_RANKING_PARAMS,
  DEFAULT_STORY_MEMORY_CONFIG,
  DEFAULT_STORY_MEMORY_PROMPT,
  MEMORY_BAR_PROMPT_KEY,
  DEFAULT_STATUS_MEMORY_MODEL_CONFIG,
  STATUS_MEMORY_MODEL_CONFIG_KEY,
  CHAT_RECOVERY_CONFIG_KEY,
  INITIAL_CHAT_RECOVERY_CONFIG,
  DEFAULT_VIP_CHECKIN_BONUS_CONFIG,
  DEFAULT_VIP_PLANS_CONFIG,
  DEFAULT_VIP_TEXT_DISCOUNT_RATE,
  DEFAULT_WORD_COUNT_TIERS_CONFIG,
  DRIVE_MODE_OPTIONS_KEY,
  FREE_ZONE_CONFIG_KEY,
  LlmPricingConfigSchema,
  STORY_MEMORY_CONFIG_KEY,
  STORY_MEMORY_PROMPT_KEY,
} from '@miniapp/shared';

import { createDefaultVideoCatalog, normalizeVideoPlazaCatalogOptions } from './videoPlazaConfig';
export {
  getDefaultVideoPlazaModelOptions,
  normalizeVideoPlazaCatalogOptions,
} from './videoPlazaConfig';
export { LlmPricingConfigSchema };

import type { ManagedConfigKey } from './configSchemas';
import {
  DEFAULT_INVITE_REWARD_RULES,
  DEFAULT_INVITE_CENTER_CONFIG,
  DEFAULT_SYSTEM_INSTRUCTIONS,
} from './configDefaults';
export const configMetadata: Record<
  ManagedConfigKey,
  { label: string; description: string; defaultValue: unknown }
> = {
  miniapp_new_user_signup_bonus_credits: {
    label: '新用户赠送星尘',
    description: '新用户首次进入时一次性赠送的 bonus 星尘。',
    defaultValue: 398,
  },
  miniapp_checkin_new_user_credits: {
    label: '新用户签到奖励',
    description: '非 VIP 且注册≤14 天的每日签到专项星尘绝对额。',
    defaultValue: DEFAULT_CHECKIN_NEW_USER_CREDITS,
  },
  miniapp_checkin_veteran_credits: {
    label: '老用户签到奖励',
    description: '非 VIP 且注册>14 天的每日签到专项星尘绝对额。',
    defaultValue: DEFAULT_CHECKIN_VETERAN_CREDITS,
  },
  miniapp_payment_plans: {
    label: '充值套餐',
    description: '星尘商店展示并用于下单校验的正式套餐，以及用户端可见的支付通道和默认通道。',
    defaultValue: [],
  },
  llm_model_catalog: {
    label: '模型目录',
    description: '用户可选择的模型、档位与默认模型。免费聊天只走畅聊。',
    defaultValue: {
      default_model_id: 'gemini-flash-lite',
      tiers: [
        {
          tier: 'light',
          label: '轻量',
          color: '#4ade80',
          cost_hint: '适合日常对话',
          sort_order: 1,
          models: [
            {
              id: 'gemini-flash-lite',
              openrouter_model_id: 'google/gemini-3.1-flash-lite',
              display_name: 'Gemini Flash Lite',
              tagline: '适合日常角色对话，回复快、消耗低。',
              enabled: true,
              sort_order: 1,
            },
          ],
        },
      ],
    },
  },
  llm_pricing_config: {
    label: 'LLM 计费参数',
    description: '每次成功生成的固定扣费标准（轻量 / 标准 / 旗舰）。',
    defaultValue: {
      fixedDeduction: {
        light: 15,
        standard: 30,
        premium: 50,
      },
    },
  },
  [LLM_RELAY_PROVIDER_CONFIG_KEY]: {
    label: '中转平台额度与监控',
    description:
      'Packy / OneXModel 原生额度、已核验的换算依据与低余额监控。缺换算保留未知，默认不启用监控，不影响用户星尘报价。',
    defaultValue: DEFAULT_LLM_RELAY_PROVIDER_CONFIG,
  },
  llm_provider_routing_config: {
    label: '模型供应商路由',
    description:
      '按「模型 × 供应商」控制 OpenRouter 路由：屏蔽列表写入 provider.ignore；优先列表写入 provider.order 并允许兜底回落。规则只作用于所填模型，未配置的模型不受影响。',
    defaultValue: DEFAULT_LLM_PROVIDER_ROUTING_CONFIG,
  },
  system_instructions: {
    label: '主体模板',
    description:
      '自研引擎每轮注入的平台规则（markdown）。须含选项规则槽位 {{CHOICE_RULES}}、{{WORD_COUNT}} / {{USER_CUSTOM_INSTRUCTIONS}}；编辑与回滚均发布为新快照。',
    defaultValue: DEFAULT_SYSTEM_INSTRUCTIONS,
  },
  [CREATOR_REVIEW_PROMPT_KEY]: {
    label: '角色卡审核',
    description:
      '维护公开角色卡的审核标准正文。公开和公开更新使用已发布版本，未发布草稿不影响当前审核。输出结构由系统固定。',
    defaultValue: DEFAULT_CREATOR_REVIEW_PROMPT,
  },
  choice_rules: {
    label: '选项规则',
    description:
      '选项槽位的完整、简洁和关闭文案；机器标签格式由系统固定协议统一注入，三种模式可独立发布与回滚。',
    defaultValue: {
      on_first_two_turns:
        '本轮需要输出选项。提供三条具体且有区分度的下一步输入建议，不替用户决定行动，也不预演选择结果；严格遵守系统固定富文本协议。',
      on_later_turns:
        '本轮需要输出选项。简洁提供三条下一步输入建议，不替用户作决定；严格遵守系统固定富文本协议。',
      off: '本轮不输出选项，不得输出 [choice]、[/choice]、选项标题或占位内容。',
    },
  },
  reply_style_options: {
    label: '回复风格',
    description:
      '管理回复偏好中的选项名称、说明、展示顺序与独立开关；沿用草稿、发布和回滚。英文占位符写进主体模板；用户开启的选项，规则内容替换对应占位符，未开启时替换为空。',
    defaultValue: { options: [] },
  },
  [DRIVE_MODE_OPTIONS_KEY]: {
    label: '剧情模式',
    description:
      '回复偏好最上方的「剧情模式」：用户选择剧情由谁推动。每档的名称和说明展示给用户；规则替换主体模板里的 {{DRIVE_RULES}}，模型每次只看到用户所选的一档，所以每档规则必须自成一体。未选择的用户使用默认档。',
    defaultValue: DEFAULT_DRIVE_MODES_CONFIG,
  },
  [FREE_ZONE_CONFIG_KEY]: {
    label: '畅聊（免费模型）',
    description:
      '对话页引擎面板最上方的「畅聊」栏目：总开关、福利期、使用范围、规则文字，以及候选池和自动上下架门槛。总开关只决定用户能不能看到；只要配了候选，后台每 30 分钟都会评估。门槛留空（null）表示这一项不检查。',
    defaultValue: DEFAULT_FREE_ZONE_CONFIG,
  },
  [STORY_MEMORY_CONFIG_KEY]: {
    label: '长期剧情记忆参数',
    description:
      '按正文字数（不含选项/状态栏，去掉空白）截断历史：超过高水位时退到低水位以下，最近「保底轮数」永不截断（至少 11，保证用户可编辑的最近 10 轮不会被压缩）。被截断的章节由后台模型压缩成前情档案并注入后续生成。超过高水位时先在后台压缩、记忆落地后再截断，窗口与记忆同一轮切换；压缩迟迟不成功时超过「高水位 + 高低水位落差的一半」才强制截断。关闭开关时停止生成与注入，直接截断。压缩模型与供应商顺序独立于聊天兜底配置。',
    defaultValue: DEFAULT_STORY_MEMORY_CONFIG,
  },
  [STORY_MEMORY_PROMPT_KEY]: {
    label: '长期剧情记忆 prompt',
    description:
      '后台压缩前情档案时使用的完整 prompt。必须包含 {{old_memory}}、{{new_history}}、{{recent_context}}、{{max_chars}}；可用 {{user_name}}、{{char_name}}。角色卡与开场白始终在聊天 prompt 最前面，不送进压缩。以「## 」开头的行是输出板块标题，系统据此校验输出是否齐全，说明性标题不要用「## 」。',
    defaultValue: DEFAULT_STORY_MEMORY_PROMPT,
  },
  [MEMORY_BAR_PROMPT_KEY]: {
    label: '记忆栏 prompt',
    description:
      '右侧面板记忆栏（剧情记录）的记录规则：记什么、怎么记、内容上的限制（如未成年人相关）、玩家「记忆要求」怎么对待。每 3 轮检查和 VIP「立即更新」都读线上版本，发布后下一次检查生效。输出结构（JSON 字段与字数上限）由系统固定追加在后面，这里不用写。没有发布可用版本时记忆栏不更新。',
    defaultValue: '',
  },
  [STATUS_MEMORY_MODEL_CONFIG_KEY]: {
    label: '状态栏/记忆栏模型',
    description:
      '右侧面板状态栏、记忆栏共用的模型：首发走 Surplus（流式，4 秒内没出第一个字就转兜底），兜底走 OpenRouter。这里只换模型名，通道和参数由系统固定；每次更新现读线上版本，发布后下一次更新生效。没配或配错时用默认的 Gemini 3 Flash + DeepSeek V4 Flash。不影响正文回复的首字兜底。',
    defaultValue: DEFAULT_STATUS_MEMORY_MODEL_CONFIG,
  },
  [CHAT_RECOVERY_CONFIG_KEY]: {
    label: '出字后兜底',
    description:
      '回复开始出字后出问题时，擦掉已显示的内容（含思考过程），用首字兜底模型从头重写一次：中断（出字后连续若干毫秒没有新字，或流里报错）；拒答（正文前若干字命中词池，正文照常输出不压）。兜底不再兜底；救回来的正常扣费，没救回来的按中断免扣。供应商拒绝或内容过滤且涉及未成年人时系统固定不重写。每 30 秒内生效。没配或配错时两个开关都按关闭处理。',
    defaultValue: INITIAL_CHAT_RECOVERY_CONFIG,
  },
  pref_word_count_tiers: {
    label: '回复长度档位',
    description:
      '生成偏好「回复长度」的档位表：可增删档位、改按钮文案与列布局；prompt_value 注入 {{WORD_COUNT}}。',
    defaultValue: DEFAULT_WORD_COUNT_TIERS_CONFIG,
  },
  lobby_ranking_params: {
    label: '推荐轮换与质量评分',
    description:
      '推荐页为全体用户轮换前 12 张优质角色，可设置换批间隔、重复上限和探索数量。轮换参数发布后生效，质量参数在下一次每日评分刷新后生效。',
    defaultValue: DEFAULT_LOBBY_RANKING_PARAMS,
  },
  miniapp_invite_reward_rules: {
    label: '裂变邀请奖励规则',
    description:
      '裂变邀请的奖励规则：total_cap_credits 为单个下级用户累计奖励上限；rule_key 发布后不可改名（发放流水引用它做幂等键），金额与开关可随时发布调整。',
    defaultValue: DEFAULT_INVITE_REWARD_RULES,
  },
  miniapp_invite_center_config: {
    label: '裂变邀请素材',
    description:
      '邀请中心素材：poster_url 为已发布海报图（2160×3840，支持直接上传 PNG/JPG/WEBP，也可贴 URL）；copy_templates 为已发布文案库（C 端刷新按钮轮换来源），{link} 会被替换为用户专属链接。',
    defaultValue: DEFAULT_INVITE_CENTER_CONFIG,
  },
  miniapp_invite_entry_enabled: {
    label: '裂变邀请入口开关',
    description:
      '裂变邀请入口总开关：关闭时 C 端隐藏邀请中心全部入口。生产环境先关后开，代码上线不等于功能上线。',
    defaultValue: false,
  },
  image_plaza_model_catalog: {
    label: '模型管理',
    description: '管理图片广场模型、能力、画幅和各分辨率上架星尘价；用户端只读取已发布版本。',
    defaultValue: {
      default_model_id: 'seedream-v5-pro',
      pricing_factors: { ...DEFAULT_IMAGE_PLAZA_PRICING_FACTORS },
      models: [
        ['qwen-image-3', 'Qwen Image 3', 60],
        ['qwen-image-3-pro', 'Qwen Image 3 Pro', 80],
        ['seedream-v5-pro', 'Seedream V5 Pro', 90],
        ['krea-2-turbo', 'Krea 2 Turbo', 60],
        ['lustify-v8', 'Lustify v8', 20],
        ['seedream-v5-lite', 'Seedream V5 Lite', 80],
        ['chroma', 'Chroma', 20],
        ['lustify-sdxl', 'Lustify SDXL', 20],
        ['anime-wai', 'Anime (WAI)', 20],
        ['venice-sd35', 'Venice SD35', 20],
      ].map(([id, name, credits], sortOrder) => ({
        id,
        provider_model_id: id === 'anime-wai' ? 'wai-Illustrious' : id,
        edit_provider_model_id:
          {
            'qwen-image-3': 'qwen-image-3-edit',
            'qwen-image-3-pro': 'qwen-image-3-pro-edit',
            'seedream-v5-pro': 'seedream-v5-pro-edit',
            'seedream-v5-lite': 'seedream-v5-lite-edit',
          }[String(id)] ?? null,
        sizing_mode: [
          'qwen-image-3',
          'qwen-image-3-pro',
          'seedream-v5-pro',
          'krea-2-turbo',
        ].includes(String(id))
          ? 'resolution'
          : id === 'seedream-v5-lite'
            ? 'aspect_ratio'
            : 'pixels',
        name,
        description: '适合多种图片创作场景',
        supports_i2i: [
          'qwen-image-3',
          'qwen-image-3-pro',
          'seedream-v5-pro',
          'seedream-v5-lite',
        ].includes(String(id)),
        supports_edit: [
          'qwen-image-3',
          'qwen-image-3-pro',
          'seedream-v5-pro',
          'seedream-v5-lite',
        ].includes(String(id)),
        aspect_ratios: ['1:1', '2:3', '3:2', '3:4', '4:3', '9:16', '16:9'],
        resolutions: [
          {
            id: [
              'lustify-v8',
              'seedream-v5-lite',
              'chroma',
              'lustify-sdxl',
              'anime-wai',
              'venice-sd35',
            ].includes(String(id))
              ? 'fixed'
              : '1K',
            label: '标准',
            credits,
          },
        ],
        enabled: true,
        sort_order: sortOrder,
        internal_tags: [],
      })),
    },
  },
  image_plaza_video_model_catalog: {
    label: '视频模型管理',
    description:
      '管理视频模型能力、Provider ID 与时长×清晰度×声音价格矩阵；发布前必须用真实参考价替换占位价格。',
    defaultValue: createDefaultVideoCatalog(),
  },
  image_plaza_share_tip: {
    label: '弹窗配置',
    description:
      '配置首次分享确认弹窗的中部文案与开关；顶图始终使用用户作品。仅支持 {rate} 与 {model}。',
    defaultValue: {
      enabled: true,
      title: '分享返还 {rate}',
      description: '让更多人看到你的 {model} 作品。',
      reference_note: '如使用参考图，参考图也会同时公开。',
      button_label: '分享至广场',
    },
  },
  image_plaza_tags: {
    label: '内容标签',
    description:
      '管理图片/视频共用的广场筛选标签与分组；“全部”为系统固定项，删除标签不会删除历史作品。',
    defaultValue: [
      {
        id: 'portrait',
        label: '人像',
        enabled: true,
        sort_order: 0,
        group_id: 'style',
        group_label: '风格',
        group_sort_order: 0,
        group_layout: 'chips',
      },
      {
        id: 'anime',
        label: '动漫',
        enabled: true,
        sort_order: 1,
        group_id: 'style',
        group_label: '风格',
        group_sort_order: 0,
        group_layout: 'chips',
      },
      {
        id: 'poster',
        label: '海报',
        enabled: true,
        sort_order: 2,
        group_id: 'style',
        group_label: '风格',
        group_sort_order: 0,
        group_layout: 'chips',
      },
    ],
  },
  vip_purchase_enabled: {
    label: 'VIP 购买开关',
    description: '关闭时不能创建新的 VIP 订单。已创建订单仍按自己的商品快照履约。',
    defaultValue: false,
  },
  vip_reminders_enabled: {
    label: 'VIP 到期提醒开关',
    description: '只控制提醒是否写入。提前天数、文案和时区不在这里配置，默认保持关闭。',
    defaultValue: false,
  },
  vip_plans_config: {
    label: '月卡商品',
    description: '价格使用整数分。发布后只影响新创建的订单。',
    defaultValue: DEFAULT_VIP_PLANS_CONFIG,
  },
  vip_text_discount_rate: {
    label: 'VIP 生成折扣率',
    description:
      '适用于文本、语音和图片付费生成。大于 0 且不超过 1；受理时固化，不重算已受理请求。',
    defaultValue: DEFAULT_VIP_TEXT_DISCOUNT_RATE,
  },
  vip_checkin_bonus_config: {
    label: 'VIP 每日签到星尘',
    description: '有效 VIP 每日签到的专项与通用星尘绝对额（非加成）。兼容旧数字配置（全部专项）。',
    defaultValue: DEFAULT_VIP_CHECKIN_BONUS_CONFIG,
  },
  feature_free_trial_limits: {
    label: '媒体免费次数',
    description: '语音和初级图片分别配置，整数 0 到 20。0 表示关闭该功能的免费体验。',
    defaultValue: DEFAULT_FEATURE_FREE_TRIAL_LIMITS,
  },
};
