import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type {
  CsAppChatTurnData,
  CsMessageData,
  CsPersonaData,
  CsSessionData,
  CsTelegramReachabilityData,
  CsUserData,
} from '@miniapp/shared';
import { csApi } from '../api';
import { DEFAULT_SOP, SEND_STATUS_LABELS, formatDateTime } from '../constants';
import { SessionBadge, WaitingBadge } from './Badge';
import { SpecialNoteModal } from './SpecialNoteModal';
import defaultUserAvatar from '../../../../20260713-130353.png';

export function ConversationPanel(props: {
  persona: CsPersonaData;
  user: CsUserData;
  messages: CsMessageData[];
  appChatTurns: CsAppChatTurnData[];
  telegramReachability: CsTelegramReachabilityData | null;
  session: CsSessionData | null;
  onChanged: () => void;
  onToast: (message: string) => void;
}) {
  const [input, setInput] = useState('');
  const [conversationView, setConversationView] = useState<'outreach' | 'app-chat'>('outreach');
  const [noteOpen, setNoteOpen] = useState(false);
  const messageListRef = useRef<HTMLDivElement>(null);

  const stages = props.persona.sop.length ? props.persona.sop : DEFAULT_SOP;
  const currentPrompt = props.session?.suggested_prompt ?? props.persona.opening_script;
  const currentStage = stages.find((stage) => stage.key === props.session?.current_question_key);
  const sendContent = input.trim();

  useEffect(() => {
    const el = messageListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [conversationView, props.appChatTurns.length, props.messages.length]);

  useEffect(() => {
    setConversationView('outreach');
  }, [props.user.user_id]);

  const sendMutation = useMutation({
    mutationFn: (content: string) =>
      csApi.sendMessage(props.persona.id, props.user.user_id, {
        content,
        sop_stage: props.session?.current_stage ?? stages[0]?.key,
        question_key: props.session?.current_question_key ?? stages[0]?.key,
        idempotency_key: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      }),
    onSuccess: () => {
      setInput('');
      props.onChanged();
    },
    onError: (error) => {
      const message = error instanceof Error ? error.message : 'Telegram 消息发送失败';
      props.onToast(`发送失败：${message}`);
      // The backend has already persisted send_failed before returning 502.
      // Refresh immediately so the session badge and failed-message retry UI do not stay stale.
      props.onChanged();
    },
  });

  const actionMutation = useMutation({
    mutationFn: (action: 'advance' | 'complete' | 'snooze' | 'skip') => {
      if (action === 'snooze') return csApi.snooze(props.persona.id, props.user.user_id, {});
      if (action === 'skip')
        return csApi.skip(props.persona.id, props.user.user_id, { reason: '客服判断无需继续沟通' });
      if (action === 'complete')
        return csApi.advance(props.persona.id, props.user.user_id, { status: 'completed' });
      const currentIndex = stages.findIndex(
        (stage) => stage.key === props.session?.current_question_key
      );
      const nextStage = stages[Math.min(currentIndex + 1, stages.length - 1)] ?? stages[0];
      return csApi.advance(props.persona.id, props.user.user_id, {
        next_stage: nextStage.key,
        next_question_key: nextStage.key,
        status: 'following_up',
      });
    },
    onSuccess: () => props.onChanged(),
    onError: (error) => props.onToast(error instanceof Error ? error.message : '操作失败'),
  });

  const latestFailed = [...props.messages]
    .reverse()
    .find((message) => message.send_status === 'failed');

  return (
    <section className="conversation-panel">
      <header className="panel-header">
        <div className="conversation-user">
          <UserAvatar user={props.user} className="conversation-user-avatar" />
          <div className="panel-header-text">
            <h2>{props.user.display_name}</h2>
            <p>
              {props.user.username ? `@${props.user.username} · ` : ''}
              注册 {props.user.register_days} 天 · {props.user.total_round} 轮 · ¥
              {props.user.total_paid_amount}
              {props.user.last_active_label ? ` · ${props.user.last_active_label}` : ''}
            </p>
          </div>
        </div>
        <div className="panel-header-right">
          <WaitingBadge state={props.user.waiting_state} />
          <SessionBadge status={props.session?.status ?? 'not_started'} />
          <button
            className={`btn btn-sm ${props.user.special_note ? 'is-flagged' : ''}`}
            onClick={() => setNoteOpen(true)}
          >
            {props.user.special_note ? '已标记' : '特殊标记'}
          </button>
        </div>
      </header>

      {props.user.special_note && (
        <p className="conversation-note">
          <span className="conversation-note-label">标记</span>
          {props.user.special_note}
        </p>
      )}

      {noteOpen && (
        <SpecialNoteModal
          persona={props.persona}
          user={props.user}
          onClose={() => setNoteOpen(false)}
          onSaved={() => {
            setNoteOpen(false);
            props.onChanged();
          }}
          onToast={props.onToast}
        />
      )}

      <div className="conversation-tabs">
        <button
          className={conversationView === 'outreach' ? 'is-active' : ''}
          onClick={() => setConversationView('outreach')}
        >
          客服回访
        </button>
        <button
          className={conversationView === 'app-chat' ? 'is-active' : ''}
          onClick={() => setConversationView('app-chat')}
        >
          角色聊天
          <span>{props.appChatTurns.length}</span>
        </button>
      </div>

      {conversationView === 'outreach' && (
        <div className="sop-bar">
          <div className="sop-stages" role="tablist" aria-label="SOP 阶段">
            {stages.map((stage) => (
              <button
                key={stage.key}
                className={`sop-stage ${
                  stage.key === props.session?.current_question_key ? 'is-current' : ''
                }`}
                title={stage.prompt}
                onClick={() => setInput(stage.prompt)}
              >
                {stage.title}
              </button>
            ))}
          </div>
          <div className="sop-actions">
            <button
              className="btn btn-sm"
              onClick={() => actionMutation.mutate('advance')}
              disabled={actionMutation.isPending}
            >
              下一题
            </button>
            <button
              className="btn btn-sm"
              onClick={() => actionMutation.mutate('complete')}
              disabled={actionMutation.isPending}
            >
              完成
            </button>
            <button
              className="btn btn-sm"
              onClick={() => actionMutation.mutate('snooze')}
              disabled={actionMutation.isPending}
            >
              明日再触达
            </button>
            <button
              className="btn btn-sm"
              onClick={() => actionMutation.mutate('skip')}
              disabled={actionMutation.isPending}
            >
              跳过
            </button>
          </div>
        </div>
      )}

      {conversationView === 'outreach' &&
        (currentStage?.followups?.length || currentStage?.fallback_options?.length) && (
          <div className="quick-replies">
            {(currentStage.followups ?? []).map((followup) => (
              <button key={followup} className="quick-reply" onClick={() => setInput(followup)}>
                追问 · {followup}
              </button>
            ))}
            {(currentStage.fallback_options ?? []).map((option) => (
              <button key={option} className="quick-reply" onClick={() => setInput(option)}>
                {option}
              </button>
            ))}
          </div>
        )}

      <div className="message-list" ref={messageListRef}>
        {conversationView === 'outreach' && props.messages.length === 0 && (
          <p className="hint-text hint-center">还没有消息，从下方话术开始第一次触达。</p>
        )}
        {conversationView === 'outreach' &&
          props.messages.map((message) => (
            <div key={message.id} className={`message-row ${message.direction}`}>
              <div className="message-line">
                {message.direction === 'user' && (
                  <UserAvatar user={props.user} className="message-avatar" />
                )}
                <div
                  className={`message-bubble ${
                    message.send_status === 'failed' ? 'is-failed' : ''
                  }`}
                >
                  <p>{message.content}</p>
                </div>
              </div>
              <span className="message-meta">
                {message.direction === 'agent' ? '客服' : '用户'} ·{' '}
                {SEND_STATUS_LABELS[message.send_status] ?? message.send_status}
                {message.failed_reason ? ` · ${message.failed_reason}` : ''} ·{' '}
                {formatDateTime(message.sent_at ?? message.received_at ?? message.created_at)}
              </span>
            </div>
          ))}

        {conversationView === 'app-chat' && props.appChatTurns.length === 0 && (
          <p className="hint-text hint-center">该用户还没有角色聊天记录。</p>
        )}
        {conversationView === 'app-chat' &&
          props.appChatTurns.map((turn) => (
            <div className="app-chat-round" key={turn.id}>
              <div className="message-row user">
                <div className="message-line">
                  <UserAvatar user={props.user} className="message-avatar" />
                  <div className="message-bubble">
                    <p>{turn.user_input}</p>
                  </div>
                </div>
                <span className="message-meta">用户 · {formatDateTime(turn.created_at)}</span>
              </div>
              {turn.assistant_reply && (
                <div className="message-row assistant">
                  <div className="message-line">
                    <span className="message-avatar character-avatar" aria-hidden="true">
                      {(turn.character_name || '角').slice(0, 1)}
                    </span>
                    <div className="message-bubble">
                      <p>{turn.assistant_reply}</p>
                    </div>
                  </div>
                  <span className="message-meta">
                    {turn.character_name || '角色'} · {turn.model}
                    {turn.status !== 'success' ? ` · ${turn.status}` : ''}
                  </span>
                </div>
              )}
            </div>
          ))}
      </div>

      {conversationView === 'outreach' && (
        <footer className="composer">
          {props.telegramReachability?.reachable === false && (
            <div className="telegram-unreachable">
              {props.telegramReachability.reason ||
                '用户未启动或已屏蔽当前环境的 Telegram Bot，暂时无法主动发送消息'}
            </div>
          )}
          {latestFailed && (
            <button
              className="btn btn-sm btn-danger-ghost composer-retry"
              onClick={() =>
                csApi
                  .retryMessage(props.persona.id, props.user.user_id, latestFailed.id)
                  .then(props.onChanged)
                  .catch((error) => {
                    props.onToast(`发送失败：${error.message}`);
                    props.onChanged();
                  })
              }
            >
              重试上一条失败消息
            </button>
          )}
          <div className="composer-main">
            <textarea
              value={input}
              placeholder={currentPrompt}
              rows={3}
              disabled={props.telegramReachability?.reachable === false}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  (event.metaKey || event.ctrlKey) &&
                  sendContent &&
                  props.telegramReachability?.reachable !== false
                ) {
                  sendMutation.mutate(sendContent);
                }
              }}
            />
            <div className="composer-side">
              <button className="btn btn-sm" onClick={() => setInput(currentPrompt)}>
                填入当前话术
              </button>
              <button
                className="btn btn-primary"
                onClick={() => sendMutation.mutate(sendContent)}
                disabled={
                  sendMutation.isPending ||
                  !sendContent ||
                  props.telegramReachability?.reachable === false
                }
              >
                {sendMutation.isPending ? '发送中…' : '发送'}
              </button>
            </div>
          </div>
          <p className="composer-hint">Ctrl / ⌘ + Enter 发送 · 消息将通过 Telegram Bot 送达用户</p>
        </footer>
      )}
    </section>
  );
}

function UserAvatar({ user, className }: { user: CsUserData; className: string }) {
  return (
    <img
      className={className}
      src={user.avatar_url || defaultUserAvatar}
      alt=""
      onError={(event) => {
        event.currentTarget.src = defaultUserAvatar;
      }}
    />
  );
}
