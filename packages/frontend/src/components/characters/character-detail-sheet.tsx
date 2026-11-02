'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, Loader2, Quote, Sparkles, X } from 'lucide-react';
import type { CharacterSummary, ChatSession } from '@miniapp/shared';
import { useCharacterQuery } from '@/lib/api/characters';
import { useConversationsQuery } from '@/lib/api/conversations';
import { useCharacterSocialQuery } from '@/lib/api/character-social';
import { characterRoomGradient } from '@/lib/utils/character-hue';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { lobbyImageUrl } from './character-card';
import { CharacterSocialBar, socialCount } from './character-social-bar';
import { CharacterComments } from './character-comments';

export type CharacterDetailTab = 'intro' | 'comments';
interface CharacterDetailSheetProps {
  characterId: string | null;
  summary?: CharacterSummary;
  initialTab?: CharacterDetailTab;
  inConversation?: boolean;
  onClose: () => void;
  onEnter: (characterId: string, sessionId?: string) => void;
  entering?: boolean;
}

export function CharacterDetailSheet(props: CharacterDetailSheetProps) {
  const lastTarget = useRef<{ id: string; summary?: CharacterSummary } | null>(null);
  if (props.characterId) lastTarget.current = { id: props.characterId, summary: props.summary };
  const target = lastTarget.current;
  return (
    <Sheet
      open={Boolean(props.characterId)}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      {target ? (
        <CharacterDetailContent
          key={target.id}
          {...props}
          characterId={target.id}
          summary={target.summary}
          open={Boolean(props.characterId)}
        />
      ) : null}
    </Sheet>
  );
}

function CharacterDetailContent({
  characterId,
  summary,
  open,
  initialTab = 'intro',
  inConversation = false,
  onClose,
  onEnter,
  entering = false,
}: Omit<CharacterDetailSheetProps, 'characterId'> & { characterId: string; open: boolean }) {
  const detailQuery = useCharacterQuery(characterId, { enabled: open });
  const character = detailQuery.data?.character ?? summary;
  const history = useConversationsQuery(characterId, open && !inConversation);
  const social = useCharacterSocialQuery(characterId, open);
  const lastSession = history.data?.sessions
    .filter((session) => session.message_count > 0)
    .reduce<
      ChatSession | undefined
    >((latest, item) => (!latest || Date.parse(item.last_message_at ?? item.created_at) > Date.parse(latest.last_message_at ?? latest.created_at) ? item : latest), undefined);
  const [tab, setTab] = useState<CharacterDetailTab>(initialTab);
  const [greetingOpen, setGreetingOpen] = useState(false);
  const [viewport, setViewport] = useState<{ height: number; bottom: number } | null>(null);
  const [dragY, setDragY] = useState(0);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const introScroll = useRef<HTMLDivElement>(null);
  const tabsId = useId();
  useEffect(() => {
    if (open) {
      setTab(initialTab);
      setDragY(0);
    }
  }, [open, initialTab]);
  useEffect(() => {
    if (!open) return;
    const viewport = window.visualViewport;
    const update = () =>
      setViewport({
        height: Math.max(180, (viewport?.height ?? window.innerHeight) - 12),
        bottom: Math.max(
          0,
          window.innerHeight - (viewport?.height ?? window.innerHeight) - (viewport?.offsetTop ?? 0)
        ),
      });
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [open]);
  const chatLabel = inConversation
    ? '回到对话'
    : entering
      ? '正在进入…'
      : history.isPending
        ? '读取对话中…'
        : history.isError
          ? '重新加载'
          : lastSession
            ? '继续对话'
            : '开始对话';
  const chatDisabled = !character || entering || (!inConversation && history.isPending);
  const enter = () => {
    if (inConversation) {
      onClose();
      return;
    }
    if (history.isError) {
      void history.refetch();
      return;
    }
    if (character && history.isSuccess) onEnter(character.id, lastSession?.id);
  };
  const selectTab = (next: CharacterDetailTab) => {
    setTab(next);
    // 选项切换只改同一层的内容；不改变底下列表或聊天的位置。
    closeButton.current?.focus({ preventScroll: true });
  };

  return (
    <SheetContent
      side="bottom"
      className="mx-auto flex h-[86dvh] max-w-lg flex-col overflow-hidden rounded-t-[26px] border-border bg-popover p-0 shadow-[0_-12px_48px_rgba(0,0,0,0.32)] motion-reduce:animate-none"
      overlayClassName="bg-black/55 backdrop-blur-[2px]"
      style={{
        maxHeight: viewport?.height,
        bottom: viewport?.bottom,
        translate: dragY ? `0 ${dragY}px` : undefined,
      }}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        closeButton.current?.focus();
      }}
    >
      <div
        className="shrink-0 touch-none select-none"
        aria-label="下拉关闭角色详情"
        onTouchStart={(event) => {
          if (
            event.touches.length !== 1 ||
            (event.target instanceof Element && event.target.closest('button, a'))
          ) {
            touch.current = null;
            return;
          }
          touch.current = { x: event.touches[0]!.clientX, y: event.touches[0]!.clientY };
        }}
        onTouchMove={(event) => {
          if (!touch.current || event.touches.length !== 1) {
            touch.current = null;
            setDragY(0);
            return;
          }
          const dy = event.touches[0]!.clientY - touch.current.y;
          const dx = event.touches[0]!.clientX - touch.current.x;
          if (dy > 8 && dy > Math.abs(dx) * 1.4) setDragY(Math.min(130, dy * 0.65));
        }}
        onTouchEnd={() => {
          if (dragY > 52) onClose();
          touch.current = null;
          setDragY(0);
        }}
        onTouchCancel={() => {
          touch.current = null;
          setDragY(0);
        }}
      >
        <div
          className="mx-auto mb-2 mt-2.5 h-1 w-9 rounded-full bg-muted-foreground/25"
          aria-hidden
        />
        <header className="flex min-h-14 items-center gap-3 px-4 pb-2">
          <div
            className="size-11 shrink-0 overflow-hidden rounded-xl border border-border"
            style={{ background: characterRoomGradient(characterId) }}
          >
            {character?.avatar_url ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={lobbyImageUrl(character.avatar_url)}
                alt=""
                className="h-full w-full object-cover object-top"
              />
            ) : null}
          </div>
          <div className="min-w-0 flex-1">
            <SheetTitle className="truncate text-[17px] font-semibold tracking-tight">
              {character?.name ?? '角色详情'}
            </SheetTitle>
            <SheetDescription className="mt-0.5 text-[10px] text-muted-foreground/65">
              {tab === 'comments' ? '角色评论 · 分享你的体验' : '了解这个角色，开启你的故事'}
            </SheetDescription>
          </div>
          {tab === 'comments' && !inConversation ? (
            <button
              type="button"
              onClick={enter}
              disabled={chatDisabled}
              className="min-h-11 shrink-0 px-1.5 text-xs font-medium text-primary disabled:opacity-45"
            >
              {lastSession ? '继续聊' : '去聊天'}
            </button>
          ) : null}
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            aria-label="关闭角色详情"
            className="-mr-1 flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground active:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            <X className="size-5" strokeWidth={1.6} />
          </button>
        </header>
      </div>
      <div className="shrink-0 px-4">
        <CharacterSocialBar
          characterId={characterId}
          name={character?.name ?? '角色'}
          onComments={() => selectTab('comments')}
        />
        {social.isError ? (
          <button
            type="button"
            onClick={() => void social.refetch()}
            className="min-h-11 w-full text-xs text-muted-foreground"
          >
            互动信息暂不可用，点击重试
          </button>
        ) : null}
      </div>
      <div
        role="tablist"
        aria-label="角色详情栏目"
        className="flex shrink-0 gap-6 border-b border-border/60 px-5"
      >
        {(['intro', 'comments'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-label={value === 'intro' ? '介绍' : '评论'}
            id={`${tabsId}-${value}`}
            aria-controls={`${tabsId}-${value}-panel`}
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={cn(
              'relative min-h-11 px-1 text-[13px] transition-colors',
              tab === value
                ? 'font-semibold text-foreground after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary'
                : 'text-muted-foreground'
            )}
          >
            {value === 'intro' ? (
              '介绍'
            ) : (
              <>
                评论
                <span className="ml-1.5 text-[10px] font-normal text-muted-foreground">
                  {socialCount(social.data?.comment_count, '')}
                </span>
              </>
            )}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id={`${tabsId}-intro-panel`}
        aria-labelledby={`${tabsId}-intro`}
        hidden={tab !== 'intro'}
        className={cn('min-h-0 flex-1 flex-col', tab === 'intro' && 'flex')}
      >
        <div
          ref={introScroll}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-5 pt-4"
        >
          {character ? (
            <>
              <div
                className="relative mb-4 h-[min(44dvh,24rem)] overflow-hidden rounded-2xl border border-border/50"
                style={{ background: characterRoomGradient(characterId) }}
              >
                {character.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={character.avatar_url}
                    alt={character.name}
                    className="h-full w-full object-contain object-center"
                  />
                ) : null}
              </div>
              {character.personality_tags.length ? (
                <div className="mb-4 -mt-1 flex flex-wrap gap-1.5">
                  {character.personality_tags.slice(0, 6).map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full bg-secondary px-2 py-1 text-[10px] text-muted-foreground ring-1 ring-inset ring-border/60"
                    >
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
              <section>
                <h3 className="mb-2 text-[11px] font-medium text-muted-foreground">角色简介</h3>
                <p className="whitespace-pre-wrap break-words text-[13px] leading-6 text-foreground/85">
                  {character.description?.trim() ||
                    '这个角色还没有公开简介，进入后直接开始探索 TA 的世界。'}
                </p>
              </section>
              {detailQuery.data?.character.greeting?.trim() ? (
                <section className="mt-4 border-t border-border/50 pt-1">
                  <button
                    type="button"
                    aria-expanded={greetingOpen}
                    onClick={() => setGreetingOpen((value) => !value)}
                    className="flex min-h-11 w-full items-center justify-between text-xs text-muted-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <Quote className="size-3.5" />
                      开场白
                    </span>
                    <ChevronDown
                      className={cn('size-4 transition-transform', greetingOpen && 'rotate-180')}
                    />
                  </button>
                  {greetingOpen ? (
                    <blockquote className="rounded-xl border-l-2 border-primary/35 bg-background/40 px-3 py-2 text-[13px] leading-6 text-foreground/75">
                      {detailQuery.data.character.greeting}
                    </blockquote>
                  ) : null}
                </section>
              ) : null}
              {character.author_name ? (
                <p className="mt-4 text-[10px] text-muted-foreground/50">
                  创作者 · {character.author_name}
                </p>
              ) : null}
            </>
          ) : detailQuery.isError ? (
            <div className="py-8 text-center">
              <p className="text-sm text-muted-foreground">角色信息暂时没加载出来</p>
              <button
                type="button"
                onClick={() => void detailQuery.refetch()}
                className="min-h-11 px-4 text-sm text-primary"
              >
                重新加载角色
              </button>
            </div>
          ) : (
            <div
              role="status"
              className="flex min-h-40 items-center justify-center gap-2 text-xs text-muted-foreground"
            >
              <Loader2 className="size-4 animate-spin" />
              正在读取角色
            </div>
          )}
        </div>
        <footer className="shrink-0 border-t border-border/60 bg-popover px-5 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3">
          {!inConversation && history.isError ? (
            <p role="alert" className="mb-2 text-xs text-[#d9a3ad]">
              对话记录未加载，重试后再继续。
            </p>
          ) : null}
          <div className="flex gap-3">
            {!inConversation && lastSession ? (
              <button
                type="button"
                onClick={() => {
                  if (character) onEnter(character.id);
                }}
                disabled={entering}
                className="h-12 shrink-0 rounded-2xl border border-border px-5 text-[13px] text-muted-foreground disabled:opacity-45"
              >
                新对话
              </button>
            ) : null}
            <button
              type="button"
              disabled={chatDisabled}
              onClick={enter}
              className="flex h-12 min-w-0 flex-1 items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-primary to-rose px-4 text-[14px] font-semibold text-primary-foreground transition-opacity active:opacity-85 disabled:opacity-55"
            >
              {entering ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}{' '}
              {chatLabel}
            </button>
          </div>
        </footer>
      </div>
      <div
        role="tabpanel"
        id={`${tabsId}-comments-panel`}
        aria-labelledby={`${tabsId}-comments`}
        hidden={tab !== 'comments'}
        className={cn('min-h-0 flex-1 flex-col', tab === 'comments' && 'flex')}
      >
        <CharacterComments characterId={characterId} active={open && tab === 'comments'} />
      </div>
    </SheetContent>
  );
}
