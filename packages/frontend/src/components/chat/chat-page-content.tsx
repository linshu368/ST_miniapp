'use client';

import dynamic from 'next/dynamic';
import type { ReactNode } from 'react';
import { AlertCircle, X } from 'lucide-react';
import { FIRST_TOKEN_RETRY_MESSAGE, type ChatMessage } from '@miniapp/shared';
import type { ChatPageModel } from '@/hooks/use-chat-page';
import { CHAT_PREFERENCES_SAVING } from '@/hooks/use-chat-preference-guard';
import {
  CONVERSATION_RECOVERING_MESSAGE,
  CONVERSATION_SLOW_NETWORK_MESSAGE,
} from '@/lib/api/conversation-stream';
import { customVoicePath } from '@/lib/chat-entry';
import { choiceButtonsDisabled } from '@/lib/text-postprocess/choice-gate';
import { planMessageReply } from '@/lib/text-postprocess/reply-plan';
import { ChatComposer } from './chat-composer';
import { ChatMessageList } from './chat-message-list';
import { ChatMessageLikeButton } from './chat-message-like-button';
import {
  canBranchFromMessage,
  canLikeMessage,
  getChatReplyPresentation,
} from './chat-reply-presentation';
import { ChatRegenerateButton } from './chat-regenerate-button';
import { ChatSurface } from './chat-surface';
import { ChatToolsSheet } from './chat-tools-sheet';
import { ChatTopBar } from './chat-top-bar';
import { ChatSplash } from './chat-splash';
import { ChatSecondaryReadyProvider } from './chat-entry-readiness';

const CharacterDetailSheet = dynamic(
  () =>
    import('@/components/characters/character-detail-sheet').then((m) => m.CharacterDetailSheet),
  { ssr: false }
);
const ChatStatusPanel = dynamic(
  () => import('@/components/status-bar/chat-status-panel').then((m) => m.ChatStatusPanel),
  { ssr: false }
);
const ChatSessionDrawer = dynamic(
  () => import('./chat-session-drawer').then((m) => m.ChatSessionDrawer),
  { ssr: false }
);
const ChatMessageVoiceFooter = dynamic(
  () => import('./chat-message-voice').then((m) => m.ChatMessageVoiceFooter),
  {
    ssr: false,
    loading: () => (
      <span
        role="status"
        className="inline-flex min-h-11 items-center text-[11px] text-muted-foreground"
      >
        回复工具加载中
      </span>
    ),
  }
);
type Props = { model: ChatPageModel };

export function ChatPageContent({ model }: Props) {
  const { entry, character, viewportHeight } = model;
  return (
    <ChatSecondaryReadyProvider value={entry.enrichReady}>
      <ChatSurface
        characterId={entry.characterId}
        coverSource={character?.avatar_url ?? null}
        userScope={entry.userScope}
        viewportHeight={viewportHeight}
      >
        <ChatPageHeader model={model} />
        <ChatPageMessages model={model} />
        <ChatPageNotice model={model} />
        <ChatPageComposer model={model} />
        <ChatPagePanels model={model} />
        <ChatSplash
          backHref={entry.session.backHref}
          characterId={entry.characterId}
          character={character}
          ready={entry.session.ready}
          error={entry.session.entryError}
          onRetry={entry.session.retryEntry}
        />
      </ChatSurface>
    </ChatSecondaryReadyProvider>
  );
}

function backLabel(href: string) {
  if (href === '/chats') return '返回对话';
  if (href === '/creation?tab=created') return '返回我的创作';
  if (href === '/creation?tab=favorites') return '返回收藏';
  return href.startsWith('/creators/') ? '返回作者空间' : '返回发现';
}

function ChatPageHeader({ model: m }: Props) {
  const e = m.entry;
  return (
    <ChatTopBar
      backLabel={backLabel(e.session.backHref)}
      onBack={m.goBack}
      characterId={e.characterId}
      title={m.title}
      characterName={m.character?.name}
      onOpenCharacter={() => {
        e.setCharacterPanelLoaded(true);
        e.setCharacterPanel('intro');
      }}
      onOpenSessions={() => {
        e.setSessionsLoaded(true);
        e.setSessionsOpen(true);
      }}
      returnTo={e.session.returnTo}
      generating={m.turn.generating}
    />
  );
}

function ChatPageMessages({ model: m }: Props) {
  const { entry: e, turn: t, history: h, branch } = m;
  return (
    <ChatMessageList
      key={e.activeSessionId ?? 'pending'}
      messages={t.messages}
      freeZoneCatalog={m.catalog.data}
      editDisabled={t.generating || t.serverBusy || branch.creating || !e.session.ready}
      onEditingChange={e.setEditingMessage}
      viewportHeight={m.viewportHeight}
      characterName={m.character?.name ?? ''}
      characterAvatarUrl={m.characterAvatarUrl}
      userAvatarUrl={m.userAvatarUrl}
      hasMore={h.hasMoreEarlier}
      loadingEarlier={h.loadingEarlier}
      onLoadEarlier={() => void h.handleLoadEarlier()}
      awaitingFirstToken={
        t.generating &&
        t.streaming?.assistantMessageId === null &&
        !(
          t.lastMessage?.role === 'assistant' &&
          t.lastMessage.turn_index === t.streaming.turnIndex &&
          t.lastMessage.revision === t.streaming.revision &&
          t.lastMessage.request_id === t.streaming.requestId
        )
      }
      replyStalled={t.replyStalled}
      streamingMessageId={t.streaming?.assistantMessageId ?? null}
      freeZoneSwitchNotice={t.freeZoneSwitchNotice}
      displayName={m.displayName}
      replyPlanFor={(message) => planMessageReply(message, m.versionStates)}
      choiceDisabledFor={(message) =>
        choiceButtonsDisabled({
          message,
          messages: t.messages,
          gates: m.choices.gates,
          lock: m.choices.lock,
        })
      }
      onChoice={m.choices.handleChoice}
      detailsDefaultOpen={e.preferences.detailsDefaultOpen}
      thinkingByMessage={t.thinkingByMessage}
      branchFor={(message) =>
        canBranchFromMessage(message)
          ? {
              pending: branch.pendingMessageId === message.id,
              onBranch: () => {
                if (!t.generating && !t.serverBusy && !e.editingMessage) void branch.fork(message);
              },
            }
          : undefined
      }
      renderFooter={(message, tools, editAction) => (
        <ChatPageFooter model={m} message={message} tools={tools} editAction={editAction} />
      )}
    />
  );
}

function ChatPageFooter({
  model: m,
  message,
  tools,
  editAction,
}: Props & {
  message: ChatMessage;
  tools: ReactNode;
  editAction: ReactNode;
}) {
  const { entry: e, turn: t, branch, voice, likes } = m;
  const showVoice =
    !message.inherited &&
    getChatReplyPresentation(message) === 'complete' &&
    message.turn_index > 0;
  const showRegenerate = t.canRegenerate && message.id === t.lastMessage?.id;
  const showLike = canLikeMessage(message);
  if (!showVoice && !showRegenerate && !canBranchFromMessage(message) && !showLike) return null;
  return (
    <div>
      <ChatMessageVoiceFooter
        charCount={message.content.length}
        likeAction={
          showLike ? (
            <ChatMessageLikeButton
              message={message}
              onConfirmed={likes.handleLikeConfirmed}
              onFeedback={likes.handleLikeFeedback}
            />
          ) : null
        }
        toolsAction={tools}
        editAction={editAction}
        voice={
          showVoice
            ? {
                voice: voice.byMessage.get(message.id),
                readState: voice.readState,
                onLoad: voice.load,
                playbackRate: voice.config?.config.playback_rate ?? 1,
                submitting: voice.submittingMessageId === message.id,
                onGenerate: () => voice.generate(message.id),
                customHref: e.activeSessionId
                  ? customVoicePath(e.characterId, message.id, {
                      sessionId: e.activeSessionId,
                      returnTo: e.session.returnTo,
                    })
                  : null,
                freeTrialLimit: voice.config?.next_billing.free_trial_limit ?? null,
                hints: {
                  overLimit: voice.config?.hints?.over_limit ?? '',
                  draftFailed: voice.config?.hints?.draft_failed ?? '',
                  ttsFailed: voice.config?.hints?.tts_failed ?? '',
                },
              }
            : null
        }
        regenerate={
          showRegenerate ? (
            <ChatRegenerateButton
              onRegenerate={() => void m.guard.runTurn({ mode: 'regenerate' })}
              pending={false}
              disabled={t.generating || branch.creating || e.editingMessage || m.guard.saving}
              label={getChatReplyPresentation(message) === 'complete' ? '换一个回复' : '重新生成'}
            />
          ) : null
        }
      />
      {likes.likeFeedback?.sessionId === e.activeSessionId &&
      likes.likeFeedback.messageId === message.id &&
      likes.likeFeedback.text ? (
        <p role="status" className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {likes.likeFeedback.text}
        </p>
      ) : null}
      {branch.error?.messageId === message.id ? (
        <p role="alert" className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {branch.error.text}
        </p>
      ) : null}
    </div>
  );
}

function softNotice(message: string): boolean {
  return [
    FIRST_TOKEN_RETRY_MESSAGE,
    CONVERSATION_RECOVERING_MESSAGE,
    CONVERSATION_SLOW_NETWORK_MESSAGE,
  ].includes(message);
}

function ChatPageNotice({ model: m }: Props) {
  const { turn: t } = m;
  if (!t.streamError) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className={
        softNotice(t.streamError)
          ? 'mx-4 mb-2 flex items-center gap-2 px-3 py-2 text-muted-foreground'
          : 'mx-4 mb-2 flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive'
      }
    >
      {!softNotice(t.streamError) ? <AlertCircle className="h-4 w-4 shrink-0" aria-hidden /> : null}
      <span className="min-w-0 flex-1 text-[12px]">{t.streamError}</span>
      {t.streamError === FIRST_TOKEN_RETRY_MESSAGE && t.canRegenerate ? (
        <button
          type="button"
          onClick={() => void m.guard.runTurn({ mode: 'regenerate' })}
          disabled={t.generating || t.serverBusy || m.branch.creating || m.guard.saving}
          className="shrink-0 text-[12px] underline decoration-current/30 underline-offset-4 hover:text-foreground disabled:opacity-50"
        >
          再试一次
        </button>
      ) : null}
      <button
        type="button"
        onClick={() => t.setStreamError(null)}
        aria-label="关闭提示"
        className="shrink-0 opacity-60 hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}

function ChatPageComposer({ model: m }: Props) {
  const { entry: e, turn: t } = m;
  if (e.editingMessage) return null;
  return (
    <ChatComposer
      viewportHeight={m.viewportHeight}
      value={e.draft}
      onChange={e.setDraft}
      onSend={m.handleSend}
      onStop={() => void t.abort()}
      cancelling={t.cancelling}
      generating={t.generating}
      disabled={
        !e.session.ready || t.serverBusy || m.branch.creating || e.editingMessage || m.guard.saving
      }
      detailsDefaultOpen={e.preferences.detailsDefaultOpen}
      onDetailsDefaultOpenChange={e.preferences.handleDetailsDefaultOpenChange}
      thinkingEnabled={e.preferences.thinkingEnabled}
      onThinkingEnabledChange={(enabled) => {
        e.preferences.changeThinkingEnabled(enabled);
        m.thinkingNotice.onThinkingToggled(enabled);
      }}
      notice={m.guard.saving ? CHAT_PREFERENCES_SAVING : m.thinkingNotice.notice}
      leftSlot={
        <ChatToolsSheet characterId={e.characterId} coverSource={m.character?.avatar_url ?? null} />
      }
    />
  );
}

function ChatPagePanels({ model: m }: Props) {
  const e = m.entry;
  const session = e.session;
  return (
    <>
      {e.characterPanelLoaded ? (
        <CharacterDetailSheet
          characterId={e.characterPanel ? e.characterId : null}
          summary={m.character}
          initialTab={e.characterPanel ?? 'intro'}
          inConversation
          onClose={() => e.setCharacterPanel(null)}
          onEnter={() => e.setCharacterPanel(null)}
        />
      ) : null}
      {e.sessionsLoaded ? (
        <ChatSessionDrawer
          open={e.sessionsOpen}
          onOpenChange={e.setSessionsOpen}
          characterId={e.characterId}
          characterName={m.character?.name}
          activeSessionId={e.activeSessionId}
          onSelect={(id) => {
            m.branch.leaveView();
            m.handoff.clear();
            session.selectSession(id);
          }}
          onCreateConversation={() => {
            m.branch.leaveView();
            m.handoff.clear();
            session.openNewConversation();
          }}
          creating={session.createConversation.isPending}
        />
      ) : null}
      {e.enrichReady ? (
        <ChatStatusPanel
          sessionId={e.activeSessionId}
          characterName={m.character?.name ?? ''}
          generating={m.turn.generating}
          returnTo={e.session.returnTo}
        />
      ) : null}
    </>
  );
}
