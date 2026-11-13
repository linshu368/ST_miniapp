'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Check, Folder, FolderOutput } from 'lucide-react';
import type { ChatFolder } from '@miniapp/shared';
import { CHAT_FOLDER_LIMIT, CHAT_FOLDER_NAME_MAX } from '@miniapp/shared';

import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

const PRIMARY =
  'inline-flex min-h-11 shrink-0 items-center justify-center rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground transition active:scale-95 disabled:opacity-50';
const SECONDARY =
  'inline-flex min-h-11 flex-1 items-center justify-center rounded-full bg-secondary px-5 text-sm text-foreground disabled:opacity-50';

function BottomSheet({
  open,
  onClose,
  title,
  description,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <SheetContent
        side="bottom"
        // 弱机上 backdrop-filter 很贵，这里只用半透明遮罩。
        overlayClassName="bg-black/55 backdrop-blur-none"
        className="mx-auto max-w-2xl rounded-t-[26px] px-4 pb-[calc(1.25rem+env(safe-area-inset-bottom))] pt-3"
        // 手机上打开就聚焦第一项只会套上一圈焦点框；只有命名面板直接聚焦输入框方便打字。
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)
            ?.querySelector<HTMLInputElement>('input[data-autofocus]')
            ?.focus();
        }}
      >
        <span aria-hidden className="mx-auto mb-3 block h-1 w-9 rounded-full bg-border" />
        <SheetTitle className="text-base font-semibold">{title}</SheetTitle>
        <SheetDescription className="mb-3 mt-1">{description}</SheetDescription>
        {children}
      </SheetContent>
    </Sheet>
  );
}

function NameField({
  initial,
  submitLabel,
  pending,
  autoFocus,
  onSubmit,
}: {
  initial: string;
  submitLabel: string;
  pending: boolean;
  autoFocus?: boolean;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  useEffect(() => setName(initial), [initial]);
  const trimmed = name.trim();
  return (
    <form
      className="flex gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmed && !pending) onSubmit(trimmed);
      }}
    >
      <input
        value={name}
        onChange={(event) => setName(event.target.value)}
        maxLength={CHAT_FOLDER_NAME_MAX}
        placeholder={`分组名，最多 ${CHAT_FOLDER_NAME_MAX} 个字`}
        aria-label="分组名"
        data-autofocus={autoFocus ? '' : undefined}
        className="h-11 min-w-0 flex-1 rounded-2xl border border-border bg-background px-3 text-sm outline-none focus:border-primary"
      />
      <button type="submit" disabled={!trimmed || pending} className={PRIMARY}>
        {pending ? '保存中…' : submitLabel}
      </button>
    </form>
  );
}

function SheetError({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="mt-2 text-xs text-destructive">
      {error}
    </p>
  ) : null;
}

export function MoveSheet({
  open,
  onClose,
  subject,
  currentFolderId,
  folders,
  pending,
  error,
  onPick,
  onCreateAndMove,
}: {
  open: boolean;
  onClose: () => void;
  /** 「林间旅人」或「已选 3 个对话」 */
  subject: string;
  /** 单条移动时当前所在分组，用于打勾和显示「移出分组」 */
  currentFolderId?: string | null;
  folders: ChatFolder[];
  pending: boolean;
  error: string | null;
  onPick: (folderId: string | null) => void;
  onCreateAndMove: (name: string) => void;
}) {
  return (
    <BottomSheet open={open} onClose={onClose} title="移到分组" description={subject}>
      <div className="max-h-[45vh] overflow-y-auto">
        {folders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            disabled={pending}
            onClick={() => onPick(folder.id)}
            className="flex min-h-12 w-full items-center gap-2.5 rounded-2xl px-3 text-left text-sm hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <Folder className="size-4 shrink-0 text-primary" aria-hidden />
            <span className="min-w-0 flex-1 truncate">{folder.name}</span>
            <span className="text-xs text-muted-foreground">{folder.session_count}</span>
            {currentFolderId === folder.id ? (
              <Check className="size-4 text-primary" aria-label="当前所在分组" />
            ) : null}
          </button>
        ))}
        {currentFolderId !== null ? (
          <button
            type="button"
            disabled={pending}
            onClick={() => onPick(null)}
            className="flex min-h-12 w-full items-center gap-2.5 rounded-2xl px-3 text-left text-sm text-muted-foreground hover:bg-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <FolderOutput className="size-4 shrink-0" aria-hidden />
            移出分组
          </button>
        ) : null}
      </div>
      {folders.length < CHAT_FOLDER_LIMIT ? (
        <div className={cn(folders.length > 0 && 'mt-2 border-t border-border pt-3')}>
          <NameField
            initial=""
            submitLabel="新建并移入"
            pending={pending}
            onSubmit={onCreateAndMove}
          />
        </div>
      ) : null}
      <SheetError error={error} />
    </BottomSheet>
  );
}

export function FolderNameSheet({
  open,
  onClose,
  title,
  initial,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  initial: string;
  pending: boolean;
  error: string | null;
  onSubmit: (name: string) => void;
}) {
  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={title}
      description="比如「主线剧情」「恋爱向」，按你自己的习惯来"
    >
      <NameField
        initial={initial}
        submitLabel="保存"
        pending={pending}
        autoFocus
        onSubmit={onSubmit}
      />
      <SheetError error={error} />
    </BottomSheet>
  );
}

export function ConfirmSheet({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  destructive,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
}) {
  return (
    <BottomSheet open={open} onClose={onClose} title={title} description={description}>
      <div className="flex gap-2">
        <button type="button" onClick={onClose} disabled={pending} className={SECONDARY}>
          取消
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className={cn(PRIMARY, 'flex-1', destructive && 'bg-destructive text-[#1d1416]')}
        >
          {pending ? '处理中…' : confirmLabel}
        </button>
      </div>
      <SheetError error={error} />
    </BottomSheet>
  );
}
