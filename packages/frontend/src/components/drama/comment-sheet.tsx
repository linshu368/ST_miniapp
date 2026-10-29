'use client';

import { useRef, useState } from 'react';
import { Loader2, MessageCircle, Send, X } from 'lucide-react';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import {
  useDramaCommentsQuery,
  useDramaCommentMutations,
  useDramaSocialQuery,
} from '@/lib/api/drama';
import { ApiClientError } from '@/lib/api/client';
import { useVisualViewportHeight } from '@/lib/use-visual-viewport-height';
import { useDramaSheetDismiss } from './use-drama-sheet-dismiss';

interface Props {
  id: string;
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function DramaCommentSheet({ id, title, open, onOpenChange }: Props) {
  const dismiss = useDramaSheetDismiss(open, onOpenChange);
  const social = useDramaSocialQuery(id, open);
  const count = social.data?.comment_count;
  const query = useDramaCommentsQuery(id, open);
  const { create, remove } = useDramaCommentMutations(id);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const submission = useRef<{ id: string; body: string } | null>(null);
  const busy = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const height = useVisualViewportHeight();
  const comments = query.data?.pages.flatMap((page) => page.comments) ?? [];
  const seen = new Set<string>();
  const unique = comments.filter((comment) => {
    if (seen.has(comment.id)) return false;
    seen.add(comment.id);
    return true;
  });

  async function submit() {
    const body = draft.trim();
    if (!body || busy.current) return;
    busy.current = true;
    setError('');
    setNotice('');
    if (submission.current?.body !== body) submission.current = { id: crypto.randomUUID(), body };
    try {
      await create.mutateAsync(submission.current);
      setDraft('');
      submission.current = null;
      list.current?.scrollTo({ top: 0 });
      setNotice('评论已发表');
    } catch (err) {
      setError(
        err instanceof ApiClientError && err.status === 429
          ? err.message
          : '没发出去，内容已保留，再试一次吧'
      );
      if (err instanceof ApiClientError && err.status === 409) submission.current = null;
    } finally {
      busy.current = false;
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        ref={dismiss.contentRef}
        side="bottom"
        className="mx-auto flex h-[72dvh] max-w-lg flex-col overflow-hidden rounded-t-2xl border-white/5 bg-[#211f22] p-0 text-[#eee7e2] motion-reduce:animate-none"
        overlayClassName="bg-black/35 backdrop-blur-none"
        style={
          height
            ? {
                height: Math.min(height - 16, window.innerHeight * 0.72),
                bottom: Math.max(0, window.innerHeight - height),
              }
            : undefined
        }
        onOpenAutoFocus={(event) => {
          // Focus stays inside the panel without opening the phone keyboard immediately.
          event.preventDefault();
          closeButton.current?.focus();
        }}
      >
        <div
          ref={dismiss.handleRef}
          data-sheet-drag-handle
          aria-label="下拉关闭评论"
          className="shrink-0 touch-none select-none"
        >
          <div
            aria-hidden
            className="mx-auto mb-1 mt-2.5 h-1 w-8 shrink-0 rounded-full bg-white/15"
          />
          <header className="flex shrink-0 items-center justify-between px-4 pb-2">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-base font-semibold text-[#eee7e2]">
                评论{count ? ` · ${count}` : ''}
              </SheetTitle>
              <SheetDescription className="mt-1 truncate text-[11px] text-[#eee7e2]/40">
                《{title}》的评论
              </SheetDescription>
            </div>
            <SheetClose
              ref={closeButton}
              aria-label="关闭评论"
              className="-mr-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[#eee7e2]/65"
            >
              <X className="h-5 w-5" />
            </SheetClose>
          </header>
        </div>
        <div
          ref={list}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-4"
          data-player-no-swipe
        >
          {query.isPending ? (
            <div
              role="status"
              className="flex h-40 items-center justify-center gap-2 text-sm text-[#eee7e2]/45"
            >
              <Loader2 className="h-4 w-4 animate-spin" />
              评论加载中
            </div>
          ) : query.isError && !query.data ? (
            <div className="py-12 text-center text-sm text-[#eee7e2]/50">
              <p>评论暂时没加载出来</p>
              <button
                type="button"
                onClick={() => void query.refetch()}
                className="mt-2 min-h-11 px-5 text-[#eee7e2]"
              >
                重新加载评论
              </button>
            </div>
          ) : !unique.length ? (
            <div className="flex h-full min-h-32 flex-col items-center justify-center gap-3 text-center">
              <MessageCircle className="h-9 w-9 stroke-1 text-[#eee7e2]/20" />
              <p className="text-sm text-[#eee7e2]/60">还没有评论，来聊两句吧</p>
              <p className="text-xs text-[#eee7e2]/30">一个感受，也值得分享</p>
            </div>
          ) : (
            <ul className="space-y-5 pt-4">
              {unique.map((comment) => (
                <li key={comment.id} className="flex gap-3">
                  <div
                    aria-hidden
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white/[0.07] text-xs text-[#eee7e2]/50"
                  >
                    {comment.is_mine ? '我' : '剧'}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="mb-1 text-xs text-[#eee7e2]/45">
                      {comment.is_mine ? '我' : comment.author}
                    </div>
                    <p className="whitespace-pre-wrap break-words text-sm leading-6 text-[#eee7e2]/90">
                      {comment.body}
                    </p>
                    <div className="flex min-h-8 flex-wrap items-center gap-3 text-[11px] text-[#eee7e2]/30">
                      <time dateTime={comment.created_at}>
                        {new Date(comment.created_at).toLocaleDateString('zh-CN', {
                          month: 'numeric',
                          day: 'numeric',
                        })}
                      </time>
                      {comment.is_mine &&
                        (confirmDelete === comment.id ? (
                          <>
                            <button
                              type="button"
                              className="min-h-11 text-[#eee7e2]/60"
                              onClick={() => setConfirmDelete(null)}
                            >
                              保留
                            </button>
                            <button
                              type="button"
                              disabled={remove.isPending}
                              className="min-h-11 text-[#d3adb5]"
                              onClick={() => {
                                setError('');
                                remove.mutate(comment.id, {
                                  onSuccess: () => {
                                    setConfirmDelete(null);
                                    setNotice('评论已删除');
                                  },
                                  onError: () => setError('没能删除，再试一次吧'),
                                });
                              }}
                            >
                              {remove.isPending ? '删除中…' : '确认删除'}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="min-h-11 px-1"
                            aria-label={`删除我的评论：${comment.body}`}
                            onClick={() => setConfirmDelete(comment.id)}
                          >
                            删除
                          </button>
                        ))}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {query.hasNextPage ? (
            <button
              type="button"
              disabled={query.isFetchingNextPage}
              onClick={() => void query.fetchNextPage()}
              className="mt-2 min-h-11 w-full text-xs text-[#eee7e2]/45"
            >
              {query.isFetchingNextPage
                ? '加载中…'
                : query.isFetchNextPageError
                  ? '重新加载更多评论'
                  : '查看更多评论'}
            </button>
          ) : null}
        </div>
        <form
          className="shrink-0 border-t border-white/[0.06] px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom))] pt-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          {error ? (
            <p role="alert" className="mb-2 text-xs text-[#d3adb5]">
              {error}
            </p>
          ) : null}
          <span role="status" className="sr-only">
            {notice}
          </span>
          <div className="flex items-end gap-2">
            <textarea
              aria-label="评论内容"
              placeholder="说说你的看法…"
              rows={2}
              maxLength={500}
              disabled={create.isPending}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value);
                setError('');
              }}
              className="max-h-24 min-h-11 min-w-0 flex-1 resize-none rounded-xl bg-white/[0.06] px-3 py-2.5 text-[16px] leading-6 text-[#eee7e2] outline-none placeholder:text-[#eee7e2]/30 focus:ring-1 focus:ring-white/15 disabled:opacity-60"
            />
            <button
              type="submit"
              aria-label="发表评论"
              disabled={!draft.trim() || create.isPending}
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[#c99ea7] text-[#2b1d24] transition-opacity disabled:bg-white/10 disabled:text-[#eee7e2]/25"
            >
              {create.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-[18px] w-[18px]" />
              )}
            </button>
          </div>
          {draft.length > 400 ? (
            <p className="mt-1 text-right text-[10px] tabular-nums text-[#eee7e2]/35">
              {draft.length}/500
            </p>
          ) : null}
        </form>
      </SheetContent>
    </Sheet>
  );
}
