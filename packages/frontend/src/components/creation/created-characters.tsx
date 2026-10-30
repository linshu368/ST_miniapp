'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BookOpen, Globe2, LoaderCircle, LockKeyhole, Pencil, Plus } from 'lucide-react';
import type { CreatorCharacterSummary } from '@miniapp/shared';
import {
  useCreatorCharactersQuery,
  useSetCreatorVisibilityMutation,
} from '@/lib/api/creator-characters';
import { chatEntryPath } from '@/lib/chat-entry';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import {
  getCharacterDraftChangeState,
  listCharacterDrafts,
  type StoredCharacterDraft,
} from './character-editor-draft';
import { cn } from '@/lib/utils';

const FILTERS = ['全部', '草稿', '私密', '公开'] as const;
export function createdCharacterStatusLabel(
  card: Pick<
    CreatorCharacterSummary,
    'state' | 'review_status' | 'approved_revision' | 'visibility'
  >
) {
  if (card.state === 'draft') return '草稿';
  if (card.review_status === 'pending')
    return card.approved_revision != null ? '更新审核中' : '待审核 · 可先玩';
  if (card.review_status === 'rejected')
    return card.approved_revision != null ? '更新未通过' : '审核未通过';
  if (card.visibility === 'private') return '私密';
  return card.approved_revision != null ? '已公开' : '未提交审核';
}

export function findCreatedCharacterDraft(
  characterId: string,
  drafts: readonly StoredCharacterDraft[]
): StoredCharacterDraft | undefined {
  return drafts.reduce<StoredCharacterDraft | undefined>((latest, draft) => {
    if (
      draft.recoveryFor ||
      (draft.characterId ?? draft.draftId) !== characterId ||
      getCharacterDraftChangeState(draft) === 'unchanged'
    )
      return latest;
    return !latest || draft.updatedAt > latest.updatedAt ? draft : latest;
  }, undefined);
}

function draftEditPath(draft: StoredCharacterDraft): string {
  return draft.characterId
    ? `/creation/characters/${draft.characterId}/edit`
    : `/creation/characters/new?draft=${encodeURIComponent(draft.draftId)}`;
}

function hasDraftContent({ draft, coverAssetId }: StoredCharacterDraft): boolean {
  return Boolean(
    coverAssetId ||
    [draft.name, draft.description, draft.background, draft.opening, draft.preset].some((text) =>
      text.trim()
    ) ||
    draft.tags.length ||
    draft.selectedPresetIds?.length ||
    draft.backgroundFiles.length ||
    draft.presetFiles.length
  );
}

export function CreatedCharacters() {
  const query = useCreatorCharactersQuery();
  const visibility = useSetCreatorVisibilityMutation();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('全部');
  const [drafts, setDrafts] = useState<StoredCharacterDraft[]>([]);
  const [draftError, setDraftError] = useState(false);
  const [changing, setChanging] = useState<CreatorCharacterSummary | null>(null);
  const [error, setError] = useState('');
  const owner = query.data?.owner_user_id;
  useEffect(() => {
    let cancelled = false;
    setDrafts([]);
    if (owner)
      void listCharacterDrafts(owner).then(
        (rows) => {
          if (!cancelled) {
            setDrafts(rows);
            setDraftError(false);
          }
        },
        () => {
          if (!cancelled) setDraftError(true);
        }
      );
    return () => {
      cancelled = true;
    };
  }, [owner]);
  const cards = query.data?.characters ?? [];
  const localByCharacter = new Map(
    cards.map((card) => [card.id, findCreatedCharacterDraft(card.id, drafts)])
  );
  const shown = cards.filter(
    (card) =>
      filter === '全部' ||
      (filter === '草稿'
        ? card.state === 'draft' || Boolean(localByCharacter.get(card.id))
        : card.state !== 'draft' && card.visibility === (filter === '私密' ? 'private' : 'public'))
  );
  const unsaved =
    filter === '全部' || filter === '草稿'
      ? drafts.filter(
          (draft) =>
            !draft.characterId &&
            !cards.some((card) => card.id === draft.draftId) &&
            hasDraftContent(draft)
        )
      : [];
  return (
    <div aria-label="自己创作的角色">
      <div aria-label="作品状态" className="mb-4 flex gap-2">
        {FILTERS.map((item) => (
          <button
            key={item}
            type="button"
            aria-pressed={filter === item}
            onClick={() => setFilter(item)}
            className={cn(
              'min-h-11 rounded-xl px-3 text-xs',
              filter === item ? 'bg-primary/10 text-primary' : 'text-muted-foreground'
            )}
          >
            {item}
          </button>
        ))}
      </div>
      {query.isPending ? (
        <div
          role="status"
          className="flex min-h-32 items-center justify-center gap-2 text-sm text-muted-foreground"
        >
          <LoaderCircle className="size-4 animate-spin" />
          正在读取你的角色
        </div>
      ) : query.isError ? (
        <div role="alert" className="py-10 text-center text-sm text-muted-foreground">
          暂时没能读取你的创作
          <button
            onClick={() => void query.refetch()}
            className="mx-auto mt-3 block min-h-11 px-4 text-primary"
          >
            重新加载
          </button>
        </div>
      ) : (
        <>
          {draftError ? (
            <p role="status" className="mb-3 text-xs text-muted-foreground">
              本地草稿暂时无法读取，已保存的角色仍可使用。
            </p>
          ) : null}
          {shown.length || unsaved.length ? (
            <div className="grid grid-cols-2 items-start gap-3">
              {unsaved.map((draft) => (
                <Link
                  key={draft.key}
                  href={`/creation/characters/new?draft=${encodeURIComponent(draft.draftId)}`}
                  className="overflow-hidden rounded-2xl border border-border/70 bg-card"
                >
                  <div className="relative aspect-[3/4] bg-muted">
                    {draft.coverUrl ? (
                      <img src={draft.coverUrl} alt="" className="size-full object-cover" />
                    ) : (
                      <BookOpen className="absolute left-1/2 top-1/2 size-8 -translate-x-1/2 -translate-y-1/2 text-muted-foreground" />
                    )}
                    <span className="absolute bottom-2 left-2 rounded-md bg-black/55 px-2 py-1 text-[10px] text-white/80">
                      {draft.recoveryFor ? '修改备份' : '本地草稿'}
                    </span>
                  </div>
                  <p className="truncate px-3 pt-3 text-sm text-foreground">
                    {draft.draft.name || '未命名角色'}
                  </p>
                  <span className="flex min-h-11 items-center px-3 text-xs text-muted-foreground">
                    继续编辑
                  </span>
                </Link>
              ))}
              {shown.map((card) => {
                const localDraft = localByCharacter.get(card.id);
                const editingPath = localDraft
                  ? draftEditPath(localDraft)
                  : `/creation/characters/${card.id}/edit`;
                const openEditor =
                  card.state === 'draft' || (filter === '草稿' && Boolean(localDraft));
                return (
                  <article
                    key={card.id}
                    className="overflow-hidden rounded-2xl border border-border/70 bg-card"
                  >
                    <Link
                      href={
                        openEditor ? editingPath : chatEntryPath(card.id, { source: 'created' })
                      }
                      aria-label={
                        openEditor ? `继续编辑${card.name || '角色'}` : `与${card.name}聊天`
                      }
                      className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                    >
                      <div className="relative aspect-[3/4] bg-muted">
                        {card.cover_url ? (
                          <img
                            src={card.cover_url}
                            alt=""
                            loading="lazy"
                            className="size-full object-cover"
                          />
                        ) : (
                          <BookOpen className="absolute left-1/2 top-1/2 size-8 -translate-x-1/2 -translate-y-1/2 text-muted-foreground" />
                        )}
                        <span className="absolute bottom-2 left-2 rounded-md bg-black/60 px-2 py-1 text-[10px] text-white/85 backdrop-blur-sm">
                          {createdCharacterStatusLabel(card)}
                        </span>
                      </div>
                      <h3 className="truncate px-3 pt-3 text-sm font-medium text-foreground">
                        {card.name || '未命名角色'}
                      </h3>
                    </Link>
                    {localDraft ? (
                      <p className="mt-1 px-3 text-[11px] leading-5 text-primary">
                        {getCharacterDraftChangeState(localDraft) === 'changed'
                          ? '有未提交修改'
                          : '本地内容待确认'}
                      </p>
                    ) : null}
                    {card.review_status === 'rejected' && card.review_message ? (
                      <p className="mt-1 line-clamp-2 px-3 text-[11px] leading-5 text-destructive">
                        {card.review_message}
                      </p>
                    ) : null}
                    <div className="flex items-center justify-between gap-1 px-2">
                      <Link
                        href={editingPath}
                        className="inline-flex min-h-11 items-center gap-1 whitespace-nowrap text-[11px] text-muted-foreground"
                      >
                        <Pencil className="size-3.5" />
                        {localDraft || card.state === 'draft' ? '继续编辑' : '编辑'}
                      </Link>
                      {card.state !== 'draft' ? (
                        <button
                          aria-label={`修改${card.name}的可见性`}
                          onClick={() => {
                            setChanging(card);
                            setError('');
                          }}
                          className="inline-flex min-h-11 items-center gap-1 whitespace-nowrap text-[11px] text-muted-foreground"
                        >
                          {card.visibility === 'public' ? (
                            <Globe2 className="size-3.5" />
                          ) : (
                            <LockKeyhole className="size-3.5" />
                          )}
                          可见性
                        </button>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
          ) : (
            <div className="flex min-h-[250px] flex-col items-center justify-center text-center">
              <BookOpen className="mb-4 size-9 text-muted-foreground" strokeWidth={1.3} />
              <h3 className="text-sm font-medium text-foreground">
                {filter === '全部' ? '还没有创作的角色' : `这里还没有${filter}角色`}
              </h3>
              <Link
                href="/creation/characters/new"
                className="mt-5 inline-flex min-h-11 items-center gap-1.5 rounded-xl border border-border bg-secondary/50 px-5 text-xs text-primary"
              >
                <Plus className="size-4" />
                创作角色卡
              </Link>
            </div>
          )}
        </>
      )}
      <Sheet
        open={Boolean(changing)}
        onOpenChange={(open) => {
          if (!open && !visibility.isPending) setChanging(null);
        }}
      >
        <SheetContent
          side="bottom"
          className="mx-auto max-w-lg rounded-t-3xl border-border bg-popover px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-7"
        >
          <SheetTitle>{changing?.visibility === 'public' ? '设为私密' : '公开你的角色'}</SheetTitle>
          <SheetDescription className="mt-3 text-sm leading-7">
            {changing?.visibility === 'public'
              ? '将不再展示在大厅，已收藏或使用过的用户仍可继续使用。'
              : '审核通过后进入大厅，所有人都能与你的角色聊天。'}
          </SheetDescription>
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <button
            disabled={visibility.isPending}
            className="mt-6 min-h-12 w-full rounded-xl bg-primary text-sm font-semibold text-primary-foreground disabled:opacity-60"
            onClick={async () => {
              if (!changing) return;
              try {
                await visibility.mutateAsync({
                  id: changing.id,
                  body: {
                    expected_revision: changing.revision,
                    visibility: changing.visibility === 'public' ? 'private' : 'public',
                  },
                });
                setChanging(null);
              } catch (e) {
                setError(e instanceof Error ? e.message : '暂时未能修改，请重试');
              }
            }}
          >
            {visibility.isPending
              ? '正在保存…'
              : changing?.visibility === 'public'
                ? '确认设为私密'
                : '提交审核'}
          </button>
        </SheetContent>
      </Sheet>
    </div>
  );
}
