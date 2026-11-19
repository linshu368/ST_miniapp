'use client';

import {
  useCharacterWishQuery,
  useRespondCharacterWishMutation,
  useWithdrawCharacterWishMutation,
} from '@/lib/api/character-wishes';
import { chatEntryPath } from '@/lib/chat-entry';
import { usePageReady } from '@/lib/perf/page-ready';
import { useTelegramBackButton } from '@/lib/telegram/hooks';
import { ArrowRight, ChevronRight, LoaderCircle, Sparkles } from 'lucide-react';
import Link from 'next/link';
import dynamic from 'next/dynamic';
import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useState } from 'react';

import { RespondPicker } from './character-wish-respond-picker';
import {
  ErrorState,
  Header,
  Loading,
  PRIMARY,
  ROOT,
  ResponseCard,
  SECONDARY,
  SupportButton,
  UUID,
  WishIdentity,
  WishSheet,
  errorMessage,
  listParams,
  pathWithQuery,
} from './character-wishes-shared';
const CharacterDetailSheet = dynamic(() =>
  import('@/components/characters/character-detail-sheet').then(
    (module) => module.CharacterDetailSheet
  )
);

function useWishDetail(id: string) {
  const router = useRouter();
  const search = useSearchParams();
  const validId = UUID.test(id);
  const query = useCharacterWishQuery(validId ? id : undefined);
  usePageReady('/wishes/:id', query.data !== undefined, false, !validId || query.isError);
  const withdraw = useWithdrawCharacterWishMutation();
  const response = useRespondCharacterWishMutation();
  const [picker, setPicker] = useState(false);
  const [confirmWithdraw, setConfirmWithdraw] = useState(false);
  const [notice, setNotice] = useState('');
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [detailsLoaded, setDetailsLoaded] = useState(false);
  const [entering, setEntering] = useState(false);
  const params = listParams(search);
  const backHref = pathWithQuery('/wishes', params);
  const retryCard = search.get('respond');
  const recoveryCard = retryCard && UUID.test(retryCard) ? retryCard : null;
  const wish = query.data?.wish;
  const goBack = useCallback(() => {
    if (selectedCard) {
      setSelectedCard(null);
      setEntering(false);
    } else if (picker) setPicker(false);
    else if (confirmWithdraw) setConfirmWithdraw(false);
    else router.push(backHref);
  }, [selectedCard, picker, confirmWithdraw, router, backHref]);
  useTelegramBackButton(goBack);
  async function retryResponse() {
    if (!recoveryCard || response.isPending || !query.isSuccess) return;
    setNotice('');
    try {
      await response.mutateAsync({ id, characterId: recoveryCard });
      router.replace(pathWithQuery(`/wishes/${id}`, listParams(search)), { scroll: false });
      setNotice('已回应，想玩这个角色的人会收到消息。');
    } catch (error) {
      setNotice(errorMessage(error, '暂时没能关联，请再试一次。'));
    }
  }
  async function doWithdraw() {
    if (withdraw.isPending) return;
    try {
      await withdraw.mutateAsync(id);
      router.replace(backHref);
    } catch {
      /* The dialog keeps the error and retry action visible. */
    }
  }
  return {
    id,
    router,
    query,
    validId,
    withdraw,
    response,
    picker,
    setPicker,
    confirmWithdraw,
    setConfirmWithdraw,
    notice,
    setNotice,
    selectedCard,
    setSelectedCard,
    detailsLoaded,
    setDetailsLoaded,
    entering,
    setEntering,
    backHref,
    recoveryCard,
    wish,
    retryResponse,
    doWithdraw,
  };
}
export type WishDetailModel = ReturnType<typeof useWishDetail>;
export function CharacterWishDetailPage({ id }: { id: string }) {
  const model = useWishDetail(id);
  const { query, validId, response, notice, backHref, recoveryCard, wish, retryResponse } = model;
  return (
    <main className={ROOT}>
      <Header title="心愿详情" backHref={backHref} />
      {recoveryCard ? (
        <div role="status" className="mt-4 rounded-xl border border-primary/20 bg-primary/5 p-4">
          <p className="text-sm leading-6">角色已发布，暂未关联到心愿</p>
          <div className="mt-1 flex flex-wrap items-center gap-x-5">
            {query.isSuccess ? (
              <button
                type="button"
                disabled={response.isPending}
                onClick={() => void retryResponse()}
                className="inline-flex min-h-11 items-center gap-2 text-sm text-primary"
              >
                {response.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
                重新回应
                <ArrowRight className="size-4" />
              </button>
            ) : null}
            <Link
              href="/creation?tab=created"
              className="inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground"
            >
              查看我的角色
              <ChevronRight className="size-4" />
            </Link>
          </div>
        </div>
      ) : null}
      {notice ? (
        <p role="status" className="mt-4 text-xs leading-6 text-primary">
          {notice}
        </p>
      ) : null}
      {!validId ? (
        <div className="py-16 text-center text-sm text-muted-foreground">这个心愿暂时看不了</div>
      ) : query.isPending ? (
        <Loading />
      ) : query.isError ? (
        <ErrorState
          text={errorMessage(query.error, '这个心愿暂时看不了，可能已经被撤回了。')}
          retry={() => void query.refetch()}
        />
      ) : wish ? (
        <>
          <WishDetailContent model={model} />
        </>
      ) : null}
      <WishDetailDialogs model={model} />
    </main>
  );
}
function WishDetailContent({ model }: { model: WishDetailModel }) {
  const { id, query, setPicker, setConfirmWithdraw, setSelectedCard, setDetailsLoaded, wish } =
    model;
  if (!query.isSuccess || !wish) return null;
  return (
    <>
      <section className="pt-6" aria-label="心愿内容">
        <WishIdentity wish={wish} />
        <p
          className="ph-no-capture mt-4 whitespace-pre-wrap break-words text-base leading-8 text-foreground/90"
          data-sentry-mask
        >
          {wish.body}
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <SupportButton wish={wish} />
          {wish.is_mine ? (
            <button
              type="button"
              onClick={() => setConfirmWithdraw(true)}
              className="ml-auto min-h-11 px-2 text-xs text-muted-foreground"
            >
              撤回心愿
            </button>
          ) : null}
        </div>
      </section>
      <section className="mt-6 border-t border-border/60 pt-5" aria-labelledby="wish-responses">
        <h2 id="wish-responses" className="flex items-center gap-2 text-sm font-medium">
          为这个心愿创作的角色
          {query.data.cards.length ? (
            <span className="text-xs font-normal text-muted-foreground">
              {query.data.cards.length}
            </span>
          ) : null}
        </h2>
        {query.data.cards.length ? (
          <div className="mt-3 divide-y divide-border/50">
            {query.data.cards.map((card) => (
              <ResponseCard
                key={card.id}
                card={card}
                onClick={() => {
                  setDetailsLoaded(true);
                  setSelectedCard(card.id);
                }}
              />
            ))}
          </div>
        ) : (
          <p className="py-5 text-sm leading-7 text-muted-foreground">
            还没有作品回应，留一点期待。
          </p>
        )}
      </section>
      <section
        className="mt-4 rounded-2xl border border-border/70 bg-card px-4 pb-3 pt-4"
        aria-label="回应心愿"
      >
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary/80" />
          <h2 className="text-sm font-medium">这个想法，你能写出来吗？</h2>
        </div>
        <p className="mt-2 text-xs leading-6 text-muted-foreground">
          用你的作品回应，让等着玩的人遇见它。
        </p>
        <Link href={`/creation/characters/new?wish=${id}`} className={`${PRIMARY} mt-4 w-full`}>
          以此创作
          <ArrowRight className="size-4" />
        </Link>
        <button
          type="button"
          onClick={() => setPicker(true)}
          className="mt-1 min-h-11 w-full text-xs text-muted-foreground"
        >
          用已有作品回应
        </button>
      </section>
    </>
  );
}
function WishDetailDialogs({ model }: { model: WishDetailModel }) {
  const {
    id,
    router,
    query,
    withdraw,
    picker,
    setPicker,
    confirmWithdraw,
    setConfirmWithdraw,
    setNotice,
    selectedCard,
    setSelectedCard,
    detailsLoaded,
    entering,
    setEntering,
    doWithdraw,
  } = model;
  return (
    <>
      {picker ? (
        <RespondPicker
          wishId={id}
          existingIds={query.data?.cards.map((card) => card.id) ?? []}
          onClose={() => setPicker(false)}
          onDone={() => {
            setPicker(false);
            setNotice('已回应，想玩这个角色的人会收到消息。');
          }}
        />
      ) : null}
      <WishSheet
        open={confirmWithdraw}
        onClose={withdraw.isPending ? () => {} : () => setConfirmWithdraw(false)}
        title="撤回这个心愿？"
        description="撤回后将不再展示，已经创作出的角色不受影响。"
      >
        {withdraw.isError ? (
          <p role="alert" className="mb-3 text-xs text-destructive">
            {errorMessage(withdraw.error, '暂时没有成功，请再试一次。')}
          </p>
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            disabled={withdraw.isPending}
            onClick={() => setConfirmWithdraw(false)}
            className={SECONDARY}
          >
            再想想
          </button>
          <button
            type="button"
            disabled={withdraw.isPending}
            onClick={() => void doWithdraw()}
            className={PRIMARY}
          >
            {withdraw.isPending ? '正在撤回…' : '确认撤回'}
          </button>
        </div>
      </WishSheet>
      {detailsLoaded ? (
        <CharacterDetailSheet
          characterId={selectedCard}
          entering={entering}
          onClose={() => {
            setSelectedCard(null);
            setEntering(false);
          }}
          onEnter={(characterId, sessionId) => {
            if (entering) return;
            setEntering(true);
            router.push(chatEntryPath(characterId, { sessionId, source: 'discover' }));
          }}
        />
      ) : null}
    </>
  );
}
