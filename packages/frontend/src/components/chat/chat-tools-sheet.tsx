'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';
import { WandSparkles } from 'lucide-react';

const ChatToolsPanel = dynamic(
  () => import('./chat-tools-panel').then((module) => module.ChatToolsPanel),
  { ssr: false }
);

interface ChatToolsSheetProps {
  characterId: string;
  /** 角色封面原图地址，界面设置里可直接当背景 */
  coverSource: string | null;
}

/** 工具按钮留在输入区关键路径，面板内容在用户首次打开时再下载。 */
export function ChatToolsSheet({ characterId, coverSource }: ChatToolsSheetProps) {
  const [loaded, setLoaded] = useState(false);
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => {
          setLoaded(true);
          setOpen(true);
        }}
        aria-label="工具箱"
        className="flex size-10 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground active:scale-95"
      >
        <WandSparkles className="size-5" aria-hidden />
      </button>

      {loaded ? (
        <ChatToolsPanel
          characterId={characterId}
          coverSource={coverSource}
          open={open}
          onOpenChange={setOpen}
        />
      ) : null}
    </>
  );
}
