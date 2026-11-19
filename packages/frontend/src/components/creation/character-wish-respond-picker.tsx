'use client';

import { useRespondCharacterWishMutation } from '@/lib/api/character-wishes';
import { useCreatorCharactersQuery } from '@/lib/api/creator-characters';
import { cn } from '@/lib/utils';
import { ArrowRight, Check, LoaderCircle } from 'lucide-react';
import Image from 'next/image';
import Link from 'next/link';
import { useState } from 'react';

import {
  ErrorState,
  FOCUS,
  Loading,
  PRIMARY,
  SECONDARY,
  WishSheet,
  errorMessage,
} from './character-wishes-shared';
export function RespondPicker({
  wishId,
  existingIds,
  onClose,
  onDone,
}: {
  wishId: string;
  existingIds: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const query = useCreatorCharactersQuery();
  const response = useRespondCharacterWishMutation();
  const [selected, setSelected] = useState<string | null>(null);
  const cards =
    query.data?.characters.filter(
      (card) =>
        card.state === 'ready' &&
        card.visibility === 'public' &&
        card.approved_revision !== null &&
        !existingIds.includes(card.id)
    ) ?? [];
  return (
    <WishSheet
      open
      onClose={response.isPending ? () => {} : onClose}
      title="选择回应作品"
      description="选择一张已经公开、适合这个心愿的角色卡。"
    >
      <div className="min-h-0 overflow-y-auto overscroll-contain">
        {query.isPending ? (
          <Loading />
        ) : query.isError ? (
          <ErrorState text="作品暂时没能加载" retry={() => void query.refetch()} />
        ) : cards.length ? (
          <div className="space-y-2">
            {cards.map((card) => (
              <button
                type="button"
                key={card.id}
                disabled={response.isPending}
                aria-pressed={selected === card.id}
                onClick={() => setSelected(card.id)}
                className={cn(
                  'flex w-full items-center gap-3 rounded-xl border p-3 text-left',
                  FOCUS,
                  selected === card.id ? 'border-primary/50 bg-primary/5' : 'border-border/60'
                )}
              >
                <div className="relative h-16 w-12 shrink-0 overflow-hidden rounded-lg bg-muted">
                  {card.cover_url ? (
                    <Image
                      src={card.cover_url}
                      alt=""
                      fill
                      sizes="48px"
                      className="object-cover"
                      unoptimized
                    />
                  ) : null}
                </div>
                <span className="min-w-0 flex-1">
                  <span className="line-clamp-1 text-sm font-medium">{card.name}</span>
                  <span className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">
                    {card.description}
                  </span>
                </span>
                <span
                  className={cn(
                    'flex size-5 shrink-0 items-center justify-center rounded-full border',
                    selected === card.id
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-muted-foreground/40'
                  )}
                >
                  {selected === card.id ? <Check className="size-3" /> : null}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="py-7 text-center">
            <p className="text-sm text-muted-foreground">暂时没有可以回应的公开作品</p>
            <Link href={`/creation/characters/new?wish=${wishId}`} className={`${SECONDARY} mt-4`}>
              以此创作
              <ArrowRight className="size-4" />
            </Link>
          </div>
        )}
      </div>
      {response.isError ? (
        <p role="alert" className="mt-3 text-xs leading-5 text-destructive">
          {errorMessage(response.error, '暂时没有回应成功，请重试。')}
        </p>
      ) : null}
      {cards.length ? (
        <button
          type="button"
          disabled={!selected || response.isPending}
          onClick={() => {
            if (selected)
              response.mutate({ id: wishId, characterId: selected }, { onSuccess: onDone });
          }}
          className={`${PRIMARY} mt-4 w-full shrink-0`}
        >
          {response.isPending ? (
            <>
              <LoaderCircle className="size-4 animate-spin" />
              正在回应…
            </>
          ) : (
            '确认回应'
          )}
        </button>
      ) : null}
    </WishSheet>
  );
}
