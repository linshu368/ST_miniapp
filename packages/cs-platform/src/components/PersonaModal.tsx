import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { CsPersonaData } from '@miniapp/shared';
import { csApi } from '../api';
import { DEFAULT_SOP, DEFAULT_SQL } from '../constants';

export function PersonaModal(props: {
  onClose: () => void;
  onCreated: (persona: CsPersonaData) => void;
  onToast: (message: string) => void;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [openingScript, setOpeningScript] = useState('');
  const [sql, setSql] = useState(DEFAULT_SQL);

  const createMutation = useMutation({
    mutationFn: () =>
      csApi.createPersona({
        name,
        description,
        opening_script: openingScript,
        sql,
        sop: DEFAULT_SOP,
      }),
    onSuccess: (data) => props.onCreated(data.persona),
    onError: (error) => props.onToast(error instanceof Error ? error.message : '创建失败'),
  });

  const canSubmit = name.trim() && sql.trim() && openingScript.trim();

  return (
    <div
      className="modal-mask"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="新建画像簇">
        <header className="modal-header">
          <h2>新建画像簇</h2>
          <button className="modal-close" onClick={props.onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <div className="field-row">
            <div className="field">
              <label htmlFor="persona-name">画像名称 *</label>
              <input
                id="persona-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="例如：深度用户"
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="persona-desc">描述</label>
              <input
                id="persona-desc"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="一句话说明这批用户是谁"
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="persona-opening">开场话术 *</label>
            <textarea
              id="persona-opening"
              rows={3}
              value={openingScript}
              onChange={(event) => setOpeningScript(event.target.value)}
              placeholder="第一次触达用户时发送的消息"
            />
          </div>

          <div className="field">
            <label htmlFor="persona-sql">SQL 规则 *</label>
            <p className="field-hint">
              必须 SELECT user_id（miniapp.users.id UUID），且为只读单条语句。
            </p>
            <textarea
              id="persona-sql"
              className="sql-editor"
              rows={10}
              value={sql}
              onChange={(event) => setSql(event.target.value)}
              spellCheck={false}
            />
          </div>
        </div>

        <footer className="modal-footer">
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={() => createMutation.mutate()}
            disabled={createMutation.isPending || !canSubmit}
          >
            {createMutation.isPending ? '保存中…' : '保存画像簇'}
          </button>
        </footer>
      </div>
    </div>
  );
}
