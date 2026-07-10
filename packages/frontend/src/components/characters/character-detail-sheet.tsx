'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Quote, Sparkles, X } from 'lucide-react';

import { useCharacterQuery } from '@/lib/api/characters';
import { prefetchEnsureStCharacter } from '@/lib/api/st-bridge';
import { characterRoomGradient } from '@/lib/utils/character-hue';

// ─── 手势常量 ────────────────────────────────────────────────
const DISMISS_THRESHOLD_Y = 90; // 下滑超过该值即关闭

// ─── Props ───────────────────────────────────────────────────
interface CharacterDetailSheetProps {
  characterId: string | null;
  onClose: () => void;
  onEnter: (characterId: string) => void;
  entering?: boolean;
}

// ─── 主组件 ──────────────────────────────────────────────────
export function CharacterDetailSheet({
  characterId,
  onClose,
  onEnter,
  entering = false,
}: CharacterDetailSheetProps) {
  const { data, isLoading } = useCharacterQuery(characterId ?? undefined);
  const character = data?.character;

  // ── 动画状态 ──────────────────────────────────────────────
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [greetingOpen, setGreetingOpen] = useState(false);

  useEffect(() => {
    if (characterId) {
      setMounted(true);
      setGreetingOpen(false);
      // 浮层期懒下发预取：用户读简介的时间掩盖单卡下发耗时（幂等，失败静默，
      // 对话页会 await 同一个 promise 并有 selectCharacter 侧兜底）。
      prefetchEnsureStCharacter(characterId).catch(() => {});
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = setTimeout(() => setMounted(false), 320);
    return () => clearTimeout(t);
  }, [characterId]);

  // ── 拖拽关闭 ──────────────────────────────────────────────
  const [dragY, setDragY] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const touchStart = useRef({ x: 0, y: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (entering) return;
      touchStart.current = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
      setIsDragging(true);
    },
    [entering]
  );

  const handleTouchMove = useCallback(
    (e: React.TouchEvent) => {
      if (entering) return;
      const dy = e.touches[0]!.clientY - touchStart.current.y;
      const dx = e.touches[0]!.clientX - touchStart.current.x;
      const scrollTop = scrollRef.current?.scrollTop ?? 0;
      if (dy > 0 && Math.abs(dy) >= Math.abs(dx) && scrollTop === 0) {
        setDragY(dy);
      }
    },
    [entering]
  );

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (entering) return;
      const dy = e.changedTouches[0]!.clientY - touchStart.current.y;
      setIsDragging(false);
      const scrollTop = scrollRef.current?.scrollTop ?? 0;
      if (dy > DISMISS_THRESHOLD_Y && scrollTop === 0) {
        setDragY(0);
        onClose();
      } else {
        setDragY(0);
      }
    },
    [entering, onClose]
  );

  if (!mounted || typeof document === 'undefined') return null;

  const gradient = characterRoomGradient(character?.id ?? 'fallback');
  const hasAvatar = !!character?.avatar_url;
  const description = character?.description?.trim() ?? '';
  const greeting = character?.greeting?.trim() ?? '';

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true">
      {/* 背景遮罩：模糊 + 压暗，点击关闭 */}
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-md transition-opacity duration-300"
        style={{ opacity: visible ? 1 : 0 }}
        onClick={entering ? undefined : onClose}
        aria-hidden="true"
      />

      {/* 预览卡：占屏 75dvh 的沉浸式弹窗 */}
      <div
        className="absolute inset-x-0 bottom-0 mx-auto flex w-[calc(100vw-1.5rem)] max-w-[430px] flex-col overflow-hidden rounded-t-[30px] border border-white/10 bg-[#0f0b16]/95 shadow-[0_-20px_80px_rgba(0,0,0,0.55)]"
        style={{
          height: '75dvh',
          transform: visible ? `translateY(${dragY}px)` : 'translateY(100%)',
          transition: isDragging ? 'none' : 'transform 0.36s cubic-bezier(0.32, 0.72, 0, 1)',
          touchAction: 'none',
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* 拖拽把手 */}
        <div className="flex shrink-0 justify-center pb-1 pt-2.5">
          <div className="h-1 w-10 rounded-full bg-white/25" />
        </div>

        {/* 可滚动主体 */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto" style={{ touchAction: 'auto' }}>
          {/* Hero 图 */}
          <div className="relative aspect-[3/4] max-h-[42dvh] w-full overflow-hidden">
            {isLoading ? (
              <div className="h-full w-full animate-pulse bg-white/5" />
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

            {/* 底部渐变压暗，承接名字/标签 */}
            <div className="absolute inset-x-0 bottom-0 h-3/4 bg-gradient-to-t from-[#0f0b16] via-[#0f0b16]/70 to-transparent" />

            {/* 关闭按钮 */}
            <button
              type="button"
              onClick={onClose}
              disabled={entering}
              aria-label="关闭"
              className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white/90 backdrop-blur-md transition-colors hover:bg-black/60 disabled:opacity-40"
            >
              <X className="h-4 w-4" />
            </button>

            {!isLoading && character && (
              <div className="absolute inset-x-0 bottom-0 px-5 pb-4">
                <h2 className="text-[26px] font-semibold leading-tight text-white drop-shadow-[0_2px_12px_rgba(0,0,0,0.5)]">
                  {character.name}
                </h2>
                {character.author_name && (
                  <p className="mt-1 text-[12px] text-white/55">by {character.author_name}</p>
                )}
                {character.personality_tags.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {character.personality_tags.slice(0, 6).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-white/12 px-2.5 py-[3px] text-[11px] font-medium text-white/90 ring-1 ring-inset ring-white/15 backdrop-blur-[2px]"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 正文 */}
          {isLoading ? (
            <div className="flex flex-col gap-3 px-5 pt-5">
              {[...Array(4)].map((_, i) => (
                <div key={i} className="h-3 animate-pulse rounded bg-white/8" />
              ))}
            </div>
          ) : character ? (
            <div
              className="flex flex-col gap-5 px-5 pt-4"
              style={{ paddingBottom: 'calc(6rem + env(safe-area-inset-bottom))' }}
            >
              {/* 角色简介 */}
              <section>
                <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-white/40">
                  <Sparkles className="h-3 w-3" />
                  角色简介
                </p>
                {description ? (
                  <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-white/80">
                    {description}
                  </p>
                ) : (
                  <p className="text-[13px] leading-relaxed text-white/45">
                    这个角色还没有公开简介，进入后直接开始探索 TA 的世界。
                  </p>
                )}
              </section>

              {/* 开场白：默认折叠 */}
              {greeting && (
                <section>
                  <button
                    type="button"
                    onClick={() => setGreetingOpen((v) => !v)}
                    className="flex w-full items-center justify-between text-[11px] font-medium uppercase tracking-[0.18em] text-white/40"
                  >
                    <span className="flex items-center gap-1.5">
                      <Quote className="h-3 w-3" />
                      开场白
                    </span>
                    <ChevronDown
                      className={`h-4 w-4 transition-transform duration-300 ${
                        greetingOpen ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  {greetingOpen && (
                    <blockquote className="mt-2.5 rounded-2xl border border-white/10 border-l-2 border-l-primary/60 bg-white/[0.03] px-4 py-3">
                      <p className="whitespace-pre-wrap text-[13px] italic leading-relaxed text-white/75">
                        {greeting}
                      </p>
                    </blockquote>
                  )}
                </section>
              )}
            </div>
          ) : null}
        </div>

        {/* 固定底部：先看看别的 / 进入角色 */}
        <div
          className="shrink-0 border-t border-white/10 bg-[#0f0b16]/95 px-5 py-3 backdrop-blur-md"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
        >
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              disabled={entering}
              className="h-12 shrink-0 rounded-2xl border border-white/12 bg-white/5 px-5 text-[14px] font-medium text-white/70 transition-colors hover:bg-white/10 active:scale-[0.98] disabled:opacity-40"
            >
              先看看别的
            </button>
            <button
              type="button"
              disabled={!character || entering}
              onClick={() => character && onEnter(character.id)}
              className="flex h-12 flex-1 items-center justify-center gap-1.5 rounded-2xl bg-gradient-to-r from-indigo-500 to-fuchsia-500 text-[15px] font-semibold text-white shadow-lg shadow-indigo-500/25 transition-all active:scale-[0.98] disabled:opacity-50"
            >
              <Sparkles className={`h-4 w-4 ${entering ? 'animate-spin' : ''}`} />
              {entering ? '正在进入…' : '进入角色'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
