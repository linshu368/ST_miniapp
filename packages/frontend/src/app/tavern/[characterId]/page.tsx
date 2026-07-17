'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { platformAction, useBridgeStatus, useSTEvent } from '@/lib/bridge';
import { prefetchEnsureStCharacter } from '@/lib/api/st-bridge';
import { ChatHeader } from '@/components/tavern/chat-header';
import { ChatToolsMenu } from '@/components/tavern/chat-tools-menu';
import { ChatSplash } from '@/components/tavern/chat-splash';
import { CHAT_INTERACTIVITY_EVENT } from '@/components/bridge/st-iframe';
import { useSTMirrorStore } from '@/stores/st-mirror';
// [iframe-timing] TEMP DEBUG
import { markTiming, resetPageTiming, flushIframeTiming } from '@/lib/bridge/iframe-timing';

export default function TavernChatPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const router = useRouter();
  const bridgeStatus = useBridgeStatus();
  // T2：interactive 即放行（selectCharacter requiredPhase 已降为 interactive），ready 兼容
  // 旧 ST 两段握手。用派生布尔做 effect 依赖：interactive→ready 升级时布尔值不变，
  // 不会 cleanup 重跑而作废在途 select、重复发起。
  const gateOpen = bridgeStatus === 'interactive' || bridgeStatus === 'ready';
  const bridgeStatusRef = useRef(bridgeStatus);
  bridgeStatusRef.current = bridgeStatus;
  const redirectingToRechargeRef = useRef(false);
  // 开屏动画收场信号：只有角色切换成功后才放行，避免露出 ST 原生加载画面。
  const [readyCharacterId, setReadyCharacterId] = useState<string | null>(null);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [entryAttempt, setEntryAttempt] = useState(0);
  const chatReady = readyCharacterId === characterId;

  useSTEvent('billing:insufficient', () => {
    if (!characterId || redirectingToRechargeRef.current) return;
    redirectingToRechargeRef.current = true;
    const returnTo = `/tavern/${encodeURIComponent(characterId)}`;
    const search = new URLSearchParams({
      reason: 'insufficient_credits',
      returnTo,
    });
    router.push(`/profile/recharge?${search.toString()}`);
  });

  // Splash 覆盖期间禁止 ST 内部输入框抢焦点，避免移动端在聊天出现前提前弹出键盘。
  useEffect(() => {
    window.dispatchEvent(
      new CustomEvent(CHAT_INTERACTIVITY_EVENT, { detail: { interactive: chatReady } })
    );
    return () => {
      window.dispatchEvent(
        new CustomEvent(CHAT_INTERACTIVITY_EVENT, { detail: { interactive: false } })
      );
    };
  }, [chatReady]);

  // [iframe-timing] TEMP DEBUG: 用户点卡进入本页（可能早于 bridge ready）
  useEffect(() => {
    if (!characterId) return;
    resetPageTiming();
    markTiming('page_mount');
  }, [characterId]);

  useEffect(() => {
    setReadyCharacterId(null);
    if (!characterId || !gateOpen) return;
    setEntryError(null);

    markTiming('gate_open'); // [iframe-timing] TEMP DEBUG
    // [iframe-timing] TEMP DEBUG: 闸门放行时刻的相位（interactive / ready）
    const bridgeStatusAtGate = bridgeStatusRef.current;

    let cancelled = false;

    // 懒下发：先确保「当前打开的这张卡」已落盘（登录不再全量下发），再切角色。
    // 预览浮层打开时已预取（prefetchEnsureStCharacter 全会话共享 promise），
    // 此处 await 同一个 promise：已完成则零等待，未预取（直链进入）则现场发起。
    // ensure 失败不阻断：卡可能已缓存，交给 selectCharacter 的重载+重试兜底。
    void (async () => {
      try {
        markTiming('ensure_start'); // [iframe-timing] TEMP DEBUG
        await prefetchEnsureStCharacter(characterId);
        markTiming('ensure_end'); // [iframe-timing] TEMP DEBUG
      } catch (err) {
        markTiming('ensure_end'); // [iframe-timing] TEMP DEBUG
        console.error('[TavernChatPage] ensureCharacter failed:', err);
      }
      if (cancelled) return;

      const avatar = `platform_${characterId}.png`;
      markTiming('select_start'); // [iframe-timing] TEMP DEBUG
      platformAction('selectCharacter', { avatar, forceNewChat: true })
        .then((result) => {
          markTiming('select_end'); // [iframe-timing] TEMP DEBUG
          if (result.chatId) {
            useSTMirrorStore.getState().updatePartial({ currentChatId: result.chatId });
          }
          if (!cancelled) {
            setReadyCharacterId(characterId);
            // [iframe-timing] TEMP DEBUG: 呈现时刻，flush 全部相位到后端日志
            markTiming('chat_ready');
            flushIframeTiming({ characterId, bridgeStatusAtGate });
          }
        })
        .catch((err) => {
          console.error('[TavernChatPage] selectCharacter failed:', err);
          if (!cancelled) {
            setEntryError('角色加载失败，请重试。');
          }
        });
    })();

    return () => {
      cancelled = true;
    };
  }, [gateOpen, characterId, entryAttempt]);

  return (
    <div className="relative w-full h-full">
      <ChatHeader />
      <ChatToolsMenu />
      {characterId ? (
        <ChatSplash
          key={`${characterId}:${entryAttempt}`}
          characterId={characterId}
          ready={chatReady}
          error={entryError}
          onRetry={() => setEntryAttempt((attempt) => attempt + 1)}
        />
      ) : null}
    </div>
  );
}
