import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CsSupportConversationSummary } from '@miniapp/shared';
import { csApi, type CsSupportEnv } from '../api';

export function SupportConversationPanel(props: {
  conversation: CsSupportConversationSummary;
  env: CsSupportEnv;
  onToast: (text: string) => void;
}) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  const messagesQuery = useQuery({
    queryKey: ['cs', 'support', props.env, 'messages', props.conversation.id],
    queryFn: () => csApi.supportMessages(props.env, props.conversation.id),
    refetchInterval: 5_000,
  });
  const messages = messagesQuery.data?.messages ?? [];

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages.length]);

  const sendMutation = useMutation({
    mutationFn: (body: string) =>
      csApi.sendSupportMessage(props.env, props.conversation.id, { body }),
    onSuccess: () => {
      setDraft('');
      void qc.invalidateQueries({ queryKey: ['cs', 'support', props.env] });
    },
    onError: (error) => props.onToast(error instanceof Error ? error.message : '回复发送失败'),
  });

  const send = () => {
    const body = draft.trim();
    if (!body || sendMutation.isPending) return;
    sendMutation.mutate(body);
  };

  return (
    <div className="conversation-panel">
      <header className="panel-header">
        <div className="panel-header-text">
          <h2>{props.conversation.display_name || `TG ${props.conversation.telegram_user_id}`}</h2>
          <p>MiniApp 客服会话 · TG {props.conversation.telegram_user_id}</p>
        </div>
      </header>

      <div className="message-list" ref={listRef}>
        {messagesQuery.isLoading && <p className="hint-text">加载中…</p>}
        {messagesQuery.isError && <p className="error-text">会话消息加载失败</p>}
        {!messagesQuery.isLoading && messages.length === 0 && (
          <p className="hint-text">这个会话还没有消息。</p>
        )}
        {messages.map((message) => (
          <div
            key={message.id}
            className={`message-row ${message.sender === 'agent' ? 'agent' : 'user'}`}
          >
            <div className="message-bubble">
              <p>{message.body}</p>
              <span className="message-meta">
                {new Date(message.created_at).toLocaleString('zh-CN', { hour12: false })}
              </span>
            </div>
          </div>
        ))}
      </div>

      <div className="composer">
        <div className="composer-main">
          <textarea
            value={draft}
            rows={3}
            maxLength={4000}
            placeholder="回复用户，内容会同步回 MiniApp 的客服会话"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-side">
            <button
              className="btn btn-primary"
              onClick={send}
              disabled={!draft.trim() || sendMutation.isPending}
            >
              {sendMutation.isPending ? '发送中…' : '发送'}
            </button>
          </div>
        </div>
        <p className="composer-hint">回复后会给用户下发一条系统消息提醒。</p>
      </div>
    </div>
  );
}
