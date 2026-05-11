'use client';

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useLayoutEffect,
  useMemo,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useRouter } from 'next/navigation';

import { useHaptic } from '@/lib/telegram/hooks';
import { cn } from '@/lib/utils';

/** 与聊天页 main 的 max-w-md（28rem）一致 */
const CHAT_COLUMN_MAX_PX = 448;
const COLUMN_EDGE_PAD = 12;
const MENU_BOTTOM_GAP = 8;

interface GridMenuProps {
  charName?: string;
}

interface MenuOption {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}

function getColumnBounds() {
  const vw = window.innerWidth;
  const colW = Math.min(CHAT_COLUMN_MAX_PX, vw);
  const colLeft = (vw - colW) / 2;
  return { colLeft, colRight: colLeft + colW };
}

/** 当前可见视口（WebView / iOS 缩放时 innerWidth 与可见区域可能不一致） */
function getVisualViewportXRange(): { viewLeft: number; viewWidth: number } {
  const vv = typeof window !== 'undefined' ? window.visualViewport : null;
  if (vv) {
    return { viewLeft: vv.offsetLeft, viewWidth: vv.width };
  }
  return { viewLeft: 0, viewWidth: window.innerWidth };
}

function getColumnRectFromTrigger(triggerEl: HTMLElement | null): DOMRect | null {
  const main = triggerEl?.closest('main');
  if (!main) return null;
  const r = main.getBoundingClientRect();
  return r.width > 0 && r.height >= 0 ? r : null;
}

/** 视口横向硬边界，避免菜单伸出 Mini App / 可见区域外 */
function clampLeftToVisualViewport(left: number, menuWidth: number, pad: number): number {
  const { viewLeft, viewWidth } = getVisualViewportXRange();
  const minL = viewLeft + pad;
  const maxL = viewLeft + viewWidth - pad - menuWidth;
  if (maxL >= minL) {
    return Math.min(Math.max(left, minL), maxL);
  }
  return minL;
}

/**
 * 用菜单「左边缘」定位（不再 translateX(-50%)），避免中心点 + 半宽不同步导致裁切。
 * columnRect：聊天页 `<main>` 实测边界（与假设的「居中 max-w-md」一致时才与旧逻辑相同；Telegram 内更可靠）。
 */
function clampMenuLeft(
  anchorRect: DOMRect,
  menuWidth: number,
  columnRect: DOMRect | null
): { left: number; bottom: number } {
  const vh = window.innerHeight;
  const pad = COLUMN_EDGE_PAD;

  let colLeft: number;
  let colRight: number;
  if (columnRect) {
    colLeft = columnRect.left;
    colRight = columnRect.right;
  } else {
    const fb = getColumnBounds();
    colLeft = fb.colLeft;
    colRight = fb.colRight;
  }

  const anchorCenter = anchorRect.left + anchorRect.width / 2;
  const idealLeft = anchorCenter - menuWidth / 2;
  const minLeft = colLeft + pad;
  const maxLeft = colRight - pad - menuWidth;

  let left: number;
  if (maxLeft < minLeft) {
    left = (colLeft + colRight) / 2 - menuWidth / 2;
  } else {
    left = Math.min(Math.max(idealLeft, minLeft), maxLeft);
  }

  left = clampLeftToVisualViewport(left, menuWidth, pad);

  return {
    left,
    bottom: vh - anchorRect.top + MENU_BOTTOM_GAP,
  };
}

export function GridMenu({ charName }: GridMenuProps) {
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<DOMRect | null>(null);
  const [menuPlacement, setMenuPlacement] = useState<{ left: number; bottom: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuPanelRef = useRef<HTMLDivElement>(null);
  /** 上次实测宽度，首帧钳位用，避免依赖不存在的半宽 */
  const lastMenuWidthRef = useRef(220);
  const router = useRouter();
  const haptic = useHaptic();

  const options: MenuOption[] = useMemo(
    () => [
      {
        icon: <SparklesIcon />,
        label: '模型选择',
        onClick: () => {
          console.log('模型选择');
        },
      },
      {
        icon: <TextIcon />,
        label: '回复字数',
        onClick: () => {
          console.log('回复字数');
        },
      },
      {
        icon: <ChatIcon />,
        label: '新建对话',
        onClick: () => {
          if (charName) {
            router.push('/');
          }
        },
      },
    ],
    [charName, router]
  );

  const handleToggle = useCallback(() => {
    haptic.impact('light');
    if (!open) {
      const rect = triggerRef.current?.getBoundingClientRect() ?? null;
      setAnchorRect(rect);
    }
    setOpen((prev) => !prev);
  }, [haptic, open]);

  const handleSelect = useCallback(
    (option: () => void) => {
      haptic.impact('medium');
      setOpen(false);
      option();
    },
    [haptic]
  );

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (e: Event) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuPanelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('touchstart', handlePointerDown, { passive: true });
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('touchstart', handlePointerDown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setMenuPlacement(null);
      return;
    }
    if (!anchorRect) return;
    const el = menuPanelRef.current;
    if (!el) return;
    const w = Math.ceil(el.getBoundingClientRect().width);
    if (w <= 0) return;
    lastMenuWidthRef.current = w;
    const col = getColumnRectFromTrigger(triggerRef.current);
    setMenuPlacement(clampMenuLeft(anchorRect, w, col));
  }, [open, anchorRect, options]);

  useEffect(() => {
    if (!open || !anchorRect) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const sync = () => {
      const el = menuPanelRef.current;
      if (!el || !anchorRect) return;
      const w = Math.ceil(el.getBoundingClientRect().width);
      if (w <= 0) return;
      lastMenuWidthRef.current = w;
      const col = getColumnRectFromTrigger(triggerRef.current);
      setMenuPlacement(clampMenuLeft(anchorRect, w, col));
    };
    vv.addEventListener('resize', sync);
    vv.addEventListener('scroll', sync);
    return () => {
      vv.removeEventListener('resize', sync);
      vv.removeEventListener('scroll', sync);
    };
  }, [open, anchorRect]);

  const maxW = `min(${CHAT_COLUMN_MAX_PX - COLUMN_EDGE_PAD * 2}px, calc(100vw - ${COLUMN_EDGE_PAD * 2}px))`;

  const menuContent =
    open && anchorRect ? (
      <div
        ref={menuPanelRef}
        style={{
          position: 'fixed',
          ...(menuPlacement ??
            clampMenuLeft(
              anchorRect,
              lastMenuWidthRef.current,
              getColumnRectFromTrigger(triggerRef.current)
            )),
          zIndex: 10000,
          maxWidth: maxW,
          width: 'max-content',
        }}
      >
        <div className="relative animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1 duration-150">
          <div className="flex w-max max-w-[min(424px,calc(100vw-24px))] min-w-[160px] flex-col gap-0.5 rounded-[16px] border border-white/10 bg-[#1a1f2a]/98 p-1.5 shadow-xl backdrop-blur-xl">
            {options.map((option) => (
              <button
                key={option.label}
                type="button"
                onClick={() => handleSelect(option.onClick)}
                className="flex items-center gap-2.5 rounded-[12px] px-3 py-2.5 text-left text-sm text-white/85 transition-colors hover:bg-white/8 active:bg-white/5"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-white/6">
                  {option.icon}
                </span>
                <span>{option.label}</span>
              </button>
            ))}
          </div>
          <div
            className="absolute left-1/2 top-full mt-[-4px] h-2 w-2 -translate-x-1/2 rotate-45 border border-white/10 border-t-0 border-l-0 bg-[#1a1f2a]/98"
            aria-hidden
          />
        </div>
      </div>
    ) : null;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label="菜单"
        aria-expanded={open}
        onClick={handleToggle}
        className={cn(
          'grid h-[38px] w-[38px] shrink-0 place-items-center rounded-[14px] border transition-colors active:scale-95',
          open
            ? 'border-white/10 bg-[#1e2330] text-white/75'
            : 'border-white/10 bg-transparent text-[#8a9bb0] hover:text-white/70'
        )}
      >
        <GridIcon />
      </button>

      {typeof document !== 'undefined' && menuContent
        ? createPortal(menuContent, document.body)
        : null}
    </div>
  );
}

function GridIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

function SparklesIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      className="h-5 w-5 text-[#8a9bb0]"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3v3m6.36-2.36l-2.12 2.12M21 12h-3m2.36 6.36l-2.12-2.12M12 21v-3m-6.36 2.36l2.12-2.12M3 12h3m-2.36-6.36l2.12 2.12" />
    </svg>
  );
}

function TextIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      className="h-5 w-5 text-[#8a9bb0]"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 7V4h16v3" />
      <path d="M9 20h6" />
      <path d="M12 4v16" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      className="h-5 w-5 text-[#8a9bb0]"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M8 10h8M8 14h4" />
    </svg>
  );
}
