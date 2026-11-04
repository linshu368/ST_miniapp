'use client';

import Link from 'next/link';
import { cn } from '@/lib/utils';
import { canPrefetchInBackground } from '@/lib/background-prefetch';
import { NibIcon, PersonIcon, ScreenIcon, SparkIcon, TicketIcon, type NavIcon } from './nav-icons';

type NavItem = { href: string; label: string; Icon: NavIcon; center?: true };

// 名称按页面职责取：放映=沉浸刷剧，剧场=找剧追剧，秘境=角色大厅（冷启动落地页，居中）。
const NAV_ITEMS: readonly NavItem[] = [
  { href: '/watch', label: '放映', Icon: ScreenIcon },
  { href: '/dramas', label: '剧场', Icon: TicketIcon },
  { href: '/characters', label: '秘境', Icon: SparkIcon, center: true },
  { href: '/creation', label: '创作', Icon: NibIcon },
  { href: '/profile', label: '我的', Icon: PersonIcon },
];

const HEAVY_ROUTE_HREFS = new Set<string>(['/watch', '/dramas', '/creation']);
const EASE_OUT = 'ease-[cubic-bezier(0.22,1,0.36,1)]';

export function isCreationRoute(pathname: string | null | undefined): boolean {
  return Boolean(
    pathname &&
    ['/creation', '/create'].some(
      (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
    )
  );
}

function isRoleplayPath(pathname: string | null | undefined): boolean {
  return pathname === '/characters' || pathname === '/chats';
}

/** 底栏某一项是否覆盖该路径：秘境含对话列表，创作含 /create 子页，放映只认自身。 */
function matchesNavItem(href: string, pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  if (href === '/characters') return isRoleplayPath(pathname);
  if (href === '/creation') return isCreationRoute(pathname);
  if (href === '/watch') return pathname === '/watch';
  return pathname.startsWith(href);
}

// 深层页面（支付流程、沉浸式输入页、消息与客服会话）隐藏底部导航，让主内容拿满可视高度
const HIDDEN_PREFIXES = [
  '/profile/recharge',
  '/profile/messages',
  '/profile/support',
  '/create/studio',
  '/creation/characters',
  '/creators',
  '/creation/data',
  '/wishes',
  '/vip',
];

export function isBottomNavHidden(pathname: string | null, controlsVisible = true) {
  return Boolean(
    pathname &&
    ((pathname === '/watch' && !controlsVisible) ||
      HIDDEN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)) ||
      /^\/dramas\/[^/]+/.test(pathname))
  );
}

/** 选中项下方的香槟光底：只动 transform/opacity，切换时从原位置滑到新位置。 */
function ActivePill({ index }: { index: number }) {
  const visible = index >= 0 && !NAV_ITEMS[index]?.center;
  return (
    <span
      aria-hidden="true"
      className={cn(
        'absolute left-[5px] top-[6px] h-[44px] w-[calc(20%-10px)] rounded-[16px] bg-[#d9b88a]/[0.12] transition-[transform,opacity] duration-[420ms] motion-reduce:transition-none',
        EASE_OUT
      )}
      style={{
        transform: `translateX(calc(${Math.max(index, 0)} * (100% + 10px)))`,
        opacity: visible ? 1 : 0,
      }}
    />
  );
}

function NavItemContent({
  item,
  active,
  showUnread,
}: {
  item: NavItem;
  active: boolean;
  showUnread: boolean;
}) {
  const { Icon, label, center } = item;
  const labelNode = (
    <span
      className={cn(
        'shrink-0 whitespace-nowrap text-[10.5px] leading-none tracking-[0.06em] transition-colors duration-200',
        active ? 'font-semibold text-[#f1dfc3]' : 'font-medium'
      )}
    >
      {label}
    </span>
  );
  if (center) {
    return (
      <>
        {/* 凸出岛面的圆钮：行高固定 56px、底部对齐，超出部分向上溢出。选中时外圈提亮并带柔光。 */}
        <span
          className={cn(
            'grid h-[50px] w-[50px] shrink-0 place-items-center rounded-full bg-[radial-gradient(120%_120%_at_30%_20%,#3a3029_0%,#1d1a1c_60%)] text-[#d9b88a] transition-[box-shadow,transform] duration-300 group-active:scale-[0.94] motion-reduce:transition-none',
            active
              ? 'shadow-[0_0_0_1px_rgba(241,223,195,0.7),0_0_22px_rgba(217,184,138,0.36),0_8px_20px_rgba(0,0,0,0.6)]'
              : 'shadow-[0_0_0_1px_rgba(217,184,138,0.35),0_8px_20px_rgba(0,0,0,0.6)]'
          )}
        >
          <Icon className="h-[25px] w-[25px]" />
        </span>
        {labelNode}
      </>
    );
  }
  return (
    <>
      <span
        className={cn(
          'relative shrink-0 transition-[color,transform] duration-200 group-active:scale-[0.9] motion-reduce:transition-none',
          active ? 'text-[#d9b88a]' : undefined
        )}
      >
        <Icon className="h-[23px] w-[23px]" />
        {showUnread ? (
          <span
            role="status"
            aria-label="有未读消息"
            className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-[#d9919b] ring-2 ring-[#1b191b]"
          />
        ) : null}
      </span>
      {labelNode}
    </>
  );
}

/** 启动时只复用导航展示，不读取身份、storage 或挂业务 query。 */
export function BottomNavShell({
  pathname,
  controlsVisible = true,
  highlighted = pathname,
  roleplayHref = '/characters',
  hasUnread = false,
  onIntent,
  onNavigate,
}: {
  pathname: string;
  controlsVisible?: boolean;
  highlighted?: string | null;
  roleplayHref?: '/characters' | '/chats';
  hasUnread?: boolean;
  onIntent?: (href: string) => void;
  onNavigate?: (
    event: React.MouseEvent<HTMLAnchorElement>,
    targetHref: string,
    href: string,
    current: boolean
  ) => void;
}) {
  if (isBottomNavHidden(pathname, controlsVisible)) return null;
  const currentRoleplayPath = isRoleplayPath(pathname) ? pathname : null;
  const activeIndex = NAV_ITEMS.findIndex(({ href }) => matchesNavItem(href, highlighted));
  return (
    // 不用 backdrop-blur：导航悬浮在持续滚动、带流光动画的列表上方，模糊要每帧重采样背后内容，
    // 弱机 WebView 上会占满合成线程。岛外只铺一层静态渐隐，让内容自然沉到岛下。
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center bg-[linear-gradient(to_bottom,rgba(25,23,26,0),rgba(25,23,26,0.94)_45%,#19171a)]"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <nav aria-label="主导航" className="relative h-[var(--app-nav-height)] w-full max-w-lg">
        {/* 有底部安全区时岛下沉一点，避免 iOS 上离 Home 条过远；没有时保留 10px 悬浮间距。 */}
        <div
          className="pointer-events-auto absolute inset-x-3 grid h-14 grid-cols-5 grid-rows-[3.5rem] rounded-[22px] bg-[linear-gradient(180deg,#221f22,#181618)] text-[#8f878c] shadow-[inset_0_0.5px_0_rgba(241,223,195,0.16),0_12px_28px_rgba(0,0,0,0.55)]"
          style={{ bottom: 'calc(0.625rem - min(env(safe-area-inset-bottom), 1rem))' }}
        >
          <ActivePill index={activeIndex} />
          {NAV_ITEMS.map((item, index) => {
            const { href, label } = item;
            const targetHref =
              href === '/characters' ? (currentRoleplayPath ?? roleplayHref) : href;
            const current = matchesNavItem(href, pathname);
            const prefetchOnIntent = () => {
              if (!current && (!HEAVY_ROUTE_HREFS.has(href) || canPrefetchInBackground())) {
                onIntent?.(targetHref);
              }
            };
            return (
              <Link
                key={href}
                href={targetHref}
                prefetch={false}
                scroll={href === '/characters' ? false : undefined}
                // 底栏常驻；关闭视口自动预取，只在明确 hover/focus/touch 意图时拉目标路由。
                onMouseEnter={prefetchOnIntent}
                onFocus={prefetchOnIntent}
                onTouchStart={prefetchOnIntent}
                onClick={(event) => onNavigate?.(event, targetHref, href, current)}
                aria-current={current ? 'page' : undefined}
                aria-label={label}
                className={cn(
                  'group relative flex h-14 min-w-0 flex-col items-center justify-end rounded-[16px] pb-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[#d9b88a]/70',
                  item.center ? 'gap-[3px]' : 'gap-[5px] hover:text-[#eee7e2]'
                )}
              >
                <NavItemContent
                  item={item}
                  active={index === activeIndex}
                  showUnread={href === '/profile' && hasUnread}
                />
              </Link>
            );
          })}
        </div>
      </nav>
    </div>
  );
}
