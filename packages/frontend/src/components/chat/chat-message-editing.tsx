'use client';

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Check, GitBranch, Loader2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { splitEditableReply, type ChatMessage } from '@miniapp/shared';
import { useChangeChatMessageMutation } from '@/lib/api/conversations';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';

export function ChatMessageEditing({
  message,
  enabled,
  disabled,
  menuDisabled,
  viewportHeight,
  branch,
  onEditingChange,
  children,
}: {
  message: ChatMessage;
  enabled: boolean;
  disabled: boolean;
  menuDisabled?: boolean;
  viewportHeight?: number | null;
  branch?: { pending: boolean; onBranch: () => void };
  onEditingChange?: (editing: boolean) => void;
  children: (slots: { actions: ReactNode; editAction: ReactNode; editor: ReactNode }) => ReactNode;
}) {
  const [mode, setMode] = useState<'menu' | 'edit' | 'delete' | null>(null);
  const editableBody =
    message.role === 'assistant' ? splitEditableReply(message.content).body : message.content;
  const [draft, setDraft] = useState(editableBody);
  const [baseVersion, setBaseVersion] = useState(message.edit_version ?? 0);
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const mutation = useChangeChatMessageMutation();
  const editing = mode === 'edit';
  const who = message.role === 'user' ? '我的消息' : '角色回复';
  const maximum = message.role === 'user' ? 8000 : 65_536;
  useEffect(() => {
    if (!editing) return;
    onEditingChange?.(true);
    return () => onEditingChange?.(false);
  }, [editing, onEditingChange]);
  useLayoutEffect(() => {
    if (!editing || !input.current) return;
    // Keep the active sentence in view; do not send the reader back to the chat tail.
    input.current.focus({ preventScroll: true });
    input.current.setSelectionRange(input.current.value.length, input.current.value.length);
  }, [editing]);
  useLayoutEffect(() => {
    const node = input.current;
    if (!editing || !node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(Math.max(120, node.scrollHeight), Math.max(80, (viewportHeight ?? 600) - 260))}px`;
  }, [editing, draft, viewportHeight]);
  useLayoutEffect(() => {
    if (!editing) return;
    input.current
      ?.closest('[data-testid=message-inline-editor]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [editing, viewportHeight, error]);

  const open = (next: 'menu' | 'edit') => {
    setDraft(editableBody);
    setBaseVersion(message.edit_version ?? 0);
    setError('');
    setMode(next);
  };
  const save = async (action: 'edit' | 'delete') => {
    if (mutation.isPending || disabled || !enabled) return;
    setError('');
    if (
      action === 'edit' &&
      message.role === 'assistant' &&
      splitEditableReply(draft).protectedTail
    ) {
      setError('这里只需填写正文，下面的选项、状态和记忆会自动保留。');
      return;
    }
    try {
      await mutation.mutateAsync({
        message,
        body:
          action === 'edit'
            ? { action, role: message.role, expected_version: baseVersion, content: draft }
            : { action, role: message.role, expected_version: baseVersion },
      });
      setMode(null);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '保存失败，内容已保留，请重试');
    }
  };
  const actions =
    enabled || branch ? (
      <button
        type="button"
        aria-label={`第${message.turn_index}轮${who}操作`}
        disabled={disabled || menuDisabled || mutation.isPending}
        onClick={() => open('menu')}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-white/5 hover:text-foreground active:bg-white/10 disabled:opacity-30"
      >
        {branch?.pending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <MoreHorizontal className="size-[18px]" aria-hidden />
        )}
      </button>
    ) : null;
  const editAction =
    enabled && message.role === 'assistant' ? (
      <button
        type="button"
        aria-label={`编辑第${message.turn_index}轮${message.role === 'assistant' ? '角色正文' : '我的消息'}`}
        title={message.role === 'assistant' ? '编辑正文' : '编辑消息'}
        disabled={disabled || menuDisabled || mutation.isPending}
        onClick={() => open('edit')}
        className="inline-flex size-11 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:bg-white/5 hover:text-foreground active:bg-white/10 disabled:opacity-30"
      >
        <Pencil className="size-4" aria-hidden />
      </button>
    ) : null;
  const editor = editing ? (
    <div
      className="my-2 w-full min-w-0 rounded-2xl border border-primary/25 bg-card/70 p-3 shadow-sm"
      data-testid="message-inline-editor"
    >
      <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Pencil className="size-3" aria-hidden />
        编辑{who}
      </div>
      <Textarea
        ref={input}
        aria-label={`编辑${who}`}
        value={draft}
        maxLength={maximum}
        readOnly={mutation.isPending}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !mutation.isPending) setMode(null);
        }}
        className="min-h-[80px] resize-none border-0 bg-transparent px-1 text-[16px] leading-relaxed shadow-none focus-visible:ring-0"
        style={{ height: Math.max(80, Math.min(260, (viewportHeight ?? 600) - 260)) }}
      />
      {error ? (
        <p role="alert" className="my-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="mt-2 flex items-center justify-between gap-2 border-t border-white/5 pt-2">
        <span className="text-[11px] text-muted-foreground">
          {message.role === 'assistant' ? '仅编辑正文' : '只修改这一条'}
        </span>
        <div className="flex gap-1">
          <Button
            type="button"
            variant="ghost"
            className="min-h-11 px-3"
            disabled={mutation.isPending}
            onClick={() => setMode(null)}
          >
            取消
          </Button>
          <Button
            type="button"
            className="min-h-11 gap-1 rounded-xl px-4"
            disabled={
              disabled ||
              !enabled ||
              mutation.isPending ||
              !draft.trim() ||
              draft === editableBody ||
              draft.length > maximum
            }
            onClick={() => void save('edit')}
          >
            {mutation.isPending ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Check className="size-3.5" aria-hidden />
            )}
            {mutation.isPending ? '保存中' : '保存'}
          </Button>
        </div>
      </div>
    </div>
  ) : null;
  return (
    <>
      {children({ actions, editAction, editor })}
      <Dialog
        open={mode === 'menu' || mode === 'delete'}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setMode(null);
        }}
      >
        <DialogContent
          className="w-[calc(100%-2rem)] rounded-2xl border-white/10 bg-card p-5"
          showCloseButton={!mutation.isPending}
          onCloseAutoFocus={(event) => {
            if (mode === 'edit') {
              event.preventDefault();
              input.current?.focus({ preventScroll: true });
              input.current
                ?.closest('[data-testid=message-inline-editor]')
                ?.scrollIntoView({ block: 'nearest' });
            }
          }}
        >
          <DialogTitle className="text-base">{who}</DialogTitle>
          <DialogDescription className="text-xs leading-relaxed">
            {enabled
              ? '只影响当前对话，其他分支会保留。'
              : '从这里开启另一条故事线，原对话会保留。'}
          </DialogDescription>
          {error ? (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
          <div className="grid gap-1">
            {enabled && message.role === 'user' ? (
              <Button
                variant="ghost"
                className="min-h-12 justify-start gap-3 rounded-xl"
                disabled={mutation.isPending}
                onClick={() => setMode('edit')}
              >
                <Pencil className="size-4" aria-hidden />
                编辑消息
              </Button>
            ) : null}
            {branch ? (
              <Button
                variant="ghost"
                className="h-auto min-h-14 justify-start gap-3 rounded-xl py-2"
                disabled={disabled || mutation.isPending || branch.pending}
                onClick={() => {
                  setMode(null);
                  branch.onBranch();
                }}
              >
                <GitBranch className="size-4 shrink-0" aria-hidden />
                <span className="flex flex-col items-start gap-0.5">
                  <span>分支到新聊天</span>
                  <span className="text-[11px] font-normal text-muted-foreground">
                    从这一轮另开聊天，原对话保留
                  </span>
                </span>
              </Button>
            ) : null}
            {enabled ? (
              <div className="mt-1 border-t border-white/5 pt-1">
                {mode === 'delete' ? (
                  <div
                    className="flex min-h-12 items-center gap-1 rounded-xl bg-destructive/10 pl-3 pr-1"
                    data-testid="message-delete-confirm"
                  >
                    <Trash2 className="mr-1 size-4 shrink-0 text-destructive" aria-hidden />
                    <span className="mr-auto text-sm" role="status">
                      确认吗？
                    </span>
                    <Button
                      variant="ghost"
                      className="min-h-11 px-2 text-xs text-muted-foreground"
                      disabled={mutation.isPending}
                      onClick={() => {
                        setError('');
                        setMode('menu');
                      }}
                    >
                      取消
                    </Button>
                    <Button
                      variant="ghost"
                      className="min-h-11 min-w-11 px-2 text-xs font-medium text-destructive hover:bg-destructive/10 hover:text-destructive"
                      aria-label="确认删除"
                      disabled={disabled || mutation.isPending}
                      onClick={() => void save('delete')}
                    >
                      {mutation.isPending ? (
                        <Loader2 className="size-4 animate-spin" aria-label="删除中" />
                      ) : (
                        '确认'
                      )}
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="ghost"
                    className="min-h-12 w-full justify-start gap-3 rounded-xl text-destructive"
                    onClick={() => setMode('delete')}
                  >
                    <Trash2 className="size-4" aria-hidden />
                    删除这条
                  </Button>
                )}
                {mode === 'delete' ? (
                  <p className="px-3 pt-2 text-[11px] leading-relaxed text-muted-foreground">
                    只删除这一条，后面的聊天会保留。
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
