import type { CsSupportConversationSummary } from '@miniapp/shared';

function formatTime(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function latestActivity(conversation: CsSupportConversationSummary): string | null {
  const stamps = [conversation.last_user_message_at, conversation.last_agent_message_at].filter(
    (value): value is string => Boolean(value)
  );
  if (stamps.length === 0) return null;
  return stamps.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}

export function SupportWorkbench(props: {
  conversations: CsSupportConversationSummary[];
  isLoading: boolean;
  errorMessage: string | null;
  selectedId: string | null;
  onSelect: (conversation: CsSupportConversationSummary) => void;
  onRefresh: () => void;
}) {
  return (
    <section className="user-panel">
      <header className="panel-header">
        <div className="panel-header-text">
          <h2>客服工作台</h2>
          <p>MiniApp 内用户提交的客服会话，与 Telegram 回访互不影响</p>
        </div>
        <div className="panel-actions">
          <button className="btn btn-sm" onClick={props.onRefresh} disabled={props.isLoading}>
            刷新
          </button>
        </div>
      </header>

      <div className="user-scroll">
        {props.isLoading && <p className="hint-text">加载中…</p>}
        {props.errorMessage && <p className="error-text">{props.errorMessage}</p>}
        {!props.isLoading && !props.errorMessage && props.conversations.length === 0 && (
          <p className="hint-text">还没有用户发起客服会话。</p>
        )}

        {props.conversations.map((conversation) => (
          <button
            key={conversation.id}
            className={`user-item ${props.selectedId === conversation.id ? 'is-active' : ''}`}
            onClick={() => props.onSelect(conversation)}
          >
            <span className="user-item-top">
              <span className="user-name">
                {conversation.display_name || `TG ${conversation.telegram_user_id}`}
              </span>
              {conversation.agent_unread_count > 0 && (
                <span className="badge badge-danger">{conversation.agent_unread_count} 待回复</span>
              )}
            </span>
            <span className="user-item-meta">{formatTime(latestActivity(conversation))}</span>
            {conversation.last_message && (
              <span className="user-item-note">{conversation.last_message}</span>
            )}
          </button>
        ))}
      </div>
    </section>
  );
}
