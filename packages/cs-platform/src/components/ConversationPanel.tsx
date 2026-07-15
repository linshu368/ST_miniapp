import { useEffect, useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { CsMessageData, CsPersonaData, CsSessionData, CsUserData } from '@miniapp/shared';
import { csApi } from '../api';
import { DEFAULT_SOP, SEND_STATUS_LABELS, formatDateTime } from '../constants';
import { SessionBadge } from './Badge';

export function ConversationPanel(props: {
  persona: CsPersonaData;
  user: CsUserData;
  messages: CsMessageData[];
  session: CsSessionData | null;
  onChanged: () => void;
  onToast: (message: string) => void;
}) {
  const [input, setInput] = useState('');
  const messageListRef = useRef<HTMLDivElement>(null);

  const stages = props.persona.sop.length ? props.persona.sop : DEFAULT_SOP;
  const currentPrompt = props.session?.suggested_prompt ?? props.persona.opening_script;
  const currentStage = stages.find((stage) => stage.key === props.session?.current_question_key);
  const sendContent = input.trim();

  useEffect(() => {
    const el = messageListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [props.messages.length]);

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
    onError: (error) => props.onToast(error instanceof Error ? error.message : '发送失败'),
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
        <div className="panel-header-text">
          <h2>{props.user.display_name}</h2>
          <p>
            {props.user.username ? `@${props.user.username} · ` : ''}
            注册 {props.user.register_days} 天 · {props.user.total_round} 轮 · ¥
            {props.user.total_paid_amount}
            {props.user.last_active_label ? ` · ${props.user.last_active_label}` : ''}
          </p>
        </div>
        <SessionBadge status={props.session?.status ?? 'not_started'} />
      </header>

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

      {(currentStage?.followups?.length || currentStage?.fallback_options?.length) && (
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
        {props.messages.length === 0 && (
          <p className="hint-text hint-center">还没有消息，从下方话术开始第一次触达。</p>
        )}
        {props.messages.map((message) => (
          <div key={message.id} className={`message-row ${message.direction}`}>
            <div
              className={`message-bubble ${message.send_status === 'failed' ? 'is-failed' : ''}`}
            >
              <p>{message.content}</p>
            </div>
            <span className="message-meta">
              {message.direction === 'agent' ? '客服' : '用户'} ·{' '}
              {SEND_STATUS_LABELS[message.send_status] ?? message.send_status}
              {message.failed_reason ? ` · ${message.failed_reason}` : ''} ·{' '}
              {formatDateTime(message.sent_at ?? message.received_at ?? message.created_at)}
            </span>
          </div>
        ))}
      </div>

      <footer className="composer">
        {latestFailed && (
          <button
            className="btn btn-sm btn-danger-ghost composer-retry"
            onClick={() =>
              csApi
                .retryMessage(props.persona.id, props.user.user_id, latestFailed.id)
                .then(props.onChanged)
                .catch((error) => props.onToast(error.message))
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
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && sendContent) {
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
              disabled={sendMutation.isPending || !sendContent}
            >
              {sendMutation.isPending ? '发送中…' : '发送'}
            </button>
          </div>
        </div>
        <p className="composer-hint">Ctrl / ⌘ + Enter 发送 · 消息将通过 Telegram Bot 送达用户</p>
      </footer>
    </section>
  );
}
