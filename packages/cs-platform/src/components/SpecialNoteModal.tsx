import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { MAX_CS_SPECIAL_NOTE_CHARS, type CsPersonaData, type CsUserData } from '@miniapp/shared';
import { csApi } from '../api';
import { formatDateTime } from '../constants';

/**
 * 特殊标记备注。备注挂在「这个簇里的这个用户」上，换簇不共用，
 * 因为同一个人在不同回访目的下要记的事情本来就不一样。
 */
export function SpecialNoteModal(props: {
  persona: CsPersonaData;
  user: CsUserData;
  onClose: () => void;
  onSaved: () => void;
  onToast: (message: string) => void;
}) {
  const [note, setNote] = useState(props.user.special_note ?? '');

  const saveMutation = useMutation({
    mutationFn: (next: string) =>
      csApi.setSpecialNote(props.persona.id, props.user.user_id, { note: next }),
    onSuccess: (_data, next) => {
      props.onToast(next.trim() ? '备注已保存' : '已取消标记');
      props.onSaved();
    },
    onError: (error) => props.onToast(error instanceof Error ? error.message : '保存备注失败'),
  });

  const trimmed = note.trim();
  const tooLong = trimmed.length > MAX_CS_SPECIAL_NOTE_CHARS;

  return (
    <div
      className="modal-mask"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div className="modal modal-sm" role="dialog" aria-modal="true" aria-label="特殊标记">
        <header className="modal-header">
          <h2>特殊标记 · {props.user.display_name}</h2>
          <button className="modal-close" onClick={props.onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <div className="field">
            <label htmlFor="special-note">备注</label>
            <p className="field-hint">
              记下这个用户的问题、你承诺过的处理动作，或者需要二次回访的原因。清空即取消标记。
            </p>
            <textarea
              id="special-note"
              rows={5}
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="例如：反馈语音经常失败，已承诺修复后回访"
              autoFocus
            />
            <p className={`field-hint ${tooLong ? 'is-warning' : ''}`}>
              {trimmed.length} / {MAX_CS_SPECIAL_NOTE_CHARS}
              {props.user.special_note_updated_at
                ? ` · 上次更新 ${formatDateTime(props.user.special_note_updated_at)}`
                : ''}
            </p>
          </div>
        </div>

        <footer className="modal-footer">
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          <button
            className="btn btn-primary"
            onClick={() => saveMutation.mutate(note)}
            disabled={saveMutation.isPending || tooLong}
          >
            {saveMutation.isPending ? '保存中…' : trimmed ? '保存备注' : '取消标记'}
          </button>
        </footer>
      </div>
    </div>
  );
}
