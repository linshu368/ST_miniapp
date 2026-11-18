import type { ReactNode } from 'react';

/** 角色设定页与人设编辑页共用的行样式：与回复偏好里的选项行一致。 */
export const ROW_BASE =
  'flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-wait disabled:opacity-60';
export const ROW_ON = 'border-primary/35 bg-primary/10';
export const ROW_OFF = 'border-border bg-secondary/35 hover:bg-secondary/60';

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-full bg-primary/10 px-2 py-px text-[10px] font-medium text-primary">
      {children}
    </span>
  );
}
