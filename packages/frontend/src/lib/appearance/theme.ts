import type { Appearance } from '@/lib/appearance/chat-background';

export const THEME_KEY = 'st_miniapp_theme';

/** 剧场和放映始终是深色；弹层挂在 body 上，所以按路由整页切，不靠局部包一层。 */
const ALWAYS_NIGHT = /^\/(?:watch|dramas)(?:\/|$)/;

export function isAlwaysNight(pathname: string | null | undefined): boolean {
  return ALWAYS_NIGHT.test(pathname ?? '');
}

/** 当前这一屏实际该用的外观。 */
export function effectiveAppearance(
  theme: Appearance,
  pathname: string | null | undefined
): Appearance {
  return isAlwaysNight(pathname) ? 'night' : theme;
}

/** null = 用户从没切换过。 */
export function readStoredTheme(): Appearance | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(THEME_KEY);
    return raw === 'day' || raw === 'night' ? raw : null;
  } catch {
    return null;
  }
}

export function paintAppearance(appearance: Appearance): void {
  document.documentElement.classList.toggle('dark', appearance === 'night');
}

/** 首帧前执行：选过白天的人打开时不会先闪一下黑。服务端始终输出夜间。 */
export const THEME_SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(THEME_KEY)})==='day'&&!${ALWAYS_NIGHT.toString()}.test(location.pathname))document.documentElement.classList.remove('dark')}catch(e){}`;
