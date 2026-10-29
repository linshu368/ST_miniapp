'use client';

import { useMemo, useRef, useState } from 'react';
import { Loader2, MessageCircle, Send } from 'lucide-react';
import { CreateCharacterCommentSchema } from '@miniapp/shared';
import {
  useCharacterCommentsQuery,
  useCharacterCommentMutations,
} from '@/lib/api/character-social';
import { ApiClientError } from '@/lib/api/client';
import { useMemoryDraft } from '@/hooks/use-memory-draft';
import { getRawInitData } from '@/lib/telegram/auth';
import { parseTelegramUser } from '@/lib/telegram/user';
import { MEMORY_DRAFT_TTL_MS } from '@/stores/memory-draft-store';

// 关闭弹层不代表发表失败。短期保留提交 ID，使丢响应后重新打开重试仍是同一条评论。
const submissions = new Map<string, { id: string; body: string; at: number }>();
function submissionFor(key: string, body: string) {
  for (const [id, value] of submissions) {
    if (Date.now() - value.at > MEMORY_DRAFT_TTL_MS) submissions.delete(id);
  }
  const previous = submissions.get(key);
  if (previous?.body === body) return previous;
  const next = { id: crypto.randomUUID(), body, at: Date.now() };
  submissions.delete(key);
  while (submissions.size >= 64) submissions.delete(submissions.keys().next().value!);
  submissions.set(key, next);
  return next;
}

export function CharacterComments({
  characterId,
  active,
}: {
  characterId: string;
  active: boolean;
}) {
  const query = useCharacterCommentsQuery(characterId, active);
  const { create, remove, report } = useCharacterCommentMutations(characterId);
  const draft = useMemoryDraft(`character-comment:${characterId}`);
  const viewer =
    typeof window === 'undefined' ? 'local' : (parseTelegramUser(getRawInitData()).id ?? 'local');
  const submissionKey = `${viewer}:${characterId}`;
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmation, setConfirmation] = useState<{
    id: string;
    action: 'delete' | 'report';
  } | null>(null);
  const [reported, setReported] = useState<Set<string>>(() => new Set());
  const composing = useRef(false);
  const submitting = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  const comments = useMemo(() => {
    const seen = new Set<string>();
    return (query.data?.pages.flatMap((page) => page.comments) ?? []).filter((comment) => {
      if (seen.has(comment.id)) return false;
      seen.add(comment.id);
      return true;
    });
  }, [query.data]);

  async function submit() {
    if (composing.current || submitting.current || create.isPending) return;
    const submittedDraft = draft.value;
    const body = submittedDraft.trim();
    if (!body) return;
    const submission = submissionFor(submissionKey, body);
    const parsed = CreateCharacterCommentSchema.safeParse({ id: submission.id, body });
    if (!parsed.success) {
      setError('评论请写 1–500 个字');
      return;
    }
    submitting.current = true;
    setError('');
    setNotice('');
    try {
      await create.mutateAsync(parsed.data);
      draft.clearIfUnchanged(submittedDraft);
      if (submissions.get(submissionKey) === submission) submissions.delete(submissionKey);
      list.current?.scrollTo({ top: 0, behavior: 'auto' });
      setNotice('评论已发表');
    } catch (err) {
      setError(
        err instanceof ApiClientError && (err.status === 429 || err.status === 409)
          ? err.message
          : '没发出去，内容已保留，再试一次吧'
      );
      if (err instanceof ApiClientError && err.status === 409) submissions.delete(submissionKey);
    } finally {
      submitting.current = false;
    }
  }

  async function confirmAction() {
    if (!confirmation || remove.isPending || report.isPending) return;
    const target = confirmation;
    setError('');
    setNotice('');
    try {
      if (target.action === 'delete') {
        await remove.mutateAsync(target.id);
        setNotice('评论已删除');
      } else {
        await report.mutateAsync({ commentId: target.id, reason: 'inappropriate' });
        setReported((previous) => new Set([...previous, target.id]));
        setNotice('举报已提交，感谢你的反馈');
      }
      setConfirmation(null);
    } catch {
      setError(target.action === 'delete' ? '暂时没能删除，请再试一次' : '举报未提交，请再试一次');
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" hidden={!active}>
      <div ref={list} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-3">
        <p className="pb-2 pt-3 text-[11px] leading-5 text-muted-foreground/65">
          聊聊这个角色，也给后来的人一点参考
        </p>
        {query.isPending ? (
          <div
            role="status"
            className="flex min-h-36 items-center justify-center gap-2 text-xs text-muted-foreground"
          >
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
            评论加载中
          </div>
        ) : query.isError && !query.data ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            <p>评论暂时没加载出来</p>
            <button
              type="button"
              onClick={() => void query.refetch()}
              className="mt-2 min-h-11 px-4 text-primary"
            >
              重新加载评论
            </button>
          </div>
        ) : comments.length === 0 ? (
          <div className="flex min-h-36 flex-col items-center justify-center gap-2 py-6 text-center">
            <MessageCircle className="mb-1 size-8 stroke-1 text-muted-foreground/30" aria-hidden />
            <p className="text-sm text-foreground/70">这里还很安静</p>
            <p className="text-xs text-muted-foreground">聊过之后，留下你的第一印象吧</p>
          </div>
        ) : (
          <ul className="divide-y divide-border/35">
            {comments.map((comment) => (
              <li
                key={comment.id}
                className="flex gap-3 py-4"
                data-character-comment-id={comment.id}
              >
                <div
                  aria-hidden
                  className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border border-white/[0.06] bg-white/[0.04] text-[11px] text-[#c8b5a3]"
                >
                  {comment.is_mine ? '我' : '友'}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                    <span>{comment.is_mine ? '我' : comment.author}</span>
                    <time
                      dateTime={comment.created_at}
                      className="shrink-0 text-[10px] text-muted-foreground/60"
                    >
                      {new Date(comment.created_at).toLocaleDateString('zh-CN', {
                        month: 'numeric',
                        day: 'numeric',
                      })}
                    </time>
                  </div>
                  <p className="mt-1.5 whitespace-pre-wrap break-words text-[13px] leading-6 text-foreground/90">
                    {comment.body}
                  </p>
                  {confirmation?.id === comment.id ? (
                    <div className="mt-2 rounded-xl border border-border/60 bg-background/40 px-3">
                      <p className="pt-2 text-[11px] text-muted-foreground">
                        {confirmation.action === 'delete' ? '删除这条评论？' : '举报这条不当评论？'}
                      </p>
                      <div className="flex gap-4 text-xs">
                        <button
                          type="button"
                          className="min-h-11 px-1 text-muted-foreground"
                          onClick={() => setConfirmation(null)}
                        >
                          取消
                        </button>
                        <button
                          type="button"
                          className="min-h-11 px-1 text-[#d9a3ad]"
                          disabled={remove.isPending || report.isPending}
                          onClick={() => void confirmAction()}
                        >
                          {confirmation.action === 'delete' ? '确认删除' : '确认举报'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      aria-label={comment.is_mine ? '删除评论' : '举报评论'}
                      disabled={!comment.is_mine && reported.has(comment.id)}
                      className="-mb-2 -ml-2 min-h-11 px-2 text-[10px] text-muted-foreground/55 disabled:opacity-60"
                      onClick={() =>
                        setConfirmation({
                          id: comment.id,
                          action: comment.is_mine ? 'delete' : 'report',
                        })
                      }
                    >
                      {comment.is_mine ? '删除' : reported.has(comment.id) ? '已举报' : '举报'}
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
        {query.isError && query.data && !query.isFetchNextPageError ? (
          <button
            type="button"
            onClick={() => void query.refetch()}
            className="min-h-11 w-full text-xs text-muted-foreground"
          >
            刷新失败，点此重试
          </button>
        ) : null}
        {query.hasNextPage ? (
          <button
            type="button"
            aria-label="加载更多评论"
            disabled={query.isFetchingNextPage}
            onClick={() => void query.fetchNextPage()}
            className="min-h-11 w-full text-xs text-muted-foreground"
          >
            {query.isFetchingNextPage
              ? '加载中…'
              : query.isFetchNextPageError
                ? '未加载成功，点击重试'
                : '加载更多评论'}
          </button>
        ) : null}
      </div>
      <form
        className="shrink-0 border-t border-border/60 bg-popover px-4 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {error ? (
          <p role="alert" className="mb-2 text-xs leading-5 text-[#d9a3ad]">
            {error}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className="mb-2 text-xs leading-5 text-primary">
            {notice}
          </p>
        ) : null}
        <div className="flex items-end gap-2 rounded-2xl border border-border bg-background/45 p-1.5 focus-within:border-primary/45">
          <textarea
            aria-label="公开角色评论"
            placeholder="聊过之后，感觉怎么样？"
            value={draft.value}
            onChange={(event) => {
              draft.setValue(event.target.value);
              setNotice('');
            }}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (
                (event.ctrlKey || event.metaKey) &&
                event.key === 'Enter' &&
                !event.nativeEvent.isComposing &&
                !composing.current
              ) {
                event.preventDefault();
                void submit();
              }
            }}
            rows={2}
            maxLength={500}
            className="max-h-28 min-h-11 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-[13px] leading-5 outline-none placeholder:text-muted-foreground/60"
          />
          <button
            type="submit"
            aria-label="发表评论"
            disabled={!draft.value.trim() || create.isPending}
            className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary transition-colors active:bg-primary/25 disabled:bg-white/[0.03] disabled:text-muted-foreground/30"
          >
            {create.isPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Send className="size-[18px]" strokeWidth={1.7} />
            )}
          </button>
        </div>
        <div className="mt-1.5 flex justify-between gap-3 px-1 text-[10px] text-muted-foreground/55">
          <span>公开评论 · 不会分享你的对话</span>
          <span className="tabular-nums">{draft.value.length}/500</span>
        </div>
      </form>
    </div>
  );
}
