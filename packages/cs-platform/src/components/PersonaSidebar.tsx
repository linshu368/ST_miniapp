import type { CsPersonaData } from '@miniapp/shared';
import { getCsOperatorId } from '../api';

export function PersonaSidebar(props: {
  personas: CsPersonaData[];
  selectedId: string | null;
  isLoading: boolean;
  errorMessage: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onLogout: () => void;
}) {
  return (
    <aside className="sidebar">
      <header className="sidebar-brand">
        <span className="sidebar-logo" aria-hidden="true">
          蜜
        </span>
        <span className="sidebar-title">蜜镜AI运营平台</span>
      </header>

      <div className="sidebar-section-head persona-section-head">
        <h2>画像簇</h2>
        <button className="btn btn-sm" onClick={props.onCreate}>
          + 新建
        </button>
      </div>

      <nav className="persona-list">
        {props.isLoading && <p className="hint-text">加载中…</p>}
        {props.errorMessage && <p className="error-text">{props.errorMessage}</p>}
        {!props.isLoading && !props.errorMessage && props.personas.length === 0 && (
          <p className="hint-text">暂无画像簇，点击「新建」创建第一个。</p>
        )}
        {props.personas.map((persona) => (
          <button
            key={persona.id}
            className={`persona-item ${props.selectedId === persona.id ? 'is-active' : ''}`}
            onClick={() => props.onSelect(persona.id)}
          >
            <span className="persona-dot" style={{ background: persona.color }} />
            <span className="persona-text">
              <span className="persona-name">{persona.name}</span>
              {persona.description && <span className="persona-desc">{persona.description}</span>}
            </span>
            <span className="persona-count">{persona.active_count}</span>
          </button>
        ))}
      </nav>

      <footer className="sidebar-footer">
        <div className="operator-info">
          <span className="operator-avatar" aria-hidden="true">
            {getCsOperatorId().slice(0, 2).toUpperCase()}
          </span>
          <div className="operator-text">
            <span className="operator-name">{getCsOperatorId()}</span>
            <span className="operator-role">运营成员</span>
          </div>
        </div>
        <button className="btn btn-sm btn-ghost" onClick={props.onLogout}>
          退出
        </button>
      </footer>
    </aside>
  );
}
