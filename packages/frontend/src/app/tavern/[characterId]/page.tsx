'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG } from '@miniapp/shared';
import { platformAction, useBridgeStatus, useSTEvent } from '@/lib/bridge';
import { prefetchEnsureStCharacter } from '@/lib/api/st-bridge';
import { fetchLatestUserChat } from '@/lib/api/chats';
import { useCharacterQuery } from '@/lib/api/characters';
import { useCharacterFreeQuotaQuery } from '@/lib/api/free-quota';
import { formatFreeQuotaExhaustedDialog } from '@/lib/free-quota-dialog';
import { ChatHeader } from '@/components/tavern/chat-header';
import { ChatToolsMenu } from '@/components/tavern/chat-tools-menu';
import { ChatSplash } from '@/components/tavern/chat-splash';
import { CHAT_INTERACTIVITY_EVENT } from '@/components/bridge/st-iframe';
import { useSTMirrorStore } from '@/stores/st-mirror';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
// [iframe-timing] TEMP DEBUG
import {
  markTiming,
  resetPageTiming,
  flushIframeTiming,
  harvestStIframeStallDiagnostics,
} from '@/lib/bridge/iframe-timing';

// [iframe-timing] TEMP DEBUG: 失败路径停摆上报阈值。beacon 原本只在 select 成功后发送，
// 卡死场景零遥测无法定位。两级停摆定时器把卡死样本的 timeline 抢救回来：
// 闸门停摆 15s（覆盖握手/boot 停摆形态），select 停摆 25s（早于 30s 动作超时，覆盖在途挂起形态）。
const GATE_STALL_FLUSH_MS = 15_000;
const SELECT_STALL_FLUSH_MS = 25_000;
// openChat 需要 ready 相位，未达标时会在桥接缓冲区排队。相位通常在 select 之后数百毫秒
// 达标；超过该阈值就改走只需 interactive 的常规加载，避免开屏页无限等待。
const OPEN_CHAT_TIMEOUT_MS = 12_000;
const FREE_QUOTA_DIALOG_DURATION_MS = 3_000;

export default function TavernChatPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedChat = searchParams.get('chat');
  const bridgeStatus = useBridgeStatus();
  // T2：interactive 即放行（selectCharacter requiredPhase 已降为 interactive），ready 兼容
  // 旧 ST 两段握手。用派生布尔做 effect 依赖：interactive→ready 升级时布尔值不变，
  // 不会 cleanup 重跑而作废在途 select、重复发起。
  const gateOpen = bridgeStatus === 'interactive' || bridgeStatus === 'ready';
  const bridgeStatusRef = useRef(bridgeStatus);
  bridgeStatusRef.current = bridgeStatus;
  // [iframe-timing] TEMP DEBUG: 供闸门停摆定时器读取最新闸门状态（不进 effect 依赖）
  const gateOpenRef = useRef(gateOpen);
  gateOpenRef.current = gateOpen;
  const redirectingToRechargeRef = useRef(false);
  // 开屏动画收场信号：只有角色切换成功后才放行，避免露出 ST 原生加载画面。
  const [readyCharacterId, setReadyCharacterId] = useState<string | null>(null);
  const [entryError, setEntryError] = useState<string | null>(null);
  const [entryAttempt, setEntryAttempt] = useState(0);
  const [freeQuotaExhaustedOpen, setFreeQuotaExhaustedOpen] = useState(false);
  const characterQuery = useCharacterQuery(characterId);
  const freeQuotaQuery = useCharacterFreeQuotaQuery(characterId);
  const exhaustedDialog = formatFreeQuotaExhaustedDialog(
    freeQuotaQuery.data?.exhausted_dialog ?? DEFAULT_FREE_QUOTA_EXHAUSTED_DIALOG_CONFIG,
    characterQuery.data?.character.name
  );
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

  useSTEvent('generation:completed', () => {
    const previousUsedRounds = freeQuotaQuery.data?.used_rounds;
    if (previousUsedRounds === undefined) return;
    void (async () => {
      for (const delayMs of [0, 100, 300, 700, 1_500]) {
        if (delayMs > 0) {
          await new Promise((resolve) => window.setTimeout(resolve, delayMs));
        }
        const { data } = await freeQuotaQuery.refetch();
        if (!data) continue;
        if (previousUsedRounds < data.quota_limit && data.used_rounds >= data.quota_limit) {
          setFreeQuotaExhaustedOpen(true);
          return;
        }
        if (data.used_rounds > previousUsedRounds) return;
      }
    })();
  });

  useEffect(() => {
    if (!freeQuotaExhaustedOpen) return;
    const timer = window.setTimeout(
      () => setFreeQuotaExhaustedOpen(false),
      FREE_QUOTA_DIALOG_DURATION_MS
    );
    return () => window.clearTimeout(timer);
  }, [freeQuotaExhaustedOpen]);

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

  // 终态 disconnected 恢复入口：重连额度耗尽后 gateOpen 永假，开屏动画会无限等待且用户
  // 无任何操作路径（此前只能杀掉 MiniApp 重开）。disconnected 也会在重连退避期短暂出现
  //（最长 8s），延迟 12s 确认终态后才提示，避免自愈过程误报。
  useEffect(() => {
    if (bridgeStatus !== 'disconnected' || chatReady) return;
    const timer = window.setTimeout(() => {
      setEntryError('连接中断，请点击重试刷新页面。');
    }, 12_000);
    return () => window.clearTimeout(timer);
  }, [bridgeStatus, chatReady]);

  // [iframe-timing] TEMP DEBUG: 用户点卡进入本页（可能早于 bridge ready）
  useEffect(() => {
    if (!characterId) return;
    resetPageTiming();
    markTiming('page_mount');
    // [iframe-timing] TEMP DEBUG: 闸门停摆上报——点卡后 15s 闸门仍未放行即 flush 部分
    // timeline（含 bridge 生命周期打点与看门狗打点），不改变页面行为；后续若闸门放行，
    // 成功/失败路径会再各自 flush，靠 meta.reason 区分同一次点卡的多条上报。
    const gateStallTimer = window.setTimeout(() => {
      if (gateOpenRef.current) return;
      markTiming('gate_stall');
      // [iframe-timing] round5: 同源收割 iframe 内 fetch 生命周期/资源/异常，定位楔死请求
      harvestStIframeStallDiagnostics();
      flushIframeTiming({
        characterId,
        reason: 'gate_stall',
        bridgeStatusNow: bridgeStatusRef.current,
      });
    }, GATE_STALL_FLUSH_MS);
    return () => window.clearTimeout(gateStallTimer);
  }, [characterId]);

  useEffect(() => {
    setReadyCharacterId(null);
    if (!characterId || !gateOpen) return;
    setEntryError(null);

    markTiming('gate_open'); // [iframe-timing] TEMP DEBUG
    // [iframe-timing] TEMP DEBUG: 闸门放行时刻的相位（interactive / ready）
    const bridgeStatusAtGate = bridgeStatusRef.current;

    let cancelled = false;

    // [iframe-timing] TEMP DEBUG: select 停摆上报——闸门放行后 25s 仍未归（早于 30s 动作
    // 超时触发的 catch），覆盖「请求在途永挂」形态；成功/失败时定时器均被解除。
    const selectStallTimer = window.setTimeout(() => {
      markTiming('select_stall');
      // [iframe-timing] round5: select 在途挂起同样收割 iframe 内部状态
      harvestStIframeStallDiagnostics();
      flushIframeTiming({
        characterId,
        bridgeStatusAtGate,
        reason: 'select_stall',
        bridgeStatusNow: bridgeStatusRef.current,
      });
    }, SELECT_STALL_FLUSH_MS);

    // 懒下发：先确保「当前打开的这张卡」已落盘（登录不再全量下发），再切角色。
    // 预览浮层打开时已预取（prefetchEnsureStCharacter 全会话共享 promise），
    // 此处 await 同一个 promise：已完成则零等待，未预取（直链进入）则现场发起。
    // ensure 失败不阻断：卡可能已缓存，交给 selectCharacter 的重载+重试兜底。
    void (async () => {
      const latestChatPromise =
        requestedChat && isSafeChatFileName(requestedChat)
          ? Promise.resolve({
              fileName: requestedChat,
              characterAvatar: `platform_${characterId}.png`,
            })
          : fetchLatestUserChat(characterId)
              .then((data) => data.item)
              .catch((err) => {
                console.warn('[TavernChatPage] latest chat lookup failed:', err);
                return null;
              });
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
      const latestChat = await latestChatPromise;
      // skipChatLoad 让 ST 在清空聊天区后跳过原生会话加载，必须由下面的 openChat 补齐。
      // 两者一旦不配对，聊天区就会停在空白状态——目标会话通常正是角色卡记录的会话，
      // 早前按「文件名与当前会话不同」才 openChat 的写法在该情况下什么都不加载。
      const targetChat =
        latestChat && isSafeChatFileName(latestChat.fileName)
          ? { fileName: latestChat.fileName, avatar: latestChat.characterAvatar || avatar }
          : null;
      markTiming('select_start'); // [iframe-timing] TEMP DEBUG
      platformAction('selectCharacter', {
        avatar,
        forceNewChat: false,
        skipChatLoad: Boolean(targetChat),
      })
        .then(async (result) => {
          window.clearTimeout(selectStallTimer); // [iframe-timing] TEMP DEBUG
          markTiming('select_end'); // [iframe-timing] TEMP DEBUG
          if (result.chatId) {
            useSTMirrorStore.getState().updatePartial({ currentChatId: result.chatId });
          }
          if (cancelled) return;
          if (targetChat) {
            // openChat 要求 ready 相位，桥接会把请求缓冲到相位达标后再投递。
            const chatId = await openTargetChat(targetChat, avatar);
            if (cancelled) return;
            useSTMirrorStore.getState().updatePartial({ currentChatId: chatId });
          }
          setReadyCharacterId(characterId);
          // [iframe-timing] TEMP DEBUG: 呈现时刻，flush 全部相位到后端日志
          markTiming('chat_ready');
          flushIframeTiming({ characterId, bridgeStatusAtGate });
        })
        .catch((err) => {
          window.clearTimeout(selectStallTimer); // [iframe-timing] TEMP DEBUG
          console.error('[TavernChatPage] selectCharacter failed:', err);
          // [iframe-timing] TEMP DEBUG: 失败路径也 flush 完整 timeline（原本只在成功时上报，
          // 卡死/超时/拒绝全是遥测盲区），带错误码与错误信息。
          markTiming('select_error');
          flushIframeTiming({
            characterId,
            bridgeStatusAtGate,
            reason: 'select_error',
            bridgeStatusNow: bridgeStatusRef.current,
            errorCode: (err as { code?: string })?.code ?? null,
            error: err instanceof Error ? err.message : String(err),
          });
          if (!cancelled) {
            setEntryError('角色加载失败，请重试。');
          }
        });
    })();

    return () => {
      cancelled = true;
      window.clearTimeout(selectStallTimer); // [iframe-timing] TEMP DEBUG
    };
  }, [gateOpen, characterId, entryAttempt, requestedChat]);

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
          onRetry={() => {
            // bridge 终态 disconnected 时页内重试无意义（闸门永不放行），整页刷新
            // 重建 iframe 与全部连接上下文；其余情况维持原有的页内重试。
            if (bridgeStatusRef.current === 'disconnected') {
              window.location.reload();
              return;
            }
            setEntryAttempt((attempt) => attempt + 1);
          }}
        />
      ) : null}
      <Dialog open={freeQuotaExhaustedOpen} onOpenChange={setFreeQuotaExhaustedOpen}>
        <DialogContent
          showCloseButton={false}
          className="w-[calc(100%-2rem)] max-w-sm rounded-2xl border-white/10 bg-[#151515] text-white"
        >
          <DialogHeader className="items-stretch text-left">
            <DialogTitle className="leading-6">{exhaustedDialog.title}</DialogTitle>
            <DialogDescription className="whitespace-pre-line pt-1 text-left leading-6 text-slate-300">
              {exhaustedDialog.description}
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/**
 * 打开指定历史会话，失败或超时时补一次常规角色加载。
 * 会话可能已被重命名或删除（聊天列表数据会过期），而此前的 selectCharacter 传了
 * skipChatLoad 已把聊天区清空，不兜底就只剩空白页面。
 */
async function openTargetChat(
  target: { fileName: string; avatar: string },
  avatar: string
): Promise<string | null> {
  try {
    const opened = await withTimeout(platformAction('openChat', target), OPEN_CHAT_TIMEOUT_MS);
    return opened.chatId;
  } catch (err) {
    console.error('[TavernChatPage] open requested chat failed:', err);
    const fallback = await platformAction('selectCharacter', { avatar, forceNewChat: false });
    return fallback.chatId;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(resolve, reject).finally(() => window.clearTimeout(timer));
  });
}

function isSafeChatFileName(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !value.includes('/') && !value.includes('\\');
}
