'use client';

/**
 * 记忆要求弹层（在状态面板里从底部弹出）：玩家写对记忆栏的要求，内容上优先照办，结构和长度不变。
 * 存在这张卡上、只对自己；从下一次更新开始生效。返回键 / 点遮罩先关弹层，不关整个面板；
 * 弹层里的拖动不触发面板的右滑收起。
 */
import { useState } from 'react';
import { MEMORY_BAR_REQUEST_MAX_CHARS } from '@miniapp/shared';
import { useSaveMemoryRequestMutation } from '@/lib/api/status-bar';
import { useTelegramBackButton } from '@/lib/telegram';

export function MemoryRequestSheet({
  sessionId,
  initial,
  onClose,
}: {
  sessionId: string;
  initial: string | null;
  onClose: () => void;
}) {
  const [value, setValue] = useState(initial ?? '');
  const save = useSaveMemoryRequestMutation(sessionId);
  useTelegramBackButton(onClose, 'dialog');
  const submit = (request: string | null) =>
    save.mutate(request?.trim() || null, { onSuccess: onClose });
  return (
    <div
      className="absolute inset-0 z-10"
      role="dialog"
      aria-modal="true"
      aria-label="记忆要求"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={(event) => event.stopPropagation()}
      onPointerUp={(event) => event.stopPropagation()}
    >
      <div className="absolute inset-0 rounded-l-[26px] bg-black/55" onClick={onClose} />
      <div className="absolute inset-x-0 bottom-0 grid gap-3 rounded-t-[22px] bg-card dark:bg-[rgb(53_43_49)] px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-2.5 shadow-[0_-12px_30px_rgb(0_0_0/0.35)]">
        <span className="mx-auto h-1 w-9 rounded-full bg-border dark:bg-white/20" aria-hidden />
        <h3 className="text-[15px] font-bold">你希望记忆栏怎么记</h3>
        <p className="text-[12px] leading-relaxed text-muted-foreground">
          想着重记谁、哪段关系、哪些细节，直接写。记忆会优先照你说的记；栏目的结构和长度不变。从下一次更新开始生效，只对你和这张卡。
        </p>
        <textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          rows={4}
          maxLength={MEMORY_BAR_REQUEST_MAX_CHARS}
          placeholder="比如：着重记录好墨尘和我的关系"
          className="w-full resize-none rounded-[14px] border border-border dark:border-white/10 bg-secondary px-3 dark:bg-black/20 py-2.5 text-[16px] leading-normal text-foreground placeholder:text-muted-foreground/70 focus:outline-none focus:ring-1 focus:ring-primary/50"
        />
        <span className="-mt-1.5 justify-self-end text-[11px] text-muted-foreground">
          {value.length}/{MEMORY_BAR_REQUEST_MAX_CHARS}
        </span>
        {save.isError ? (
          <p role="alert" className="text-center text-[12px] text-destructive">
            没保存成功，再试一次
          </p>
        ) : null}
        <div className="grid grid-cols-[1fr_2fr] gap-2.5">
          <button
            type="button"
            onClick={() => submit(null)}
            disabled={save.isPending || (!initial && !value.trim())}
            className="min-h-[46px] rounded-[14px] border border-border dark:border-white/15 text-[14px] disabled:opacity-50"
          >
            清空
          </button>
          <button
            type="button"
            onClick={() => submit(value)}
            disabled={save.isPending}
            className="min-h-[46px] rounded-[14px] bg-gradient-to-r from-mauve to-primary text-[14px] font-semibold text-white dark:from-[hsl(341_33%_70%)] dark:to-primary dark:text-[#2a1a20] disabled:opacity-75"
          >
            {save.isPending ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
