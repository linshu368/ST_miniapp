'use client';

/**
 * 聊天页右侧状态面板（雾面玻璃）。
 * - 入口：右边缘中间偏下（拇指区）的窄标签，只写"状态"，不显示数值；自动更新中转小圈，更新完亮"新"点。
 * - 面板：从右侧滑出；右滑跟手收起、从入口左滑打开、点外面/"收起"/返回键/Esc 都能关。
 * - 每 5 轮自动更新（所有人）；"立即更新"仅限 VIP；更新后可撤销。不消耗星尘。
 * - 键盘弹起（在打字）时隐藏入口；第一次进有状态栏的卡弹一次提示。
 */
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Sparkles } from 'lucide-react';
import type { ConversationStatusData } from '@miniapp/shared';
import { ApiClientError } from '@/lib/api/client';
import {
  useConversationStatusQuery,
  useRefreshConversationStatusMutation,
  useUndoConversationStatusMutation,
} from '@/lib/api/status-bar';
import { useTelegramBackButton } from '@/lib/telegram';
import { cn } from '@/lib/utils';
import { StatusView } from './status-view';
import { readLocal, useSwipeToClose, useTyping, writeLocal } from './use-status-gestures';

const SEEN_KEY = (sessionId: string) => `st_miniapp_status_seen_${sessionId}`;
const HINT_KEY = 'st_miniapp_status_hint_seen';

function StatusTab({
  data,
  unseen,
  onOpen,
}: {
  data: ConversationStatusData;
  unseen: boolean;
  onOpen: () => void;
}) {
  const startX = useRef<number | null>(null);
  return (
    <button
      type="button"
      aria-label="打开状态面板"
      onClick={onOpen}
      onPointerDown={(event) => (startX.current = event.clientX)}
      onPointerUp={(event) => {
        if (startX.current !== null && startX.current - event.clientX > 24) onOpen();
        startX.current = null;
      }}
      className="fixed right-0 top-[58%] z-30 grid w-9 touch-pan-y place-items-center gap-1.5 rounded-l-[18px] bg-white/[0.07] py-3 pr-0.5 text-foreground shadow-[inset_1px_1px_0_rgb(255_255_255/0.12),-6px_8px_20px_rgb(0_0_0/0.35)] backdrop-blur-md active:translate-x-0.5"
    >
      <Sparkles className="size-4 text-mauve" aria-hidden />
      <span className="text-[11.5px] font-medium tracking-[4px] text-foreground/80 [writing-mode:vertical-rl]">
        状态
      </span>
      {data.updating ? (
        <span className="absolute -left-1.5 -top-1.5 grid size-[18px] place-items-center rounded-full bg-secondary ring-2 ring-background">
          <Loader2 className="size-3 animate-spin text-mauve" aria-label="正在更新" />
        </span>
      ) : unseen ? (
        <span className="absolute -left-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-mauve px-1 text-[10px] font-bold text-[#2a1a20] ring-2 ring-background">
          新
        </span>
      ) : null}
    </button>
  );
}

function refreshError(error: unknown): string {
  if (error instanceof ApiClientError && error.code === 'STATUS_RATE_LIMITED')
    return '刚更新过，稍等一会儿再试';
  return '这次没更新成功，再试一次';
}

/** 立即更新（非 VIP 显示 VIP 角标，点了去开通）+ 失败提示 + 刚更新完可撤销。 */
function DrawerFooter({
  busy,
  vipRequired,
  error,
  onUpdate,
  undo,
}: {
  busy: boolean;
  vipRequired: boolean;
  error: string | null;
  onUpdate: () => void;
  undo: { pending: boolean; run: () => void } | null;
}) {
  return (
    <footer className="grid gap-1 px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-2">
      <button
        type="button"
        onClick={onUpdate}
        disabled={busy}
        className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-[hsl(341_33%_70%)] to-primary text-[14px] font-semibold text-[#2a1a20] disabled:opacity-75"
      >
        {busy ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            正在根据最近的对话更新…
          </>
        ) : vipRequired ? (
          <>
            立即更新<span className="rounded-full bg-black/15 px-1.5 text-[10.5px]">VIP</span>
          </>
        ) : (
          '立即更新'
        )}
      </button>
      {error ? (
        <p role="alert" className="text-center text-[12px] text-destructive">
          {error}
        </p>
      ) : null}
      {undo ? (
        <button
          type="button"
          onClick={undo.run}
          disabled={undo.pending}
          className="min-h-9 text-[12px] text-muted-foreground underline underline-offset-4"
        >
          撤销这次更新
        </button>
      ) : null}
    </footer>
  );
}

function StatusDrawer({
  sessionId,
  data,
  characterName,
  onClose,
}: {
  sessionId: string;
  data: ConversationStatusData;
  characterName: string;
  onClose: () => void;
}) {
  const router = useRouter();
  const refresh = useRefreshConversationStatusMutation(sessionId);
  const undo = useUndoConversationStatusMutation(sessionId);
  const [justUpdated, setJustUpdated] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const close = () => {
    setLeaving(true);
    window.setTimeout(onClose, 190);
  };
  const swipe = useSwipeToClose(close);
  const closeRef = useRef<HTMLButtonElement>(null);
  useTelegramBackButton(close, 'dialog');
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && close();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开时绑定一次
  }, []);
  const busy = refresh.isPending || data.updating;
  const text = data.snapshot?.text ?? data.initialText;
  const onUpdate = () => {
    if (data.manualUpdate === 'vip_required') return router.push('/vip');
    refresh.mutate(undefined, { onSuccess: () => setJustUpdated(true) });
  };
  const shift = leaving ? '100%' : `${swipe.offset}px`;
  return (
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-label={`${characterName}的状态`}
    >
      <div
        className="absolute inset-0 bg-black/25 motion-safe:animate-in motion-safe:fade-in-0"
        style={{ opacity: leaving ? 0 : 1, transition: 'opacity 200ms' }}
        onClick={close}
      />
      <aside
        {...swipe.handlers}
        className="absolute bottom-2.5 right-0 top-2.5 flex w-[86%] max-w-[420px] touch-pan-y flex-col rounded-l-[26px] bg-[rgb(36_29_34/0.74)] shadow-[inset_1px_1px_0_rgb(255_255_255/0.1),-18px_0_40px_rgb(0_0_0/0.4)] backdrop-blur-xl backdrop-saturate-[1.2] motion-safe:animate-in motion-safe:slide-in-from-right"
        style={{
          transform: `translateX(${shift})`,
          transition: swipe.dragging ? 'none' : 'transform 200ms ease',
        }}
      >
        <header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 pb-2 pt-[calc(env(safe-area-inset-top)+1rem)]">
          <span className="grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-[hsl(341_33%_45%)] to-[hsl(300_10%_22%)] text-[18px] font-bold text-white">
            {characterName.slice(0, 1) || '·'}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[18px] font-bold">{characterName}</span>
            <span className="block text-[11.5px] text-muted-foreground">每 5 轮自动更新</span>
          </span>
          <button
            ref={closeRef}
            type="button"
            onClick={close}
            className="min-h-11 px-1 text-[12.5px] text-muted-foreground"
          >
            收起 ›
          </button>
        </header>
        <div
          className={cn(
            'chat-scroll-area min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-2',
            busy && 'opacity-50 transition-opacity'
          )}
        >
          {text ? (
            <StatusView text={text} />
          ) : (
            <p className="mt-6 text-center text-[13px] text-muted-foreground">
              聊满 5 轮会自动记下第一次状态
            </p>
          )}
        </div>
        <DrawerFooter
          busy={busy}
          vipRequired={data.manualUpdate === 'vip_required'}
          error={refresh.isError ? refreshError(refresh.error) : null}
          onUpdate={onUpdate}
          undo={
            justUpdated && data.snapshot?.canUndo && !busy
              ? {
                  pending: undo.isPending,
                  run: () => undo.mutate(undefined, { onSuccess: () => setJustUpdated(false) }),
                }
              : null
          }
        />
      </aside>
    </div>
  );
}

export function ChatStatusPanel({
  sessionId,
  characterName,
  generating,
}: {
  sessionId: string | null;
  characterName: string;
  generating: boolean;
}) {
  const query = useConversationStatusQuery(sessionId);
  const typing = useTyping();
  const [open, setOpen] = useState(false);
  const [seenId, setSeenId] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const wasGenerating = useRef(generating);
  const data = query.data;
  // 回复结束（generating 从 true 变回 false）后重新读一次：满 5 轮时后台已开始自动更新。
  useEffect(() => {
    if (wasGenerating.current && !generating) void query.refetch();
    wasGenerating.current = generating;
  }, [generating, query]);
  useEffect(() => {
    if (sessionId) setSeenId(readLocal(SEEN_KEY(sessionId)));
  }, [sessionId]);
  const enabled = Boolean(sessionId && data && data.source !== 'none');
  useEffect(() => {
    if (!enabled || readLocal(HINT_KEY)) return;
    setHint(true);
    writeLocal(HINT_KEY, '1');
    const timer = window.setTimeout(() => setHint(false), 6000);
    return () => window.clearTimeout(timer);
  }, [enabled]);
  if (!sessionId || !data || !enabled) return null;
  const snapshotId = data.snapshot?.id ?? null;
  const unseen = Boolean(snapshotId && snapshotId !== seenId && data.snapshot?.trigger === 'auto');
  const openPanel = () => {
    setOpen(true);
    setHint(false);
    if (snapshotId) {
      writeLocal(SEEN_KEY(sessionId), snapshotId);
      setSeenId(snapshotId);
    }
  };
  return (
    <>
      {!typing && !open ? <StatusTab data={data} unseen={unseen} onOpen={openPanel} /> : null}
      {hint && !typing && !open ? (
        <div
          role="status"
          className="fixed right-12 top-[calc(58%+0.75rem)] z-30 whitespace-nowrap rounded-xl bg-primary px-3 py-2 text-[12.5px] font-semibold text-primary-foreground shadow-lg"
        >
          点这里看状态
        </div>
      ) : null}
      {open ? (
        <StatusDrawer
          sessionId={sessionId}
          data={data}
          characterName={characterName}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
