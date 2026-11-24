'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { BookOpen, LoaderCircle, MoreHorizontal, Pencil, Plus } from 'lucide-react';
import type { CreatorCharacterSummary } from '@miniapp/shared';
import { useCreatorCharactersQuery } from '@/lib/api/creator-characters';
import { chatEntryPath } from '@/lib/chat-entry';
import {
  getCharacterDraftChangeState,
  listCharacterDrafts,
  type StoredCharacterDraft,
} from './character-editor-draft';
import { cn } from '@/lib/utils';
import {
  createdCharacterStatusLabel,
  DeleteCreatedCharacterSheet,
  ManageCreatedCharacterSheet,
  VisibilityCreatedCharacterSheet,
} from './created-character-sheets';

const FILTERS = ['全部', '草稿', '私密', '公开'] as const;
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
    draft.presetFiles.length ||
    draft.statusBar
  );
}

export function CreatedCharacters() {
  const query = useCreatorCharactersQuery();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>('全部');
  const [drafts, setDrafts] = useState<StoredCharacterDraft[]>([]);
  const [draftError, setDraftError] = useState(false);
  const [changing, setChanging] = useState<CreatorCharacterSummary | null>(null);
  const [managing, setManaging] = useState<CreatorCharacterSummary | null>(null);
  const [deleting, setDeleting] = useState<CreatorCharacterSummary | null>(null);
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
              {shown.map((card) => (
                <CreatedCharacterCard
                  key={card.id}
                  card={card}
                  localDraft={localByCharacter.get(card.id)}
                  draftFilter={filter === '草稿'}
                  onManage={() => setManaging(card)}
                />
              ))}
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
              <Link
                href="/wishes?from=creation"
                className="mt-2 inline-flex min-h-11 items-center text-xs text-muted-foreground active:text-primary"
              >
                还没想好题材？去心愿墙看看
              </Link>
            </div>
          )}
        </>
      )}
      <VisibilityCreatedCharacterSheet card={changing} onClose={() => setChanging(null)} />
      <ManageCreatedCharacterSheet
        card={managing}
        onClose={() => setManaging(null)}
        onVisibility={(card) => {
          setManaging(null);
          setChanging(card);
        }}
        onDelete={(card) => {
          setManaging(null);
          setDeleting(card);
        }}
      />
      <DeleteCreatedCharacterSheet card={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

function CreatedCharacterCard({
  card,
  localDraft,
  draftFilter,
  onManage,
}: {
  card: CreatorCharacterSummary;
  localDraft: StoredCharacterDraft | undefined;
  draftFilter: boolean;
  onManage: () => void;
}) {
  const editingPath = localDraft
    ? draftEditPath(localDraft)
    : `/creation/characters/${card.id}/edit`;
  const openEditor = card.state === 'draft' || (draftFilter && Boolean(localDraft));
  return (
    <article className="relative overflow-hidden rounded-2xl border border-border/70 bg-card">
      <Link
        href={openEditor ? editingPath : chatEntryPath(card.id, { source: 'created' })}
        aria-label={openEditor ? `继续编辑${card.name || '角色'}` : `与${card.name}聊天`}
        className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <div className="relative aspect-[3/4] bg-muted">
          {card.cover_url ? (
            <img src={card.cover_url} alt="" loading="lazy" className="size-full object-cover" />
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
        <button
          type="button"
          aria-label={`管理${card.name || '角色'}`}
          onClick={onManage}
          className="inline-flex min-h-11 min-w-11 items-center justify-end px-1.5 text-muted-foreground"
        >
          <MoreHorizontal className="size-[18px]" aria-hidden />
        </button>
      </div>
    </article>
  );
}
