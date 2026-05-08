'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pin, PinOff, Pencil, Trash2 } from 'lucide-react';

interface SessionRowMenuProps {
  anchor: { x: number; y: number } | null; // 视口坐标,锚点右下方为 popover 的对齐点
  isPinned: boolean;
  onClose: () => void;
  onTogglePin: () => void;
  onRename: () => void;
  onDelete: () => void;
}

const MENU_W = 156;
const MENU_PAD = 8;

export function SessionRowMenu({
  anchor,
  isPinned,
  onClose,
  onTogglePin,
  onRename,
  onDelete,
}: SessionRowMenuProps) {
  if (!anchor || typeof document === 'undefined') return null;

  // 把 popover 卡在视口内
  const vw = window.innerWidth;
  const left = Math.min(anchor.x, vw - MENU_W - MENU_PAD);
  const top = anchor.y;

  return createPortal(
    <div className="fixed inset-0 z-[60]" role="menu">
      {/* 透明遮罩 — 点击关闭 */}
      <div className="absolute inset-0" onClick={onClose} aria-hidden="true" />

      <div
        className="animate-in fade-in zoom-in-95 absolute overflow-hidden rounded-lg border border-border/60 bg-card shadow-2xl"
        style={{ left, top, width: MENU_W }}
      >
        <MenuItem
          icon={isPinned ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />}
          label={isPinned ? '取消置顶' : '置顶'}
          onClick={() => {
            onTogglePin();
            onClose();
          }}
        />
        <MenuItem
          icon={<Pencil className="h-4 w-4" />}
          label="重命名"
          onClick={() => {
            onRename();
            onClose();
          }}
        />
        <div className="my-0.5 h-px bg-border/50" />
        <MenuItem
          icon={<Trash2 className="h-4 w-4" />}
          label="删除"
          danger
          onClick={() => {
            onDelete();
            onClose();
          }}
        />
      </div>
    </div>,
    document.body
  );
}

interface MenuItemProps {
  icon: React.ReactNode;
  label: string;
  danger?: boolean;
  onClick: () => void;
}

function MenuItem({ icon, label, danger, onClick }: MenuItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'flex w-full items-center gap-2.5 px-3 py-2.5 text-left text-[13px] transition-colors active:bg-secondary/80 ' +
        (danger
          ? 'text-destructive hover:bg-destructive/10'
          : 'text-foreground hover:bg-secondary/60')
      }
    >
      <span className={danger ? 'text-destructive/80' : 'text-muted-foreground'}>{icon}</span>
      <span>{label}</span>
    </button>
  );
}

// 重命名输入弹窗(独立组件,避免和 menu 状态耦合)
interface RenameDialogProps {
  open: boolean;
  initialValue: string;
  onClose: () => void;
  onSubmit: (next: string) => void;
}

export function RenameDialog({ open, initialValue, onClose, onSubmit }: RenameDialogProps) {
  const [value, setValue] = useState(initialValue);

  useEffect(() => {
    if (open) setValue(initialValue);
  }, [open, initialValue]);

  if (!open || typeof document === 'undefined') return null;

  const submit = () => {
    const trimmed = value.trim();
    onSubmit(trimmed);
  };

  return createPortal(
    <div className="fixed inset-0 z-[70] flex items-center justify-center px-6" role="dialog">
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="animate-in fade-in zoom-in-95 relative w-full max-w-[320px] rounded-xl border border-border/60 bg-card p-4 shadow-2xl">
        <p className="text-[13px] font-medium text-foreground">重命名</p>
        <input
          type="text"
          value={value}
          autoFocus
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            else if (e.key === 'Escape') onClose();
          }}
          maxLength={32}
          className="mt-3 w-full rounded-md border border-border/70 bg-background px-3 py-2 text-[14px] text-foreground outline-none focus:border-primary/60"
          placeholder="给这段对话起个名字"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md px-3 py-1.5 text-[13px] text-muted-foreground hover:bg-secondary/60"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            className="rounded-md bg-primary px-3 py-1.5 text-[13px] font-medium text-primary-foreground hover:opacity-90 active:opacity-80"
          >
            保存
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
