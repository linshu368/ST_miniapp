'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { platformAction, useBridgeStatus } from '@/lib/bridge';
import { useEnsureStCharacterMutation } from '@/lib/api/st-bridge';
import { ChatHeader } from '@/components/tavern/chat-header';
import { ChatToolsMenu } from '@/components/tavern/chat-tools-menu';
import { ChatSplash } from '@/components/tavern/chat-splash';
import { useSTMirrorStore } from '@/stores/st-mirror';

export default function TavernChatPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const bridgeStatus = useBridgeStatus();
  const { mutateAsync: ensureCharacter } = useEnsureStCharacterMutation();
  // 开屏动画收场信号：只有角色切换成功后才放行，避免露出 ST 原生加载画面。
  const [chatReady, setChatReady] = useState(false);

  useEffect(() => {
    setChatReady(false);
    if (!characterId || bridgeStatus !== 'ready') return;

    let cancelled = false;

    // 懒下发：先确保「当前打开的这张卡」已落盘（登录不再全量下发），再切角色。
    // ensure 失败不阻断：卡可能已缓存，交给 selectCharacter 的重载+重试兜底。
    void (async () => {
      try {
        await ensureCharacter(characterId);
      } catch (err) {
        console.error('[TavernChatPage] ensureCharacter failed:', err);
      }
      if (cancelled) return;

      const avatar = `platform_${characterId}.png`;
      platformAction('selectCharacter', { avatar, forceNewChat: true })
        .then((result) => {
          if (result.chatId) {
            useSTMirrorStore.getState().updatePartial({ currentChatId: result.chatId });
          }
          if (!cancelled) setChatReady(true);
        })
        .catch((err) => {
          console.error('[TavernChatPage] selectCharacter failed:', err);
        });
    })();

    return () => {
      cancelled = true;
    };
  }, [bridgeStatus, characterId, ensureCharacter]);

  return (
    <div className="relative w-full h-full">
      <ChatHeader />
      <ChatToolsMenu />
      {characterId ? (
        <ChatSplash key={characterId} characterId={characterId} ready={chatReady} />
      ) : null}
    </div>
  );
}
