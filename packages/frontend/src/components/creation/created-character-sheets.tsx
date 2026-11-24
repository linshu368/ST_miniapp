'use client';

import { useState } from 'react';
import { Globe2, LockKeyhole, Trash2 } from 'lucide-react';
import type { CreatorCharacterSummary } from '@miniapp/shared';
import {
  useDeleteCreatorCharacterMutation,
  useSetCreatorVisibilityMutation,
} from '@/lib/api/creator-characters';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';

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
  return card.approved_revision != null ? '已公开' : '未公开';
}

const SHEET_CLASS =
  'mx-auto max-w-lg rounded-t-3xl border-border bg-popover px-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] pt-7';
const ITEM_CLASS =
  'flex min-h-[52px] w-full items-center gap-2.5 border-b border-border text-left text-[15px] last:border-b-0';

/** Keep the last card while a sheet animates closed so its title does not flash to a fallback. */
function useLastCard(card: CreatorCharacterSummary | null) {
  const [target, setTarget] = useState(card);
  if (card && card !== target) setTarget(card);
  return target;
}

/** One place for a card's owner actions: visibility (published cards only) and delete. */
export function ManageCreatedCharacterSheet({
  card,
  onClose,
  onVisibility,
  onDelete,
}: {
  card: CreatorCharacterSummary | null;
  onClose: () => void;
  onVisibility: (card: CreatorCharacterSummary) => void;
  onDelete: (card: CreatorCharacterSummary) => void;
}) {
  const target = useLastCard(card);
  return (
    <Sheet open={Boolean(card)} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="bottom" className={SHEET_CLASS}>
        <SheetTitle className="truncate">{target?.name || '未命名角色'}</SheetTitle>
        <SheetDescription className="mt-1 text-xs">
          {target ? createdCharacterStatusLabel(target) : ''}
        </SheetDescription>
        <div className="mt-3">
          {target && target.state !== 'draft' ? (
            <button type="button" className={ITEM_CLASS} onClick={() => onVisibility(target)}>
              {target.visibility === 'public' ? (
                <LockKeyhole className="size-[18px]" aria-hidden />
              ) : (
                <Globe2 className="size-[18px]" aria-hidden />
              )}
              {target.visibility === 'public' ? '设为私密' : '公开你的角色'}
            </button>
          ) : null}
          <button
            type="button"
            className={`${ITEM_CLASS} text-destructive`}
            onClick={() => target && onDelete(target)}
          >
            <Trash2 className="size-[18px]" aria-hidden />
            删除角色
          </button>
        </div>
        <button
          type="button"
          className="mt-3 min-h-11 w-full rounded-xl bg-secondary text-sm text-foreground"
          onClick={onClose}
        >
          取消
        </button>
      </SheetContent>
    </Sheet>
  );
}

/** Unchanged visibility confirmation, now opened from the manage sheet. */
export function VisibilityCreatedCharacterSheet({
  card,
  onClose,
}: {
  card: CreatorCharacterSummary | null;
  onClose: () => void;
}) {
  const visibility = useSetCreatorVisibilityMutation();
  const [error, setError] = useState('');
  const close = () => {
    setError('');
    onClose();
  };
  return (
    <Sheet
      open={Boolean(card)}
      onOpenChange={(open) => {
        if (!open && !visibility.isPending) close();
      }}
    >
      <SheetContent side="bottom" className={SHEET_CLASS}>
        <SheetTitle>{card?.visibility === 'public' ? '设为私密' : '公开你的角色'}</SheetTitle>
        <SheetDescription className="mt-3 text-sm leading-7">
          {card?.visibility === 'public'
            ? '将不再展示在大厅，已收藏或使用过的玩家仍可继续使用。'
            : '公开后进入大厅，所有人都能与你的角色聊天。'}
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
            if (!card) return;
            setError('');
            try {
              await visibility.mutateAsync({
                id: card.id,
                body: {
                  expected_revision: card.revision,
                  visibility: card.visibility === 'public' ? 'private' : 'public',
                },
              });
              close();
            } catch (e) {
              setError(e instanceof Error ? e.message : '没改成功，再试一次吧');
            }
          }}
        >
          {visibility.isPending
            ? card?.visibility === 'private'
              ? '正在发布…'
              : '正在保存…'
            : card?.visibility === 'public'
              ? '确认设为私密'
              : '确认公开'}
        </button>
      </SheetContent>
    </Sheet>
  );
}

/** 软删除：作者列表和大厅都不再出现，已收藏或聊过的玩家继续可用。 */
export function DeleteCreatedCharacterSheet({
  card,
  onClose,
}: {
  card: CreatorCharacterSummary | null;
  onClose: () => void;
}) {
  const remove = useDeleteCreatorCharacterMutation();
  const [error, setError] = useState('');
  const target = useLastCard(card);
  const close = () => {
    setError('');
    onClose();
  };
  return (
    <Sheet
      open={Boolean(card)}
      onOpenChange={(open) => {
        if (!open && !remove.isPending) close();
      }}
    >
      <SheetContent side="bottom" className={SHEET_CLASS}>
        <SheetTitle>删除「{target?.name || '未命名角色'}」？</SheetTitle>
        <SheetDescription className="mt-3 text-sm leading-7">
          删除后会从我的创作和大厅移除，无法恢复。已收藏或聊过的玩家仍可继续使用。
        </SheetDescription>
        {error ? (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <button
          disabled={remove.isPending}
          className="mt-6 min-h-12 w-full rounded-xl bg-destructive text-sm font-semibold text-destructive-foreground disabled:opacity-60"
          onClick={async () => {
            if (!card) return;
            setError('');
            try {
              await remove.mutateAsync(card.id);
              close();
            } catch (e) {
              setError(e instanceof Error ? e.message : '没删成功，再试一次吧');
            }
          }}
        >
          {remove.isPending ? '正在删除…' : '确认删除'}
        </button>
      </SheetContent>
    </Sheet>
  );
}
