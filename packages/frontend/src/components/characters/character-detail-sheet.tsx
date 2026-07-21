'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Heart, Quote, Sparkles, X } from 'lucide-react';

import { useCharacterQuery } from '@/lib/api/characters';
import { useFavoriteIdsQuery, useSetFavoriteMutation } from '@/lib/api/favorites';
import { prefetchEnsureStCharacter } from '@/lib/api/st-bridge';
import { characterRoomGradient } from '@/lib/utils/character-hue';
import { lobbyImageUrl } from './character-card';

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
  const favoriteIds = useFavoriteIdsQuery();
  const setFavorite = useSetFavoriteMutation();
  const favorited = character
    ? (favoriteIds.data?.character_ids.includes(character.id) ?? false)
    : false;

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

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    touchStart.current = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
    setIsDragging(true);
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    const dy = e.touches[0]!.clientY - touchStart.current.y;
    const dx = e.touches[0]!.clientX - touchStart.current.x;
    const scrollTop = scrollRef.current?.scrollTop ?? 0;
    if (dy > 0 && Math.abs(dy) >= Math.abs(dx) && scrollTop === 0) {
      setDragY(dy);
    }
  }, []);

  const handleTouchEnd = useCallback(
    (e: React.TouchEvent) => {
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
    [onClose]
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
        onClick={onClose}
        aria-hidden="true"
      />

      {/* 预览卡：占屏 75dvh 的沉浸式弹窗 */}
      <div
        className="absolute inset-x-0 bottom-0 mx-auto flex w-full max-w-[430px] flex-col overflow-hidden rounded-t-[30px] border border-border bg-card/95 text-card-foreground shadow-[0_-20px_80px_rgba(0,0,0,0.35)]"
        style={{
          height: '75dvh',
          transform: visible ? `translateY(${dragY}px)` : 'translateY(100%)',
          transition: isDragging ? 'none' : 'transform 0.36s cubic-bezier(0.32, 0.72, 0, 1)',
          touchAction: 'pan-y',
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        {/* 可滚动主体：桌面支持滚轮，移动端支持触控，视觉上隐藏滚动条。 */}
        <div
          ref={scrollRef}
          className="character-detail-scroll flex-1 overflow-y-auto overscroll-contain"
          style={{ touchAction: 'pan-y' }}
        >
          {/* Hero 图 */}
          <div className="relative aspect-[3/4] max-h-[42dvh] w-full overflow-hidden">
            {isLoading ? (
              <div className="h-full w-full animate-pulse bg-muted" />
            ) : hasAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={lobbyImageUrl(character!.avatar_url)}
                alt={character!.name}
                width={360}
                height={480}
                loading="eager"
                fetchPriority="high"
                decoding="async"
                className="h-full w-full object-cover object-top"
              />
            ) : (
              <div className="h-full w-full" style={{ background: gradient }} />
            )}

            {/* 底部渐变压暗，承接名字/标签 */}
            <div className="absolute inset-x-0 bottom-0 h-3/4 bg-gradient-to-t from-card via-card/75 to-transparent" />

            {/* 拖拽把手覆盖在图片上，避免弹窗顶部留下空白。 */}
            <div className="pointer-events-none absolute inset-x-0 top-2.5 z-10 flex justify-center">
              <div className="h-1 w-10 rounded-full bg-white/45 shadow-sm" />
            </div>

            {/* 关闭按钮 */}
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="absolute right-3 top-3 flex h-8 w-8 items-center justify-center rounded-full bg-black/40 text-white/90 backdrop-blur-md transition-colors hover:bg-black/60 active:scale-95"
            >
              <X className="h-4 w-4" />
            </button>

            {!isLoading && character && (
              <div className="absolute inset-x-0 bottom-0 px-5 pb-4">
                <h2 className="text-[26px] font-semibold leading-tight text-foreground">
                  {character.name}
                </h2>
                {character.author_name && (
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    by {character.author_name}
                  </p>
                )}
                {character.personality_tags.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {character.personality_tags.slice(0, 6).map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-muted px-2.5 py-[3px] text-[11px] font-medium text-foreground ring-1 ring-inset ring-border"
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
                <div key={i} className="h-3 animate-pulse rounded bg-muted" />
              ))}
            </div>
          ) : character ? (
            <div
              className="flex flex-col gap-5 px-5 pt-4"
              style={{ paddingBottom: 'calc(6rem + env(safe-area-inset-bottom))' }}
            >
              {/* 角色简介 */}
              <section>
                <p className="mb-2 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
                  <Sparkles className="h-3 w-3" />
                  角色简介
                </p>
                {description ? (
                  <p className="whitespace-pre-wrap text-[14px] leading-relaxed text-foreground/85">
                    {description}
                  </p>
                ) : (
                  <p className="text-[13px] leading-relaxed text-muted-foreground">
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
                    className="flex w-full items-center justify-between text-[11px] font-medium uppercase tracking-[0.18em] text-muted-foreground"
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
                    <blockquote className="mt-2.5 rounded-2xl border border-border border-l-2 border-l-primary/60 bg-muted/60 px-4 py-3">
                      <p className="whitespace-pre-wrap text-[13px] italic leading-relaxed text-foreground/80">
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
          className="shrink-0 border-t border-border bg-card/95 px-5 py-3 backdrop-blur-md"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 0.75rem)' }}
        >
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="h-12 shrink-0 rounded-2xl border border-border bg-background px-5 text-[14px] font-medium text-foreground transition-colors hover:bg-muted active:scale-[0.98]"
            >
              {entering ? '取消进入' : '先看看别的'}
            </button>
            <button
              type="button"
              disabled={!character || setFavorite.isPending}
              aria-label={favorited ? '取消收藏' : '收藏角色'}
              aria-pressed={favorited}
              onClick={() =>
                character &&
                setFavorite.mutate({ characterId: character.id, favorited: !favorited })
              }
              className={`flex size-12 shrink-0 items-center justify-center rounded-2xl border transition active:scale-95 ${
                favorited
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-background text-muted-foreground'
              }`}
            >
              <Heart className={`h-5 w-5 ${favorited ? 'fill-current' : ''}`} />
            </button>
            <button
              type="button"
              disabled={!character || entering}
              onClick={() => character && onEnter(character.id)}
              className="relative flex h-12 flex-1 items-center justify-center gap-1.5 overflow-hidden rounded-2xl bg-primary text-[15px] font-semibold text-primary-foreground shadow-lg shadow-primary/20 transition-all hover:bg-primary/90 active:scale-[0.98] disabled:opacity-70"
            >
              <Sparkles className={`h-4 w-4 ${entering ? 'animate-spin' : ''}`} />
              {entering ? '正在进入…' : '进入角色'}
              {entering && (
                <span className="absolute inset-x-3 bottom-1 h-1 overflow-hidden rounded-full bg-black/20">
                  <span
                    className="block h-full w-2/5 rounded-full bg-white/85 shadow-[0_0_8px_rgba(255,255,255,0.7)]"
                    style={{ animation: 'character-entry-progress 1.35s ease-in-out infinite' }}
                  />
                </span>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
