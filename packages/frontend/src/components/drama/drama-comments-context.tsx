'use client';

import dynamic from 'next/dynamic';
import { createContext, useContext, useState, type ReactNode } from 'react';

const DramaCommentSheet = dynamic(
  () => import('./comment-sheet').then((module) => module.DramaCommentSheet),
  { ssr: false }
);

const CommentsContext = createContext<{
  open: boolean;
  show: (id: string, title: string) => void;
} | null>(null);

/** 评论面板首次打开后保持挂载，保留关闭动画和用户草稿。 */
export function DramaCommentsProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<{ id: string; title: string } | null>(null);
  const [open, setOpen] = useState(false);

  return (
    <CommentsContext.Provider
      value={{
        open,
        show: (id, title) => {
          setTarget({ id, title });
          setOpen(true);
        },
      }}
    >
      {children}
      {target ? (
        <DramaCommentSheet key={target.id} {...target} open={open} onOpenChange={setOpen} />
      ) : null}
    </CommentsContext.Provider>
  );
}

export function useDramaCommentsPanel() {
  const panel = useContext(CommentsContext);
  if (!panel) throw new Error('DramaCommentsProvider is required');
  return panel;
}
