import type { CsPersonaData, CsUserData } from '@miniapp/shared';
import type { Membership } from '../constants';
import { formatDateTime } from '../constants';
import { SessionBadge } from './Badge';

export function UserListPanel(props: {
  persona: CsPersonaData;
  activeUsers: CsUserData[];
  chattedLeftUsers: CsUserData[];
  isLoading: boolean;
  selectedUserId?: string;
  refreshPending: boolean;
  deletePending: boolean;
  onSelect: (user: CsUserData, membership: Membership) => void;
  onRefresh: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  const { persona } = props;

  return (
    <section className="user-panel">
      <header className="panel-header">
        <div className="panel-header-text">
          <h2>{persona.name}</h2>
          {persona.description && <p>{persona.description}</p>}
          {persona.last_refreshed_at && (
            <p className="panel-meta">上次刷新 {formatDateTime(persona.last_refreshed_at)}</p>
          )}
        </div>
        <div className="panel-actions">
          <button
            className="btn btn-sm"
            onClick={props.onRefresh}
            disabled={props.refreshPending || props.deletePending}
          >
            {props.refreshPending ? '刷新中…' : '刷新成员'}
          </button>
          <button className="btn btn-sm" onClick={props.onExport}>
            导出 .xlsx
          </button>
          <button
            className="btn btn-sm btn-danger-ghost"
            onClick={props.onDelete}
            disabled={props.deletePending || props.refreshPending}
          >
            {props.deletePending ? '删除中…' : '删除'}
          </button>
        </div>
      </header>

      <div className="user-scroll">
        <UserGroup
          title="当前在簇"
          count={props.activeUsers.length}
          users={props.activeUsers}
          membership="active"
          isLoading={props.isLoading}
          selectedUserId={props.selectedUserId}
          onSelect={props.onSelect}
        />
        <UserGroup
          title="已聊 · 已移出"
          count={props.chattedLeftUsers.length}
          users={props.chattedLeftUsers}
          membership="chatted_left"
          isLoading={props.isLoading}
          selectedUserId={props.selectedUserId}
          onSelect={props.onSelect}
          muted
        />
      </div>
    </section>
  );
}

function UserGroup(props: {
  title: string;
  count: number;
  users: CsUserData[];
  membership: Membership;
  isLoading: boolean;
  selectedUserId?: string;
  muted?: boolean;
  onSelect: (user: CsUserData, membership: Membership) => void;
}) {
  return (
    <div className={`user-group ${props.muted ? 'is-muted' : ''}`}>
      <h3 className="user-group-title">
        {props.title}
        <span className="user-group-count">{props.count}</span>
      </h3>
      {props.isLoading ? (
        <p className="hint-text">加载中…</p>
      ) : props.users.length === 0 ? (
        <p className="hint-text">暂无用户</p>
      ) : (
        props.users.map((user) => (
          <button
            key={`${props.membership}-${user.user_id}`}
            className={`user-item ${props.selectedUserId === user.user_id ? 'is-active' : ''}`}
            onClick={() => props.onSelect(user, props.membership)}
          >
            <div className="user-item-top">
              <span className="user-name">{user.display_name}</span>
              <SessionBadge status={user.session_status} />
            </div>
            <div className="user-item-meta">
              <span>注册 {user.register_days} 天</span>
              <span>{user.total_round} 轮</span>
              <span>¥{user.total_paid_amount}</span>
              {user.last_active_label && <span>{user.last_active_label}</span>}
            </div>
            {user.left_note && <p className="user-item-note">{user.left_note}</p>}
          </button>
        ))
      )}
    </div>
  );
}
