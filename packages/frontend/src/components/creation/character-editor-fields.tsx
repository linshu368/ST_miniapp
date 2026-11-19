import type { ReactNode } from 'react';
export const TAGS = [
  '纯爱',
  '女性向',
  'NTR',
  '古风历史',
  '调教',
  '乱伦',
  '仙侠古风',
  '大世界',
  '后宫',
  '足控',
  '同人',
  '百合',
  '男娘',
  '油腻',
  '扶她',
  '一般向',
  '男同',
  '女性视角',
  '游戏',
];
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const INPUT =
  'block w-full min-w-0 rounded-xl border border-input bg-card px-3.5 py-3 text-base leading-7 text-foreground outline-none placeholder:text-[13px] placeholder:text-muted-foreground focus:border-primary/60 disabled:opacity-60';
export const FIELDS = [
  {
    key: 'description',
    label: '描述',
    placeholder: '描述你的角色或故事，会展示在卡片和聊天页顶部',
    rows: 4,
    required: true,
    divider: false,
  },
  {
    key: 'opening',
    label: '开场白',
    placeholder: '玩家进入聊天后看到的第一段内容。可以描写开场场景，也可以让角色先说一句话。',
    rows: 5,
    required: true,
    divider: true,
  },
  {
    key: 'background',
    label: '背景',
    placeholder:
      '定义角色的外观、个性和背景。你也可以添加自定义提示、故事、规则或者上传剧本小说。这些细节将指导角色的行为和回应',
    rows: 7,
    required: true,
    divider: true,
  },
  {
    key: 'preset',
    label: '预设',
    placeholder: '破甲话术。对有些模型来说必不可少。',
    rows: 5,
    required: false,
    divider: true,
  },
] as const;
export type TextField = (typeof FIELDS)[number]['key'];

export const requiredMark: ReactNode = (
  <span className="ml-1 text-destructive" aria-hidden>
    *
  </span>
);
