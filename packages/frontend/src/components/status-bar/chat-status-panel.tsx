'use client';

/**
 * 聊天页右侧状态面板（雾面玻璃）：上面是状态栏，下面是记忆栏（剧情记录，memory-timeline）。
 * - 入口：右边缘中间偏下（拇指区）的窄标签，只写"状态"（卡没有状态栏时写"记忆"），不显示数值；
 *   自动更新中转小圈，状态或记忆有新内容亮"新"点。状态栏、记忆栏有一个开着就显示。
 * - 面板：从右侧滑出；右滑跟手收起、从入口左滑打开、点外面/"收起"/返回键/Esc 都能关。
 * - 每 3 轮自动更新（所有人，不花星尘）；"立即更新"所有人可用，状态和记忆一起，任一处有更新才扣 6 星尘（专项优先）；
 *   更新后可撤销（只撤状态，不退星尘）。收费只在第一次点时用说明卡讲一次，平时收在标题旁的小问号里
 *   （status-refresh-intro）；按钮不带价签、不显示余额。余额不够时底部给「去充值」。
 * - 键盘弹起（在打字）时隐藏入口；第一次进有状态栏的卡弹一次提示。
 */
import { useEffect, useRef, useState, type ComponentProps, type RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Sparkles } from 'lucide-react';
import {
  STATUS_AUTO_UPDATE_EVERY_TURNS,
  STATUS_REFRESH_CREDITS,
  type ConversationStatusData,
} from '@miniapp/shared';
import { ApiClientError } from '@/lib/api/client';
import { isInsufficientCreditsError, redirectToRecharge } from '@/lib/recharge-redirect';
import {
  useConversationStatusQuery,
  useRefreshConversationStatusMutation,
  useUndoConversationStatusMutation,
} from '@/lib/api/status-bar';
import { useTelegramBackButton } from '@/lib/telegram';
import { cn } from '@/lib/utils';
import { MemoryRequestSheet } from './memory-request-sheet';
import { MemoryTimeline } from './memory-timeline';
import { RefreshIntroCard, RefreshPriceHint, refreshIntroSeen } from './status-refresh-intro';
import { StatusView } from './status-view';
import { readLocal, useSwipeToClose, useTyping, writeLocal } from './use-status-gestures';

const SEEN_KEY = (sessionId: string) => `st_miniapp_status_seen_${sessionId}`;
const HINT_KEY = 'st_miniapp_status_hint_seen';

/** 看过的内容标记：状态记录 + 记忆记到哪一轮，任一变化就算有新内容。 */
const seenMarker = (data: ConversationStatusData) =>
  `${data.snapshot?.id ?? ''}|${data.memory.state?.covered_turn ?? 0}`;

function StatusTab({
  data,
  label,
  unseen,
  onOpen,
}: {
  data: ConversationStatusData;
  label: string;
  unseen: boolean;
  onOpen: () => void;
}) {
  const startX = useRef<number | null>(null);
  return (
    <button
      type="button"
      aria-label={`打开${label}面板`}
      onClick={onOpen}
      onPointerDown={(event) => (startX.current = event.clientX)}
      onPointerUp={(event) => {
        if (startX.current !== null && startX.current - event.clientX > 24) onOpen();
        startX.current = null;
      }}
      className="fixed right-0 top-[58%] z-30 grid w-9 touch-pan-y place-items-center gap-1.5 rounded-l-[18px] bg-card/90 py-3 pr-0.5 text-foreground shadow-[inset_1px_1px_0_hsl(var(--border)),-6px_8px_20px_rgb(60_40_55/0.14)] dark:bg-white/[0.07] dark:shadow-[inset_1px_1px_0_rgb(255_255_255/0.12),-6px_8px_20px_rgb(0_0_0/0.35)] backdrop-blur-md active:translate-x-0.5"
    >
      <Sparkles className="size-4 text-mauve" aria-hidden />
      <span className="text-[11.5px] font-medium tracking-[4px] text-foreground/80 [writing-mode:vertical-rl]">
        {label}
      </span>
      {data.updating || data.memory.updating ? (
        <span className="absolute -left-1.5 -top-1.5 grid size-[18px] place-items-center rounded-full bg-secondary ring-2 ring-background">
          <Loader2 className="size-3 animate-spin text-mauve" aria-label="正在更新" />
        </span>
      ) : unseen ? (
        <span className="absolute -left-1.5 -top-1.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-mauve px-1 text-[10px] font-bold text-white dark:text-[#2a1a20] ring-2 ring-background">
          新
        </span>
      ) : null}
    </button>
  );
}

function refreshError(error: unknown): string {
  if (error instanceof ApiClientError && error.code === 'STATUS_RATE_LIMITED')
    return '刚更新过，稍等一会儿再试';
  return '这次没更新成功，没扣星尘，再试一次';
}

/** 立即更新（不带价签）+ 余额不够时的「去充值」/ 失败提示 + 刚更新完可撤销。 */
function DrawerFooter({
  busy,
  recharge,
  error,
  note,
  onUpdate,
  undo,
}: {
  busy: boolean;
  /** 余额不够：底部换成「星尘不够了 · 去充值」 */
  recharge: (() => void) | null;
  error: string | null;
  /** 手动更新后的提示（如记忆这几轮没有新进展） */
  note: string | null;
  onUpdate: () => void;
  undo: { pending: boolean; run: () => void } | null;
}) {
  return (
    <footer className="grid gap-1 px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-2">
      <button
        type="button"
        onClick={onUpdate}
        disabled={busy}
        className="flex min-h-12 items-center justify-center gap-2 rounded-2xl bg-gradient-to-r from-mauve to-primary text-[14px] font-semibold text-white dark:from-[hsl(341_33%_70%)] dark:to-primary dark:text-[#2a1a20] disabled:opacity-75"
      >
        {busy ? (
          <>
            <Loader2 className="size-4 animate-spin" aria-hidden />
            正在根据最近的对话更新…
          </>
        ) : (
          '立即更新'
        )}
      </button>
      {recharge ? (
        <p role="alert" className="flex items-center justify-center gap-2.5 text-[12.5px]">
          星尘不够了
          <button type="button" onClick={recharge} className="min-h-9 font-semibold text-mauve">
            去充值 ›
          </button>
        </p>
      ) : error ? (
        <p role="alert" className="text-center text-[12px] text-destructive">
          {error}
        </p>
      ) : note ? (
        <p role="status" className="text-center text-[12px] text-muted-foreground">
          {note}
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

function DrawerHeader({
  characterName,
  closeRef,
  onClose,
  price,
}: {
  characterName: string;
  closeRef: RefObject<HTMLButtonElement>;
  onClose: () => void;
  price: { open: boolean; onToggle: (open: boolean) => void };
}) {
  return (
    <header className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 pb-2 pt-[calc(env(safe-area-inset-top)+1rem)]">
      <span className="grid size-12 place-items-center rounded-2xl bg-gradient-to-br from-[hsl(341_33%_45%)] to-[hsl(300_10%_22%)] text-[18px] font-bold text-white">
        {characterName.slice(0, 1) || '·'}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-[18px] font-bold">{characterName}</span>
        <span className="relative flex items-center gap-1 text-[11.5px] text-muted-foreground">
          每 {STATUS_AUTO_UPDATE_EVERY_TURNS} 轮自动更新
          <RefreshPriceHint
            open={price.open}
            autoEveryTurns={STATUS_AUTO_UPDATE_EVERY_TURNS}
            onToggle={price.onToggle}
          />
        </span>
      </span>
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        className="min-h-11 px-1 text-[12.5px] text-muted-foreground"
      >
        收起 ›
      </button>
    </header>
  );
}

/** 立即更新的整条交互：第一次先出说明卡、余额不够给充值入口、更新完可撤销（只撤状态）。 */
function useRefreshFlow(sessionId: string, data: ConversationStatusData, returnTo: string) {
  const router = useRouter();
  const refresh = useRefreshConversationStatusMutation(sessionId);
  const undo = useUndoConversationStatusMutation(sessionId);
  const [justUpdated, setJustUpdated] = useState(false);
  const [memoryNote, setMemoryNote] = useState<string | null>(null);
  const [introOpen, setIntroOpen] = useState(false);
  const [priceOpen, setPriceOpen] = useState(false);
  const busy = refresh.isPending || data.updating || data.memory.updating;
  const runUpdate = () => {
    setMemoryNote(null);
    refresh.mutate(undefined, {
      onSuccess: (result) => {
        setJustUpdated(true);
        if (result.memoryOutcome === 'no_progress') setMemoryNote('记忆：这几轮没有新进展');
      },
    });
  };
  const lowCredits = refresh.isError && isInsufficientCreditsError(refresh.error);
  const footer: ComponentProps<typeof DrawerFooter> = {
    busy,
    recharge: lowCredits
      ? () => redirectToRecharge(router, { returnTo, requiredCredits: STATUS_REFRESH_CREDITS })
      : null,
    error: refresh.isError ? refreshError(refresh.error) : null,
    note: memoryNote,
    // 第一次点先讲一次怎么收费（说明卡里点「更新」才开始），之后直接更新
    onUpdate: () => {
      setPriceOpen(false);
      if (refreshIntroSeen()) runUpdate();
      else setIntroOpen(true);
    },
    undo:
      justUpdated && data.snapshot?.canUndo && !busy
        ? {
            pending: undo.isPending,
            run: () => undo.mutate(undefined, { onSuccess: () => setJustUpdated(false) }),
          }
        : null,
  };
  return {
    busy,
    footer,
    price: { open: priceOpen, onToggle: setPriceOpen },
    intro: introOpen
      ? {
          onConfirm: () => {
            setIntroOpen(false);
            runUpdate();
          },
          onClose: () => setIntroOpen(false),
        }
      : null,
  };
}

function StatusDrawer({
  sessionId,
  data,
  characterName,
  returnTo,
  onClose,
}: {
  sessionId: string;
  data: ConversationStatusData;
  characterName: string;
  returnTo: string;
  onClose: () => void;
}) {
  const flow = useRefreshFlow(sessionId, data, returnTo);
  const [requestOpen, setRequestOpen] = useState(false);
  // Esc 先关最上层：说明卡 → 价格气泡 → 记忆要求弹层 → 面板
  const topLayerRef = useRef<(() => void) | null>(null);
  topLayerRef.current =
    flow.intro?.onClose ??
    (flow.price.open ? () => flow.price.onToggle(false) : null) ??
    (requestOpen ? () => setRequestOpen(false) : null);
  const swipe = useSwipeToClose(onClose);
  const close = () => swipe.dismiss();
  const closeRef = useRef<HTMLButtonElement>(null);
  useTelegramBackButton(close, 'dialog');
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) =>
      event.key === 'Escape' && (topLayerRef.current ?? close)();
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在打开时绑定一次
  }, []);
  const busy = flow.busy;
  const statusEnabled = data.source !== 'none';
  const text = data.snapshot?.text ?? data.initialText;
  return (
    <div
      className="fixed inset-0 z-50"
      role="dialog"
      aria-modal="true"
      aria-label={`${characterName}的${statusEnabled ? '状态' : '记忆'}`}
    >
      <div
        ref={swipe.backdropRef}
        className="absolute inset-0 bg-black/25 motion-safe:animate-in motion-safe:fade-in-0"
        onClick={close}
      />
      <aside
        ref={swipe.panelRef}
        {...swipe.handlers}
        className="absolute bottom-2.5 right-0 top-2.5 flex w-[86%] max-w-[420px] touch-pan-y flex-col rounded-l-[26px] bg-[rgb(250_247_249/0.88)] shadow-[inset_1px_1px_0_rgb(255_255_255/0.8),-18px_0_40px_rgb(60_40_55/0.16)] dark:bg-[rgb(36_29_34/0.74)] dark:shadow-[inset_1px_1px_0_rgb(255_255_255/0.1),-18px_0_40px_rgb(0_0_0/0.4)] backdrop-blur-xl backdrop-saturate-[1.2] motion-safe:animate-in motion-safe:slide-in-from-right"
        style={{ willChange: 'transform' }}
      >
        <DrawerHeader
          characterName={characterName}
          closeRef={closeRef}
          onClose={close}
          price={flow.price}
        />
        <div
          className={cn(
            'chat-scroll-area min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-2',
            busy && 'opacity-50 transition-opacity'
          )}
        >
          {!statusEnabled ? null : text ? (
            <StatusView text={text} template={data.template} />
          ) : (
            <p className="mt-6 text-center text-[13px] text-muted-foreground">
              聊满 {STATUS_AUTO_UPDATE_EVERY_TURNS} 轮会自动记下第一次状态
            </p>
          )}
          {data.memory.enabled ? (
            <MemoryTimeline memory={data.memory} onEditRequest={() => setRequestOpen(true)} />
          ) : null}
        </div>
        <DrawerFooter {...flow.footer} />
        {flow.intro ? (
          <RefreshIntroCard autoEveryTurns={STATUS_AUTO_UPDATE_EVERY_TURNS} {...flow.intro} />
        ) : null}
        {requestOpen ? (
          <MemoryRequestSheet
            sessionId={sessionId}
            initial={data.memory.request}
            onClose={() => setRequestOpen(false)}
          />
        ) : null}
      </aside>
    </div>
  );
}

export function ChatStatusPanel({
  sessionId,
  characterName,
  generating,
  returnTo,
}: {
  sessionId: string | null;
  characterName: string;
  generating: boolean;
  /** 余额不够去充值后回到这段对话 */
  returnTo: string;
}) {
  const query = useConversationStatusQuery(sessionId);
  const typing = useTyping();
  const [open, setOpen] = useState(false);
  const [seenId, setSeenId] = useState<string | null>(null);
  const [hint, setHint] = useState(false);
  const wasGenerating = useRef(generating);
  const data = query.data;
  // 回复结束（generating 从 true 变回 false）后重新读一次：满 3 轮时后台已开始自动更新。
  useEffect(() => {
    if (wasGenerating.current && !generating) void query.refetch();
    wasGenerating.current = generating;
  }, [generating, query]);
  useEffect(() => {
    if (sessionId) setSeenId(readLocal(SEEN_KEY(sessionId)));
  }, [sessionId]);
  const enabled = Boolean(sessionId && data && (data.source !== 'none' || data.memory.enabled));
  useEffect(() => {
    if (!enabled || readLocal(HINT_KEY)) return;
    setHint(true);
    writeLocal(HINT_KEY, '1');
    const timer = window.setTimeout(() => setHint(false), 6000);
    return () => window.clearTimeout(timer);
  }, [enabled]);
  if (!sessionId || !data || !enabled) return null;
  const label = data.source !== 'none' ? '状态' : '记忆';
  const marker = seenMarker(data);
  const hasContent =
    data.snapshot?.trigger === 'auto' || Boolean(data.memory.state?.records.length);
  const unseen = hasContent && marker !== seenId;
  const markSeen = () => {
    writeLocal(SEEN_KEY(sessionId), marker);
    setSeenId(marker);
  };
  const openPanel = () => {
    setOpen(true);
    setHint(false);
    markSeen();
  };
  return (
    <>
      {!typing && !open ? (
        <StatusTab data={data} label={label} unseen={unseen} onOpen={openPanel} />
      ) : null}
      {hint && !typing && !open ? (
        <div
          role="status"
          className="fixed right-12 top-[calc(58%+0.75rem)] z-30 whitespace-nowrap rounded-xl bg-primary px-3 py-2 text-[12.5px] font-semibold text-primary-foreground shadow-lg"
        >
          点这里看{label}
        </div>
      ) : null}
      {open ? (
        <StatusDrawer
          sessionId={sessionId}
          data={data}
          characterName={characterName}
          returnTo={returnTo}
          onClose={() => {
            // 面板里手动更新过，关掉时也算看过
            markSeen();
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
