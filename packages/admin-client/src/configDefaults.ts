import type { InviteRewardRulesConfig, InviteCenterConfig } from './configSchemas';
/** 与 105 迁移的 runtime_config seed 完全一致。 */
export const DEFAULT_INVITE_REWARD_RULES: InviteRewardRulesConfig = {
  total_cap_credits: 2200,
  rules: [
    { rule_key: 'invitee_registered', credits: 200, enabled: false },
    { rule_key: 'invitee_chat_rounds', credits: 200, enabled: true, threshold_rounds: 3 },
    { rule_key: 'invitee_first_paid', credits: 2000, enabled: false },
  ],
};

export const DEFAULT_INVITE_CENTER_CONFIG: InviteCenterConfig = {
  poster_url: '',
  copy_templates: [
    '我在这里发现了超多有趣的角色，快来和我一起聊！点击专属链接注册，我们都能拿星尘奖励：{link}',
  ],
};

/**
 * Safe Admin fallback only. The authoritative published template remains the
 * managed runtime value; this fallback keeps a new/empty environment from
 * offering the retired INTERACTION_MODE contract.
 */
export const DEFAULT_SYSTEM_INSTRUCTIONS = [
  '# Roleplay System Instructions',
  '',
  '只输出最终展示内容；不得替用户决定行动。剧情正文始终先输出；选项开启时在正文之后追加选项，关闭时完整省略选项标签、标题和占位内容。',
  '',
  '## 选项',
  '{{CHOICE_RULES}}',
  '',
  '## 用户个人偏好',
  '{{USER_CUSTOM_INSTRUCTIONS}}',
  '',
  '剧情正文篇幅为 {{WORD_COUNT}} 字，仅使用简体中文。',
].join('\n');
