'use client';

import { useState } from 'react';
import { Check, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { ChatSession } from '@miniapp/shared';

import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import {
  resolveSessionTitle,
  useConversationsQuery,
  useDeleteConversationMutation,
  useRenameConversationMutation,
} from '@/lib/api/conversations';

interface ChatSessionDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  characterId: string;
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onCreate: () => void;
  creating: boolean;
}

export function ChatSessionDrawer({
  open,
  onOpenChange,
  characterId,
  activeSessionId,
  onSelect,
  onCreate,
  creating,
}: ChatSessionDrawerProps) {
  // 抽屉关着时不查：会话列表只在用户主动翻的时候才需要新鲜
  const query = useConversationsQuery(characterId, open);
  const rename = useRenameConversationMutation(characterId);
  const remove = useDeleteConversationMutation(characterId);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);

  const sessions = query.data?.sessions ?? [];

  const startEditing = (session: ChatSession) => {
    setConfirmingDeleteId(null);
    setEditingId(session.id);
    setDraftTitle(session.title ?? '');
  };

  const commitRename = (sessionId: string) => {
    const next = draftTitle.trim();
    setEditingId(null);
    // 清空即回到「按首条消息自动命名」，契约上就是传 null
    rename.mutate({ sessionId, title: next.length > 0 ? next : null });
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-[86vw] max-w-sm border-border bg-background p-0">
        <div className="flex h-full flex-col">
          <div className="border-b border-border px-4 py-4 pt-[calc(env(safe-area-inset-top)+1rem)]">
            <SheetTitle className="text-[16px] font-bold text-foreground">对话记录</SheetTitle>
            <SheetDescription className="mt-0.5 text-[12px] text-muted-foreground">
              与这个角色的历史对话
            </SheetDescription>
          </div>

          <div className="px-4 py-3">
            <button
              type="button"
              onClick={onCreate}
              disabled={creating}
              className="flex w-full items-center justify-center gap-1.5 rounded-full bg-primary px-4 py-2.5 text-[13px] font-semibold text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-55"
            >
              {creating ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              ) : (
                <Plus className="h-4 w-4" aria-hidden />
              )}
              开始新的对话
            </button>
          </div>

          <div className="flex-1 space-y-1.5 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+1rem)]">
            {query.isLoading ? (
              <div className="flex justify-center py-10 text-[12px] text-muted-foreground">
                <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden />
                加载中
              </div>
            ) : sessions.length === 0 ? (
              <p className="px-2 py-10 text-center text-[12px] text-muted-foreground">
                还没有对话记录
              </p>
            ) : (
              sessions.map((session) => {
                const active = session.id === activeSessionId;
                const editing = session.id === editingId;

                return (
                  <div
                    key={session.id}
                    className={cn(
                      'rounded-xl border px-3 py-2.5 transition-colors',
                      active ? 'border-primary/40 bg-primary/10' : 'border-border bg-card'
                    )}
                  >
                    {editing ? (
                      <div className="flex items-center gap-2">
                        <input
                          value={draftTitle}
                          onChange={(event) => setDraftTitle(event.target.value)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') commitRename(session.id);
                            if (event.key === 'Escape') setEditingId(null);
                          }}
                          maxLength={60}
                          placeholder="留空则自动命名"
                          aria-label="会话名称"
                          autoFocus
                          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-2 py-1.5 text-[13px] text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                        />
                        <IconAction label="保存" onClick={() => commitRename(session.id)}>
                          <Check className="h-4 w-4" aria-hidden />
                        </IconAction>
                        <IconAction label="取消" onClick={() => setEditingId(null)}>
                          <X className="h-4 w-4" aria-hidden />
                        </IconAction>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            onSelect(session.id);
                            onOpenChange(false);
                          }}
                          className="min-w-0 flex-1 text-left"
                        >
                          <span className="block truncate text-[13px] font-medium text-foreground">
                            {resolveSessionTitle(session.title, session.last_message_preview)}
                          </span>
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            {formatSessionMeta(session)}
                          </span>
                        </button>
                        <IconAction label="重命名" onClick={() => startEditing(session)}>
                          <Pencil className="h-3.5 w-3.5" aria-hidden />
                        </IconAction>
                        <IconAction
                          label="删除"
                          onClick={() =>
                            setConfirmingDeleteId((current) =>
                              current === session.id ? null : session.id
                            )
                          }
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </IconAction>
                      </div>
                    )}

                    {/* 删除是不可逆的，且这里没有撤销位，所以必须再问一次 */}
                    {confirmingDeleteId === session.id ? (
                      <div className="mt-2 flex items-center justify-between gap-2 border-t border-border/60 pt-2">
                        <span className="text-[11px] text-muted-foreground">删除这段对话？</span>
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setConfirmingDeleteId(null)}
                            className="rounded-full px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-secondary"
                          >
                            取消
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmingDeleteId(null);
                              remove.mutate(session.id);
                            }}
                            className="rounded-full bg-destructive px-2.5 py-1 text-[11px] font-semibold text-destructive-foreground"
                          >
                            删除
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function IconAction({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
    >
      {children}
    </button>
  );
}

function formatSessionMeta(session: ChatSession): string {
  const count = `${session.message_count} 条`;
  if (!session.last_message_at) return count;

  const at = new Date(session.last_message_at);
  if (Number.isNaN(at.getTime())) return count;

  const now = new Date();
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();

  const stamp = sameDay
    ? at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
    : at.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });

  return `${stamp} · ${count}`;
}
