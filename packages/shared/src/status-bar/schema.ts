/**
 * 状态栏模板契约：创作者建卡、玩家在工具箱里改、后端喂给状态模型，三处用同一份。
 *
 * 草稿（editor / 建卡自动保存）只校验结构与长度；可用（发布、保存到玩家覆盖版、喂模型）
 * 还要过 {@link checkStatusBarTemplate} 的语义校验：说明写够、开局值写法对得上样式、
 * 名称不重复、定义总长不超。语义校验和提示词用的是同一份样式规格（spec.ts），
 * 保证"界面允许的"＝"提示词教的"＝"解析器认的"。
 */
import { z } from 'zod';

export const STATUS_BAR_STYLES = [
  'bar',
  'percent',
  'stars',
  'number',
  'line',
  'tags',
  'para',
  'stage',
  'checks',
  'bullets',
] as const;
export type StatusBarStyle = (typeof STATUS_BAR_STYLES)[number];

export const STATUS_BAR_TYPES = ['number', 'text', 'stage', 'list'] as const;
export type StatusBarType = (typeof STATUS_BAR_TYPES)[number];

export const STATUS_BAR_LIMITS = {
  sections: 4,
  items: 12,
  nameChars: 8,
  descMinChars: 8,
  descMaxChars: 200,
  noteMaxChars: 500,
  definitionMaxChars: 3000,
  sectionTitleChars: 20,
  repeatWhatChars: 12,
  repeatMax: 3,
  stagesMin: 2,
  stagesMax: 8,
  stageNameChars: 10,
  barMax: 9999,
  starsMin: 3,
  starsMax: 10,
  unitChars: 4,
  initMaxChars: 300,
  idChars: 40,
} as const;

/** 名称里不能出现的字符：标点会让解析器把散文误当字段，冒号和括号是语法本身。 */
export const STATUS_NAME_FORBIDDEN = /[：:【】[\]<>，。！？；、“”"'…,.!?;\r\n]/;
/** 阶段名里不能有分隔符和括号，否则"阶段名（第几/总数）"会解析歧义。 */
export const STATUS_STAGE_FORBIDDEN = /[、/／（）()【】[\]：:\r\n]/;
/** 填空模板里的空，说明里还留着它就说明没填完。 */
export const STATUS_FILL_BLANK = '___';

const chars = (value: string) => [...value].length;
const boundedText = (max: number) =>
  z.string().refine((value) => chars(value) <= max, { message: `不能超过 ${max} 字` });

export const StatusBarItemSchema = z
  .object({
    id: z.string().min(1).max(STATUS_BAR_LIMITS.idChars),
    name: z
      .string()
      .trim()
      .min(1)
      .refine((value) => chars(value) <= STATUS_BAR_LIMITS.nameChars, {
        message: `名称最多 ${STATUS_BAR_LIMITS.nameChars} 字`,
      })
      .refine((value) => !STATUS_NAME_FORBIDDEN.test(value), {
        message: '名称不能带标点、冒号或括号',
      }),
    style: z.enum(STATUS_BAR_STYLES),
    desc: boundedText(STATUS_BAR_LIMITS.descMaxChars),
    init: boundedText(STATUS_BAR_LIMITS.initMaxChars).optional(),
    max: z.number().int().min(1).max(STATUS_BAR_LIMITS.barMax).optional(),
    total: z
      .number()
      .int()
      .min(STATUS_BAR_LIMITS.starsMin)
      .max(STATUS_BAR_LIMITS.starsMax)
      .optional(),
    unit: z
      .string()
      .trim()
      .refine((value) => chars(value) <= STATUS_BAR_LIMITS.unitChars && !/[\d\s]/.test(value), {
        message: '单位最多 4 字，不能有数字和空格',
      })
      .optional(),
    stages: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .refine(
            (value) =>
              chars(value) <= STATUS_BAR_LIMITS.stageNameChars &&
              !STATUS_STAGE_FORBIDDEN.test(value),
            { message: '阶段名最多 10 字，不能带顿号、斜杠、括号' }
          )
      )
      .max(STATUS_BAR_LIMITS.stagesMax)
      .optional(),
  })
  .strict();
export type StatusBarItem = z.infer<typeof StatusBarItemSchema>;

export const StatusBarSectionSchema = z
  .object({
    id: z.string().min(1).max(STATUS_BAR_LIMITS.idChars),
    title: z
      .string()
      .trim()
      .refine(
        (value) =>
          chars(value) <= STATUS_BAR_LIMITS.sectionTitleChars && !/[【】[\]<>\r\n]/.test(value),
        { message: '分区标题最多 20 字，不能带括号' }
      ),
    repeat: z
      .object({
        what: z
          .string()
          .trim()
          .min(1)
          .refine((value) => chars(value) <= STATUS_BAR_LIMITS.repeatWhatChars, {
            message: '最多 12 字',
          }),
        max: z.number().int().min(1).max(STATUS_BAR_LIMITS.repeatMax),
      })
      .strict()
      .nullable(),
    items: z.array(StatusBarItemSchema).max(STATUS_BAR_LIMITS.items),
  })
  .strict();
export type StatusBarSection = z.infer<typeof StatusBarSectionSchema>;

/** 草稿形状：结构与长度合法即可（允许说明暂时没写、分区暂时为空）。 */
export const StatusBarTemplateDraftSchema = z
  .object({
    version: z.literal(1),
    note: boundedText(STATUS_BAR_LIMITS.noteMaxChars),
    sections: z.array(StatusBarSectionSchema).min(1).max(STATUS_BAR_LIMITS.sections),
  })
  .strict();
export type StatusBarTemplate = z.infer<typeof StatusBarTemplateDraftSchema>;

export const STATUS_BAR_STYLE_TYPE: Record<StatusBarStyle, StatusBarType> = {
  bar: 'number',
  percent: 'number',
  stars: 'number',
  number: 'number',
  line: 'text',
  tags: 'text',
  para: 'text',
  stage: 'stage',
  checks: 'list',
  bullets: 'list',
};

export const STATUS_BAR_STYLE_LABEL: Record<StatusBarStyle, string> = {
  bar: '进度条',
  percent: '百分比',
  stars: '星级',
  number: '数字',
  line: '一句话',
  tags: '标签',
  para: '一段话',
  stage: '分段条',
  checks: '打勾清单',
  bullets: '普通列表',
};

export const STATUS_BAR_TYPE_LABEL: Record<StatusBarType, string> = {
  number: '数值',
  text: '文字',
  stage: '阶段',
  list: '清单',
};

/** 每个类型的默认样式（编辑器"选类型"时落到这里）。 */
export const STATUS_BAR_TYPE_DEFAULT: Record<StatusBarType, StatusBarStyle> = {
  number: 'bar',
  text: 'line',
  stage: 'stage',
  list: 'checks',
};

export const STATUS_BAR_TYPE_STYLES: Record<StatusBarType, readonly StatusBarStyle[]> = {
  number: ['bar', 'percent', 'stars', 'number'],
  text: ['line', 'tags', 'para'],
  stage: ['stage'],
  list: ['checks', 'bullets'],
};

export function countStatusBarItems(template: StatusBarTemplate): number {
  return template.sections.reduce((n, section) => n + section.items.length, 0);
}
