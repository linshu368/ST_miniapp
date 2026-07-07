import type { CsPersonaData } from '@miniapp/shared';
import { getCsOperatorId } from '../api';

export type AppModule = 'outreach' | 'growth';

export function PersonaSidebar(props: {
  module: AppModule;
  personas: CsPersonaData[];
  selectedId: string | null;
  isLoading: boolean;
  errorMessage: string | null;
  onModuleChange: (module: AppModule) => void;
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

      <div className="sidebar-section-head">
        <h2>功能</h2>
      </div>
      <nav className="module-list" aria-label="运营平台功能">
        <button
          className={`module-item ${props.module === 'outreach' ? 'is-active' : ''}`}
          onClick={() => props.onModuleChange('outreach')}
        >
          <span>用户回访</span>
          <small>画像簇 · Telegram 1V1</small>
        </button>
        <button
          className={`module-item ${props.module === 'growth' ? 'is-active' : ''}`}
          onClick={() => props.onModuleChange('growth')}
        >
          <span>渠道链接</span>
          <small>MiniApp startapp 归因</small>
        </button>
      </nav>

      {props.module === 'outreach' && (
        <>
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
                  {persona.description && (
                    <span className="persona-desc">{persona.description}</span>
                  )}
                </span>
                <span className="persona-count">{persona.active_count}</span>
              </button>
            ))}
          </nav>
        </>
      )}

      {props.module === 'growth' && (
        <div className="sidebar-help">
          <strong>渠道归因说明</strong>
          <p>直达链接用于投放；统计链接会先记录点击再跳转 Telegram MiniApp。</p>
          <p>激活用户按 miniapp.users.total_round &gt; 0 计算。</p>
        </div>
      )}

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
