'use client';

/**
 * 工具箱第三张卡"状态栏"（鼠尾草绿）：玩家在预览卡上点点点改这张卡的状态栏，只对自己、只对这张卡。
 * 没有 AI；说明靠写法提示、填空模板和同一套校验保证质量。改完立即保存，下一次更新状态就按新的来。
 */
import { useEffect, useState } from 'react';
import { Gauge } from 'lucide-react';
import {
  checkStatusBarTemplate,
  type CharacterStatusBarData,
  type StatusBarTemplate,
} from '@miniapp/shared';
import { ApiClientError } from '@/lib/api/client';
import {
  useCharacterStatusBarQuery,
  useSaveCharacterStatusBarMutation,
} from '@/lib/api/status-bar';
import { StatusBarEditor } from '@/components/status-bar/status-bar-editor';
import { emptyStatusTemplate } from '@/components/status-bar/status-template';
import { ModuleCard, useFoldState } from './chat-character-settings';

function summary(data: CharacterStatusBarData | undefined) {
  if (!data) return '读取中…';
  if (data.source === 'player') return '已按你的改过 · 下一次更新生效';
  if (data.source === 'card') return '用的是作者的版本，点开就能改';
  return '这张卡没有设定状态栏，由 AI 自动挑选；也可以自己加';
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

  const persist = (next: StatusBarTemplate | null) => {
    setMessage('');
    save.mutate(next, {
      onSuccess: () => setMessage(next ? '已保存，下一次更新状态时生效' : '已恢复作者的版本'),
      onError: (error) =>
        setMessage(
          error instanceof ApiClientError && error.status === 400
            ? error.message
            : '没保存成功，再试一次'
        ),
    });
  };
  const change = (next: StatusBarTemplate) => {
    setWorking(next);
    // 整栏都合格才保存（比如刚加了一个空分区时先留在本地），并说清还差什么。
    const issues = checkStatusBarTemplate(next);
    if (issues.length === 0) persist(next);
    else setMessage(`还没保存：${issues[0]!.message}`);
  };

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
            点任意一项修改，下一次更新状态时生效。只改你自己的，不影响作者和别的玩家。
          </p>
          <StatusBarEditor
            template={working}
            onChange={change}
            mode="player"
            disabled={save.isPending}
          />
          <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-3 text-[11.5px]">
            <span role="status" className="text-muted-foreground">
              {save.isPending ? '保存中…' : message}
            </span>
            {data?.source === 'player' && data.cardTemplate ? (
              <button
                type="button"
                className="min-h-9 text-primary underline underline-offset-4"
                disabled={save.isPending}
                onClick={() => persist(null)}
              >
                恢复作者的版本
              </button>
            ) : null}
          </div>
        </div>
      )}
    </ModuleCard>
  );
}
