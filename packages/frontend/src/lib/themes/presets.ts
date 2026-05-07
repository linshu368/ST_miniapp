// 移植自 SillyTavern 内置主题(default/content/themes/*.json)
// 只保留与 LLM 输出文本渲染直接相关的 4 个颜色轴。气泡 tint / blur / shadow
// 等不移植——它们是 ST 整套 webapp 的视觉规范,与本应用现有设计冲突。
//
// 字段命名沿用 ST 的语义,值用 rgba 直接保存(对照 ST 主题 json 一目了然)。

export interface ThemePalette {
  /** 普通文本(<p> 等) */
  main: string;
  /** 斜体 <em>(动作/旁白) */
  italics: string;
  /** 下划线 <u>(强调) */
  underline: string;
  /** 引号 <q>(对白) */
  quote: string;
}

export interface ThemePreset {
  /** 唯一 key,持久化用 */
  id: string;
  /** 显示名 */
  name: string;
  /** 一句话描述,在选择器里展示 */
  blurb: string;
  palette: ThemePalette;
}

export const THEME_PRESETS: ThemePreset[] = [
  {
    id: 'default',
    name: '默认',
    blurb: '当前色板:珊瑚对白 + 米白主文 + 灰动作',
    palette: {
      main: 'hsl(30 15% 92%)',
      italics: 'hsl(258 10% 55%)',
      underline: 'hsl(340 65% 58%)',
      quote: 'hsl(12 75% 62%)',
    },
  },
  {
    id: 'dark-v1',
    name: '古卷',
    blurb: '酒馆经典款:金色对白,米色主文,低调灰动作',
    palette: {
      main: 'rgba(207, 207, 197, 1)',
      italics: 'rgba(145, 145, 145, 1)',
      underline: 'rgba(145, 145, 145, 1)',
      quote: 'rgba(198, 193, 151, 1)',
    },
  },
  {
    id: 'dark-lite',
    name: '暮橙',
    blurb: '橙色对白突出,绿色下划线,深色克制',
    palette: {
      main: 'rgba(220, 220, 210, 1)',
      italics: 'rgba(145, 145, 145, 1)',
      underline: 'rgba(188, 231, 207, 1)',
      quote: 'rgba(225, 138, 36, 1)',
    },
  },
  {
    id: 'azure',
    name: '湛蓝',
    blurb: '冷调蓝白:对白鲜蓝,动作反而更亮',
    palette: {
      main: 'rgba(171, 198, 223, 1)',
      italics: 'rgba(255, 255, 255, 1)',
      underline: 'rgba(188, 231, 207, 1)',
      quote: 'rgba(111, 133, 253, 1)',
    },
  },
  {
    id: 'cappuccino',
    name: '暖咖',
    blurb: '主文偏白,层层渐深的暖棕调',
    palette: {
      main: 'rgba(235, 235, 235, 1)',
      italics: 'rgba(230, 210, 190, 1)',
      underline: 'rgba(205, 180, 160, 1)',
      quote: 'rgba(165, 140, 115, 1)',
    },
  },
  {
    id: 'celestial-macaron',
    name: '星河',
    blurb: '反向哲学:主文桃色突出,对白反而最低调',
    palette: {
      main: 'rgba(229, 175, 162, 1)',
      italics: 'rgba(146, 147, 161, 1)',
      underline: 'rgba(157, 215, 198, 1)',
      quote: 'rgba(197, 202, 206, 1)',
    },
  },
];

export const DEFAULT_THEME_ID = 'default';

export function getThemeById(id: string): ThemePreset {
  return THEME_PRESETS.find((t) => t.id === id) ?? THEME_PRESETS[0]!;
}
