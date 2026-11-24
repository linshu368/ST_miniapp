/**
 * 聊天背景的数据与计算（纯函数，不碰 DOM）。
 * 生效顺序：这张卡自己的 → 全部对话的 → 无。
 */

export type Appearance = 'night' | 'day';
export type BackgroundScope = 'character' | 'all';

/** 这张卡明确不用背景（即使「全部对话」设了图）。 */
export const NO_IMAGE = 'none';
/** 角色自己的封面；「全部对话」选它时每个角色用各自的封面。 */
export const COVER_IMAGE = 'cover';

export interface BackgroundChoice {
  /** NO_IMAGE / COVER_IMAGE / 本机图片 id */
  img: string;
  /** 采光 0–100，null = 自动。夜间、白天的遮罩相反，各记一个值。 */
  night: number | null;
  day: number | null;
}

export interface BackgroundPrefs {
  global: BackgroundChoice | null;
  chars: Record<string, BackgroundChoice>;
}

/** 图片里偏亮、偏暗两头的亮度（0–1），用来算遮罩和字底。 */
export interface ImageTone {
  hi: number;
  lo: number;
}

export const EMPTY_PREFS: BackgroundPrefs = { global: null, chars: {} };
/** 读不到像素（跨域、未加载完）时按两头都有处理，宁可字底厚一点。 */
export const UNKNOWN_TONE: ImageTone = { hi: 0.9, lo: 0.1 };
const MAX_CHARACTERS = 200;

const choice = (img: string): BackgroundChoice => ({ img, night: null, day: null });

function readLight(value: unknown): number | null {
  return typeof value === 'number' && value >= 0 && value <= 100 ? Math.round(value) : null;
}

function readChoice(value: unknown): BackgroundChoice | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  if (typeof source.img !== 'string' || !source.img || source.img.length > 64) return null;
  return { img: source.img, night: readLight(source.night), day: readLight(source.day) };
}

/** 存储内容不合法时按没设过处理，不影响聊天。 */
export function parseBackgroundPrefs(raw: string | null): BackgroundPrefs {
  if (!raw) return EMPTY_PREFS;
  try {
    const source: unknown = JSON.parse(raw);
    if (!source || typeof source !== 'object') return EMPTY_PREFS;
    const { global, chars } = source as Record<string, unknown>;
    const globalChoice = readChoice(global);
    const entries =
      chars && typeof chars === 'object' && !Array.isArray(chars) ? Object.entries(chars) : [];
    return {
      global: globalChoice && globalChoice.img !== NO_IMAGE ? globalChoice : null,
      chars: Object.fromEntries(
        entries
          .flatMap(([id, value]) => {
            const parsed = readChoice(value);
            return parsed ? [[id, parsed] as const] : [];
          })
          .slice(-MAX_CHARACTERS)
      ),
    };
  } catch {
    return EMPTY_PREFS;
  }
}

/** 重新插到最后，超出上限时删最久没动过的。 */
function withCharacter(
  prefs: BackgroundPrefs,
  characterId: string,
  next: BackgroundChoice | null
): BackgroundPrefs {
  const entries = Object.entries(prefs.chars).filter(([id]) => id !== characterId);
  if (next) entries.push([characterId, next]);
  return { ...prefs, chars: Object.fromEntries(entries.slice(-MAX_CHARACTERS)) };
}

/** 当前该显示的背景；null = 没有。 */
export function effectiveBackground(
  prefs: BackgroundPrefs,
  characterId: string
): BackgroundChoice | null {
  const current = prefs.chars[characterId] ?? prefs.global;
  return current && current.img !== NO_IMAGE ? current : null;
}

/** 打开面板时范围停在哪一边：没设过默认仅此角色，免得误改所有对话。 */
export function currentScope(prefs: BackgroundPrefs, characterId: string): BackgroundScope {
  if (prefs.chars[characterId]) return 'character';
  return prefs.global ? 'all' : 'character';
}

export function selectImage(
  prefs: BackgroundPrefs,
  characterId: string,
  scope: BackgroundScope,
  img: string
): BackgroundPrefs {
  if (scope === 'all') {
    const cleared = withCharacter(prefs, characterId, null);
    return { ...cleared, global: img === NO_IMAGE ? null : choice(img) };
  }
  // 没有全局图时「无」就是没设过，不必占一条。
  if (img === NO_IMAGE) {
    return withCharacter(prefs, characterId, prefs.global ? choice(NO_IMAGE) : null);
  }
  return withCharacter(prefs, characterId, choice(img));
}

/**
 * 换范围时带着当前这张图走。
 * restoreGlobal：本次打开面板期间改过全局又改回「仅此角色」，把全局还原成打开时的样子；
 * undefined = 没改过，不动全局。
 */
export function changeScope(
  prefs: BackgroundPrefs,
  characterId: string,
  scope: BackgroundScope,
  restoreGlobal?: BackgroundChoice | null
): BackgroundPrefs {
  const current = effectiveBackground(prefs, characterId);
  if (scope === 'all') {
    const following = withCharacter(prefs, characterId, null);
    // 这张卡没有图时改成「全部对话」只是跟随全局，不能顺手把别的对话的背景也清掉。
    return current ? { ...following, global: current } : following;
  }
  const base = restoreGlobal === undefined ? prefs : { ...prefs, global: restoreGlobal };
  return withCharacter(base, characterId, current);
}

export function setLight(
  prefs: BackgroundPrefs,
  characterId: string,
  appearance: Appearance,
  light: number
): BackgroundPrefs {
  const own = prefs.chars[characterId];
  if (own) return withCharacter(prefs, characterId, { ...own, [appearance]: light });
  return prefs.global ? { ...prefs, global: { ...prefs.global, [appearance]: light } } : prefs;
}

/** 删掉一张本机图：用到它的地方都回到没设过。 */
export function forgetImage(prefs: BackgroundPrefs, img: string): BackgroundPrefs {
  return {
    global: prefs.global?.img === img ? null : prefs.global,
    chars: Object.fromEntries(Object.entries(prefs.chars).filter(([, value]) => value.img !== img)),
  };
}

/* ---------- 采光：遮罩 + 字底 ---------- */

/** 各模式的底色与要读清的文字（正文、对白）的灰度，取自主题色板与线上富回复规则。 */
const SURFACES: Record<Appearance, { base: number; texts: readonly number[] }> = {
  night: { base: 0.11, texts: [0.815, 0.78] },
  day: { base: 0.965, texts: [0.205, 0.392] },
};
const READABLE_CONTRAST = 4.5;
const MAX_PLATE = 0.94;

const linear = (value: number) =>
  value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;

function contrast(a: number, b: number): number {
  const [light, dark] = [linear(a), linear(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

/** 图片上那层底色的不透明度：采光越高越透。 */
export function veilOpacity(light: number): number {
  return Number((0.96 - (0.86 * light) / 100).toFixed(3));
}

/** 正文和对白都读得清所需的最小字底；图片不碍事就是 0。 */
export function plateOpacity(light: number, appearance: Appearance, tone: ImageTone): number {
  const { base, texts } = SURFACES[appearance];
  const veil = veilOpacity(light);
  const worst = veil * base + (1 - veil) * (appearance === 'night' ? tone.hi : tone.lo);
  for (let step = 0; step / 50 <= MAX_PLATE; step += 1) {
    const plate = step / 50;
    const mixed = plate * base + (1 - plate) * worst;
    if (texts.every((text) => contrast(text, mixed) >= READABLE_CONTRAST)) return plate;
  }
  return MAX_PLATE;
}

/** 刚选图时的采光：字底只要淡淡一层就够的最大值。 */
export function autoLight(appearance: Appearance, tone: ImageTone): number {
  for (let light = 70; light > 15; light -= 1) {
    if (plateOpacity(light, appearance, tone) <= 0.3) return light;
  }
  return 15;
}

export function resolvedLight(
  background: BackgroundChoice,
  appearance: Appearance,
  tone: ImageTone
): number {
  return background[appearance] ?? autoLight(appearance, tone);
}
