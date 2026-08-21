import type {
  CsBroadcastAudience,
  CsSendStatus,
  CsSessionStatus,
  CsSopStageData,
  CsWaitingState,
} from '@miniapp/shared';

export type Membership = 'active' | 'chatted_left';

export const DEFAULT_SQL = `SELECT u.id AS user_id
FROM miniapp.users u
JOIN miniapp.miniapp_user_settings s ON s.user_id = u.id
WHERE s.total_round > 40
  AND u.miniapp_entered_at < now() - interval '7 days'
ORDER BY s.total_round DESC`;

export const DEFAULT_SOP: CsSopStageData[] = [
  {
    key: 'icebreaker',
    title: '破冰',
    prompt: 'Hi~ 我是XX的运营客服，想花几分钟听听你的使用感受，方便吗？',
  },
  {
    key: 'pain',
    title: '体验痛点',
    prompt:
      '您平时跟角色聊天的时候，有没有遇到什么让您特别不爽的地方？卡顿、bug、或者觉得哪里别扭的，都算。',
    followups: ['这种情况大概多久出现一次？', '当时是在什么场景下？'],
  },
  {
    key: 'feature',
    title: '最想要的功能',
    prompt: '如果我们接下来只能加一个新功能，您最希望是什么？',
    followups: ['这个功能对您来说主要是解决什么问题？'],
    fallback_options: [
      '① 语音消息（让角色用语音念出来）',
      '② 状态栏（看到角色心情/好感度）',
      '③ 超强记忆（聊几百回合不失忆）',
      '④ 生成图片（根据场景生成角色图）',
      '⑤ 自建角色卡（自己创建和保存角色）',
    ],
  },
  {
    key: 'role_preference',
    title: '角色卡偏好',
    prompt: '您有没有特别想聊但我们大厅里没有的角色类型？什么设定都行',
  },
  {
    key: 'closing',
    title: '收尾',
    prompt:
      '感谢你的真实反馈，这对我们很重要。以后有任何不爽的地方，随时找我，我帮您催开发！祝您玩得开心~',
  },
];

export type BadgeTone = 'neutral' | 'info' | 'warning' | 'success' | 'danger';

export const SESSION_STATUS_META: Record<CsSessionStatus, { label: string; tone: BadgeTone }> = {
  not_started: { label: '未开始', tone: 'neutral' },
  icebreaking: { label: '破冰中', tone: 'info' },
  waiting_reply: { label: '等待回复', tone: 'warning' },
  following_up: { label: '跟进中', tone: 'info' },
  completed: { label: '已完成', tone: 'success' },
  snoozed: { label: '已延后', tone: 'neutral' },
  skipped: { label: '已跳过', tone: 'neutral' },
  send_failed: { label: '发送失败', tone: 'danger' },
};

/**
 * 等待状态的呈现。none 不出标签也不上底色——它不是「等我回」，
 * 一旦也给了颜色，整个列表就全是彩色，黄色的优先级提示就白做了。
 */
export const WAITING_STATE_META: Record<CsWaitingState, { label: string; tone: BadgeTone } | null> =
  {
    none: null,
    first_round: { label: '首轮等待回复', tone: 'warning' },
    second_round: { label: '二次等待回复', tone: 'success' },
  };

export const BROADCAST_AUDIENCE_OPTIONS: Array<{
  value: CsBroadcastAudience;
  label: string;
}> = [
  { value: 'all_waiting', label: '所有等待回复' },
  { value: 'first_round', label: '仅首轮等待回复' },
  { value: 'second_round', label: '仅二次等待回复' },
  { value: 'not_started', label: '仅未开始' },
  { value: 'all', label: '该簇全部在册用户' },
];

export const SEND_STATUS_LABELS: Record<CsSendStatus, string> = {
  pending: '发送中',
  sent: '已送达',
  failed: '发送失败',
  received: '已收到',
};

export function formatDateTime(iso: string | null): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const hm = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  return sameDay ? hm : `${date.getMonth() + 1}/${date.getDate()} ${hm}`;
}
