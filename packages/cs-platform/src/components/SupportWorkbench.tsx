import type { CsSupportConversationSummary } from '@miniapp/shared';
import { getSupportApiUrl, type CsSupportEnv } from '../api';

const ENV_OPTIONS: Array<{ value: CsSupportEnv; label: string }> = [
  { value: 'test', label: '测试' },
  { value: 'production', label: '生产' },
];

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
  env: CsSupportEnv;
  onEnvChange: (env: CsSupportEnv) => void;
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
          <div
            className={`env-switch ${props.env === 'production' ? 'is-production' : ''}`}
            role="radiogroup"
            aria-label="客服工作台后端环境"
          >
            {ENV_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="radio"
                aria-checked={props.env === option.value}
                className={`env-switch-option ${props.env === option.value ? 'is-active' : ''}`}
                onClick={() => props.onEnvChange(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <button className="btn btn-sm" onClick={props.onRefresh} disabled={props.isLoading}>
            刷新
          </button>
        </div>
      </header>

      {/* 只有工作台走这个开关，左侧回访始终连 VITE_API_URL 那套后端 */}
      <p className="env-note">
        当前环境：{props.env === 'production' ? '生产' : '测试'} · {getSupportApiUrl(props.env)}
      </p>

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
