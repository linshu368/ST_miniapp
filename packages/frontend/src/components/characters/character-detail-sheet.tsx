'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Hash, PenLine, Quote, X } from 'lucide-react';

import { useCharacterQuery } from '@/lib/api/characters';
import { characterRoomGradient } from '@/lib/utils/character-hue';

// ─── 手势常量 ────────────────────────────────────────────────
const DISMISS_THRESHOLD_Y = 80; // 下滑超过 80px 即关闭
const DISMISS_THRESHOLD_X = 60; // 右滑超过 60px（且主方向为横向）即关闭

function SectionLabel({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return (
    <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-widest text-muted-foreground/60">
      {icon}
      {children}
    </p>
  );
}

// ─── Props ───────────────────────────────────────────────────
interface CharacterDetailSheetProps {
  characterId: string | null;
  onClose: () => void;
}

// ─── 主组件 ──────────────────────────────────────────────────
export function CharacterDetailSheet({ characterId, onClose }: CharacterDetailSheetProps) {
  const { data, isLoading } = useCharacterQuery(characterId ?? undefined);
  const character = data?.character;

  // ── 动画状态 ──────────────────────────────────────────────
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (characterId) {
      setMounted(true);
      // 下一帧再设 visible=true，触发 CSS transition
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    } else {
      setVisible(false);
      const t = setTimeout(() => setMounted(false), 320);
      return () => clearTimeout(t);
    }
  }, [characterId]);

  // ── 拖拽状态 ──────────────────────────────────────────────
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const touchStart = useRef({ x: 0, y: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
    setIsDragging(true);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const dx = e.touches[0]!.clientX - touchStart.current.x;
    const dy = e.touches[0]!.clientY - touchStart.current.y;
    const scrollTop = scrollRef.current?.scrollTop ?? 0;

    // 纵向下滑：内容已滚到顶才允许拖拽关闭
    if (dy > 0 && Math.abs(dy) >= Math.abs(dx) && scrollTop === 0) {
      e.preventDefault();
      setDragY(dy);
      return;
    }
    // 横向右滑：主方向为横向时允许
    if (dx > 0 && Math.abs(dx) > Math.abs(dy) * 1.5) {
      e.preventDefault();
      setDragY(dx * 0.4); // 轻微跟手，给视觉反馈
    }
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      const dx = e.changedTouches[0]!.clientX - touchStart.current.x;
      const dy = e.changedTouches[0]!.clientY - touchStart.current.y;
      setIsDragging(false);

      const scrollTop = scrollRef.current?.scrollTop ?? 0;
      const dismissByY = dy > DISMISS_THRESHOLD_Y && scrollTop === 0;
      const dismissByX = dx > DISMISS_THRESHOLD_X && Math.abs(dx) > Math.abs(dy) * 1.5;

      if (dismissByY || dismissByX) {
        setDragY(0);
        onClose();
      } else {
        setDragY(0);
      }
    },
    [onClose]
  );

  if (!mounted || typeof document === 'undefined') return null;

  const gradient = characterRoomGradient(character?.id ?? 'fallback');
  const hasAvatar = !!character?.avatar_url;

  // 弹出高度 88dvh → 上方露出 12% 画廊，让层叠感更明显
  const SHEET_H = '88dvh';

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      {/* 背景遮罩：点击关闭 */}
      <div
        className="absolute inset-0 bg-black/50 transition-opacity duration-300"
        style={{ opacity: visible ? 1 : 0 }}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* 抽屉面板 */}
      <div
        className="absolute inset-x-0 bottom-0 flex flex-col overflow-hidden rounded-t-2xl border-t border-border/40 bg-card"
        style={{
          height: SHEET_H,
          transform: visible ? `translateY(${dragY}px)` : 'translateY(100%)',
          transition: isDragging ? 'none' : 'transform 0.32s cubic-bezier(0.32, 0.72, 0, 1)',
          touchAction: 'none', // 交给我们的处理器，避免浏览器默认滚动冲突
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* 拖拽把手 */}
        <div className="flex shrink-0 justify-center pb-1 pt-3">
          <div className="h-1 w-10 rounded-full bg-border/80" />
        </div>

        {/* 可滚动主体 */}
        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto"
          // 内容区恢复正常滚动
          style={{ touchAction: 'auto', paddingBottom: 'calc(5rem + env(safe-area-inset-bottom))' }}
        >
          {/* Hero 图 */}
          <div className="relative h-[260px] w-full overflow-hidden">
            {isLoading ? (
              <div className="h-full w-full animate-pulse bg-muted" />
            ) : hasAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={character!.avatar_url}
                alt={character!.name}
                className="h-full w-full object-cover object-top"
              />
            ) : (
              <div className="h-full w-full" style={{ background: gradient }} />
            )}
            <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-card via-card/60 to-transparent" />
            {/* 右上角关闭按钮 */}
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white/90 backdrop-blur-md transition-colors active:bg-black/60"
            >
              <X className="h-4 w-4" />
            </button>
            {!isLoading && character && (
              <div className="absolute inset-x-0 bottom-0 px-5 pb-4">
                <h2 className="text-[24px] font-semibold leading-tight text-foreground">
                  {character.name}
                </h2>
                <p className="mt-0.5 text-[12px] text-muted-foreground">
                  by {character.author_name}
                </p>
              </div>
            )}
          </div>

          {/* 正文 */}
          {isLoading ? (
            <div className="flex flex-col gap-4 px-5 pt-5">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-3 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : character ? (
            <div className="flex flex-col gap-6 px-5 pt-5">
              {character.personality_tags.length > 0 && (
                <section>
                  <SectionLabel icon={<Hash className="h-3 w-3" />}>标签</SectionLabel>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {character.personality_tags.map((pt) => (
                      <span
                        key={pt}
                        className="rounded-full border border-border/50 bg-secondary/40 px-2.5 py-0.5 text-[12px] text-secondary-foreground/80"
                      >
                        {pt}
                      </span>
                    ))}
                  </div>
                </section>
              )}

              <section>
                <SectionLabel icon={<PenLine className="h-3 w-3" />}>作者说</SectionLabel>
                <div className="mt-2 rounded-xl border border-border/40 bg-background/70 px-4 py-3 shadow-sm">
                  <div className="whitespace-pre-wrap text-[14px] leading-relaxed text-foreground/80">
                    {(() => {
                      const full = [character.description, character.creator_notes]
                        .filter(Boolean)
                        .join('\n\n');
                      return full.length > 220 ? full.slice(0, 220) + '…' : full;
                    })()}
                  </div>
                </div>
              </section>

              <section>
                <SectionLabel icon={<Quote className="h-3 w-3" />}>开场白</SectionLabel>
                <blockquote className="mt-2 rounded-xl border border-border/40 border-l-2 border-l-primary/60 bg-background/70 px-4 py-3 shadow-sm">
                  <p className="line-clamp-[15] whitespace-pre-wrap text-[13px] italic leading-snug text-foreground/90">
                    &quot;{character.greeting}&quot;
                  </p>
                </blockquote>
              </section>
            </div>
          ) : null}
        </div>

        {/* 滚动末端 → CTA 渐变过渡:在 CTA 上方叠一层 fade,缓解被切断感 */}
        <div
          className="pointer-events-none absolute inset-x-0 bottom-[64px] h-5 bg-gradient-to-t from-card to-transparent"
          style={{ bottom: 'calc(env(safe-area-inset-bottom) + 64px)' }}
          aria-hidden="true"
        />

        {/* 固定底部 CTA */}
        <div
          className="shrink-0 border-t border-border/50 bg-card/95 px-5 py-3 backdrop-blur-md"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
        >
          <button
            type="button"
            disabled
            className="flex w-full items-center justify-center rounded-xl bg-primary py-3.5 text-[15px] font-semibold text-primary-foreground shadow-lg transition-opacity disabled:opacity-50 active:opacity-80"
          >
            聊天入口搭建中
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
