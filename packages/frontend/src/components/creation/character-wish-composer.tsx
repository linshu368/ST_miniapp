'use client';

import { useMemoryDraft } from '@/hooks/use-memory-draft';
import { useCreateCharacterWishMutation } from '@/lib/api/character-wishes';
import { CHARACTER_WISH_MAX_LENGTH, CreateCharacterWishSchema } from '@miniapp/shared';
import { Globe2, LoaderCircle } from 'lucide-react';
import { useRef, useState } from 'react';

import { createUuid } from '@/lib/uuid';
import { PRIMARY, WishSheet, errorMessage } from './character-wishes-shared';
export function WishComposer({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const draft = useMemoryDraft('character-wish');
  const [error, setError] = useState('');
  const mutation = useCreateCharacterWishMutation();
  const request = useRef<{ id: string; body: string; visibility: 'public' }>();
  async function submit() {
    if (mutation.isPending || !draft.value.trim()) return;
    const body = draft.value.trim();
    if (!request.current || request.current.body !== body)
      request.current = { id: createUuid(), body, visibility: 'public' };
    const parsed = CreateCharacterWishSchema.safeParse(request.current);
    if (!parsed.success) {
      setError('心愿最多 500 字，请稍微精简一下。');
      return;
    }
    const submitted = draft.value;
    setError('');
    try {
      const result = await mutation.mutateAsync(parsed.data);
      draft.clearIfUnchanged(submitted);
      request.current = undefined;
      onCreated(result.wish.id);
    } catch (failure) {
      setError(errorMessage(failure, '没能提交，内容已保留，请重试。'));
    }
  }
  return (
    <WishSheet
      open={open}
      onClose={mutation.isPending ? () => {} : onClose}
      title="许个愿"
      description="你想遇见什么样的角色，或经历怎样的故事？"
    >
      <div className="min-h-0 overflow-y-auto overscroll-contain">
        <label htmlFor="wish-body" className="sr-only">
          你想玩什么样的角色
        </label>
        <textarea
          id="wish-body"
          aria-describedby="wish-public-notice"
          value={draft.value}
          onChange={(event) => draft.setValue(event.target.value)}
          maxLength={CHARACTER_WISH_MAX_LENGTH}
          disabled={mutation.isPending}
          rows={5}
          placeholder="比如：想和一个反差御姐做瑟瑟的事情。"
          className="ph-no-capture block w-full resize-none rounded-2xl border border-input bg-background/60 px-4 py-3 text-base leading-7 outline-none placeholder:text-[13px] placeholder:text-muted-foreground/70 focus:border-primary/50"
          data-sentry-mask
        />
        <div className="mt-2 text-right text-[11px] tabular-nums text-muted-foreground">
          {draft.value.length} / {CHARACTER_WISH_MAX_LENGTH}
        </div>
        <p
          id="wish-public-notice"
          className="mt-3 flex items-start gap-2 text-xs leading-6 text-muted-foreground"
        >
          <Globe2 className="mt-1 size-4 shrink-0 text-primary/80" aria-hidden />
          <span>心愿将匿名公开，不展示昵称和头像，所有人都能看到。</span>
        </p>
      </div>
      {error ? (
        <p role="alert" className="mt-2 shrink-0 text-xs leading-5 text-destructive">
          {error}
        </p>
      ) : null}
      <button
        type="button"
        disabled={!draft.value.trim() || mutation.isPending}
        onClick={() => void submit()}
        className={`${PRIMARY} mt-3 w-full shrink-0`}
      >
        {mutation.isPending ? (
          <>
            <LoaderCircle className="size-4 animate-spin" />
            正在提交…
          </>
        ) : (
          '提交心愿'
        )}
      </button>
    </WishSheet>
  );
}
