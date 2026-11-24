'use client';

/**
 * 工具箱第三张卡"状态栏"（鼠尾草绿）：玩家在预览卡上点点点改这张卡的状态栏，只对自己、只对这张卡。
 * 也可以说说想要什么、想怎么改，让 AI 按玩家的方向生成或改（玩家说了算，AI 只守格式）；
 * 每一项的说明也能让 AI 在玩家写的基础上补完整。改完立即保存，下一次更新状态就按新的来；
 * AI 改的那一下可以撤销。
 */
import { useEffect, useState } from 'react';
import { Gauge, Loader2, Sparkles } from 'lucide-react';
import {
  STATUS_BAR_DIRECTION_MAX_CHARS,
  checkStatusBarTemplate,
  countStatusBarItems,
  type CharacterStatusBarData,
  type StatusBarItem,
  type StatusBarTemplate,
} from '@miniapp/shared';
import { ApiClientError } from '@/lib/api/client';
import {
  useCharacterStatusBarQuery,
  usePlayerStatusBarAi,
  useSaveCharacterStatusBarMutation,
} from '@/lib/api/status-bar';
import { StatusBarEditor } from '@/components/status-bar/status-bar-editor';
import { emptyStatusTemplate } from '@/components/status-bar/status-template';
import { ModuleCard, useFoldState } from './chat-character-settings';

function summary(data: CharacterStatusBarData | undefined) {
  if (!data) return '读取中…';
  if (data.source === 'player') return '已按你的改过 · 下一次更新生效';
  if (data.source === 'card') return '用的是作者的版本，点开就能改';
  return '这张卡还没有状态栏，可以自己加一个';
}

function aiError(error: unknown): string {
  if (error instanceof ApiClientError && error.code === 'RATE_LIMITED')
    return '上一次还在处理中，稍等一下';
  if (error instanceof ApiClientError && error.code === 'STATUS_AI_INVALID')
    return `AI 这次没写好：${error.message}，再试一次`;
  return 'AI 暂时不可用，请稍后再试。状态栏没有改动';
}

/** 说说想要什么 / 想怎么改：已有状态栏时"按我说的改"为主，也能整套重新生成。 */
function PlayerStatusAi({
  hasItems,
  busy,
  pending,
  onRun,
}: {
  hasItems: boolean;
  busy: boolean;
  pending: 'generate' | 'edit' | null;
  onRun: (action: 'generate' | 'edit', text: string) => Promise<boolean>;
}) {
  const [text, setText] = useState('');
  const wanted = text.trim();
  const run = (action: 'generate' | 'edit') =>
    void onRun(action, wanted).then((done) => done && setText(''));
  const spinner = <Loader2 className="size-3.5 animate-spin" aria-hidden />;
  const sparkle = <Sparkles className="size-3.5" aria-hidden />;
  return (
    <div className="grid gap-2 rounded-2xl bg-secondary dark:bg-white/[0.04] p-3 ring-1 ring-inset ring-border dark:ring-white/[0.06]">
      <span className="text-[12px] text-muted-foreground">
        {hasItems
          ? '说说想怎么改，AI 按你说的改，没提到的不动'
          : '说说想要什么样的状态栏，不写就按这张卡来'}
      </span>
      <textarea
        className="min-h-[68px] resize-y rounded-xl border border-input bg-card px-3 py-2 text-[13px] leading-6 outline-none placeholder:text-[12.5px] placeholder:text-muted-foreground focus:border-primary/60"
        value={text}
        maxLength={STATUS_BAR_DIRECTION_MAX_CHARS}
        disabled={busy}
        placeholder={
          hasItems
            ? '比如：加一个她的羞耻度，到 100 就会主动；好感度换成星级；删掉体力'
            : '比如：记她对我的好感和欲望，再列一份我们之间的秘密'
        }
        onChange={(event) => setText(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        {hasItems ? (
          <button
            type="button"
            disabled={busy || !wanted}
            onClick={() => run('edit')}
            className="flex min-h-10 items-center gap-1 rounded-xl border border-primary/40 bg-primary/10 px-3.5 text-[13px] text-primary disabled:opacity-50"
          >
            {pending === 'edit' ? spinner : sparkle}
            按我说的改
          </button>
        ) : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => run('generate')}
          className={
            hasItems
              ? 'min-h-10 px-1 text-[12.5px] text-primary underline underline-offset-4 disabled:opacity-50'
              : 'flex min-h-10 items-center gap-1 rounded-xl border border-primary/40 bg-primary/10 px-3.5 text-[13px] text-primary disabled:opacity-50'
          }
        >
          {hasItems ? null : pending === 'generate' ? spinner : sparkle}
          {pending === 'generate'
            ? '正在生成…'
            : hasItems
              ? wanted
                ? '按我说的整套重新生成'
                : '整套重新生成'
              : wanted
                ? 'AI 按我说的生成'
                : 'AI 按这张卡生成'}
        </button>
        {pending ? (
          <span className="text-[11.5px] text-muted-foreground">大约要半分钟到一分钟</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * 玩家侧 AI：按方向生成 / 改整栏（成功就保存，可撤销这一下）、帮写一项说明（带整套作参考）。
 * run 成功返回 true（清空输入）；失败只提示，状态栏不动。
 */
function usePlayerAiActions({
  characterId,
  working,
  data,
  change,
  setMessage,
}: {
  characterId: string;
  working: StatusBarTemplate | null;
  data: CharacterStatusBarData | undefined;
  change: (next: StatusBarTemplate, done?: string) => void;
  setMessage: (message: string) => void;
}) {
  const ai = usePlayerStatusBarAi(characterId);
  const [pending, setPending] = useState<'generate' | 'edit' | null>(null);
  /** AI 改之前的样子；template=null 表示当时用的是作者的版本（或还没有），撤销就恢复作者的。 */
  const [undo, setUndo] = useState<{ template: StatusBarTemplate | null } | null>(null);
  const run = async (action: 'generate' | 'edit', text: string) => {
    if (!working || !data) return false;
    const before = { template: data.source === 'player' ? working : null };
    setPending(action);
    setMessage('');
    try {
      const result = await ai.mutateAsync(
        action === 'edit'
          ? { action, template: working, instruction: text }
          : text
            ? { action, direction: text }
            : { action }
      );
      if (result.action === 'describe') return false;
      setUndo(before);
      const done = action === 'edit' ? '已按你说的改好并保存' : '已生成并保存';
      change(result.template, result.remark ? `${done}。${result.remark}` : done);
      return true;
    } catch (error) {
      setMessage(aiError(error));
      return false;
    } finally {
      setPending(null);
    }
  };
  const describe = async (item: StatusBarItem) => {
    const result = await ai.mutateAsync({
      action: 'describe',
      item,
      ...(working ? { template: working } : {}),
    });
    return result.action === 'describe' ? result.desc : item.desc;
  };
  return { pending, undo, clearUndo: () => setUndo(null), run, describe };
}

/** 保存结果 + 撤销 AI 的修改 / 恢复作者的版本（撤销优先显示）。 */
function StatusFooter({
  message,
  busy,
  onUndo,
  onRestoreCard,
}: {
  message: string;
  busy: boolean;
  onUndo: (() => void) | null;
  onRestoreCard: (() => void) | null;
}) {
  const link = 'min-h-9 text-primary underline underline-offset-4';
  return (
    <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 text-[11.5px]">
      <span role="status" className="text-muted-foreground">
        {message}
      </span>
      <span className="flex flex-wrap gap-x-3">
        {onUndo && !busy ? (
          <button type="button" className={link} onClick={onUndo}>
            撤销 AI 的修改
          </button>
        ) : null}
        {onRestoreCard && !onUndo ? (
          <button type="button" className={link} disabled={busy} onClick={onRestoreCard}>
            恢复作者的版本
          </button>
        ) : null}
      </span>
    </div>
  );
}

export function ChatStatusModule({ characterId }: { characterId: string }) {
  const query = useCharacterStatusBarQuery(characterId);
  const save = useSaveCharacterStatusBarMutation(characterId);
  const [open, toggle] = useFoldState('status', false);
  const [working, setWorking] = useState<StatusBarTemplate | null>(null);
  const [message, setMessage] = useState('');
  const data = query.data;
  useEffect(() => {
    if (data) setWorking(data.template ?? emptyStatusTemplate());
  }, [data]);

  const persist = (next: StatusBarTemplate | null, done?: string) => {
    setMessage('');
    save.mutate(next, {
      onSuccess: () =>
        setMessage(done ?? (next ? '已保存，下一次更新状态时生效' : '已恢复作者的版本')),
      onError: (error) =>
        setMessage(
          error instanceof ApiClientError && error.status === 400
            ? error.message
            : '没保存成功，再试一次'
        ),
    });
  };
  const change = (next: StatusBarTemplate, done?: string) => {
    setWorking(next);
    // 整栏都合格才保存（比如刚加了一个空分区时先留在本地），并说清还差什么。
    const issues = checkStatusBarTemplate(next);
    if (issues.length === 0) persist(next, done);
    else setMessage(`还没保存：${issues[0]!.message}`);
  };
  const ai = usePlayerAiActions({ characterId, working, data, change, setMessage });
  const busy = save.isPending || ai.pending !== null;

  return (
    <ModuleCard
      tone="sage"
      icon={Gauge}
      title="状态栏"
      tag="只对这张卡"
      summary={summary(data)}
      open={open}
      onToggle={toggle}
    >
      {!working ? (
        <p className="text-[12.5px] text-muted-foreground">
          {query.isError ? '没读到状态栏，稍后再试' : '读取中…'}
        </p>
      ) : (
        <div className="grid gap-2">
          <p className="text-[11.5px] text-muted-foreground">
            点任意一项修改，或者让 AI
            按你说的改，下一次更新状态时生效。只改你自己的，不影响作者和别的玩家。
          </p>
          <StatusBarEditor
            template={working}
            onChange={(next) => {
              ai.clearUndo();
              change(next);
            }}
            mode="player"
            describe={ai.describe}
            disabled={busy}
          />
          <PlayerStatusAi
            hasItems={countStatusBarItems(working) > 0}
            busy={busy}
            pending={ai.pending}
            onRun={ai.run}
          />
          <StatusFooter
            message={save.isPending ? '保存中…' : message}
            busy={busy}
            onUndo={
              ai.undo
                ? () => {
                    const target = ai.undo!.template;
                    ai.clearUndo();
                    if (target) change(target, '已撤销 AI 的修改');
                    else persist(null, '已撤销 AI 的修改');
                  }
                : null
            }
            onRestoreCard={
              data?.source === 'player' && data.cardTemplate ? () => persist(null) : null
            }
          />
        </div>
      )}
    </ModuleCard>
  );
}
