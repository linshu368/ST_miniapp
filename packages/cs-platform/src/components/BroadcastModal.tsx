import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { CsBroadcastAudience, CsPersonaData } from '@miniapp/shared';
import { csApi } from '../api';
import { BROADCAST_AUDIENCE_OPTIONS, WAITING_STATE_META } from '../constants';

/**
 * 按簇 + 等待状态群发。
 *
 * 发之前必须先看到人数：这条消息一旦提交就直接打到几百个真实用户的 Telegram，
 * 发错范围没有撤回。所以选完范围先自动拉一次预览，人数没出来不给点发送。
 */
export function BroadcastModal(props: {
  persona: CsPersonaData;
  onClose: () => void;
  onSubmitted: (accepted: number) => void;
  onToast: (message: string) => void;
}) {
  const [audience, setAudience] = useState<CsBroadcastAudience>('all_waiting');
  const [content, setContent] = useState('');
  const [confirming, setConfirming] = useState(false);

  const previewMutation = useMutation({
    mutationFn: (next: CsBroadcastAudience) =>
      csApi.broadcastPreview(props.persona.id, { audience: next }),
    onError: (error) => props.onToast(error instanceof Error ? error.message : '预览人数失败'),
  });

  const sendMutation = useMutation({
    mutationFn: () => csApi.broadcast(props.persona.id, { audience, content: content.trim() }),
    onSuccess: (data) => props.onSubmitted(data.accepted),
    onError: (error) => props.onToast(error instanceof Error ? error.message : '群发提交失败'),
  });

  const { mutate: loadPreview } = previewMutation;
  useEffect(() => {
    setConfirming(false);
    loadPreview(audience);
  }, [audience, loadPreview]);

  // 预览结果必须和当前选中的范围对得上，否则切换范围的瞬间会拿旧人数去确认
  const preview =
    previewMutation.data && previewMutation.data.audience === audience
      ? previewMutation.data
      : null;
  const total = preview?.total ?? 0;
  const canSend = !!content.trim() && total > 0 && !sendMutation.isPending;

  return (
    <div
      className="modal-mask"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label="群发消息">
        <header className="modal-header">
          <h2>群发 · {props.persona.name}</h2>
          <button className="modal-close" onClick={props.onClose} aria-label="关闭">
            ✕
          </button>
        </header>

        <div className="modal-body">
          <div className="field">
            <label htmlFor="broadcast-audience">发送范围</label>
            <select
              id="broadcast-audience"
              value={audience}
              onChange={(event) => setAudience(event.target.value as CsBroadcastAudience)}
            >
              {BROADCAST_AUDIENCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="field-hint">
              {previewMutation.isPending
                ? '正在统计人数…'
                : preview
                  ? `本次将发送给 ${total} 人（已移出的用户不在范围内）`
                  : '人数统计失败，请重新选择范围'}
            </p>
          </div>

          {preview && preview.sample.length > 0 && (
            <ul className="broadcast-sample">
              {preview.sample.map((target) => (
                <li key={target.user_id}>
                  <span>{target.display_name}</span>
                  <span className="broadcast-sample-state">
                    {WAITING_STATE_META[target.waiting_state]?.label ?? '未开始'}
                  </span>
                </li>
              ))}
              {total > preview.sample.length && <li className="hint-text">…等 {total} 人</li>}
            </ul>
          )}

          <div className="field">
            <label htmlFor="broadcast-content">消息内容 *</label>
            <textarea
              id="broadcast-content"
              rows={5}
              value={content}
              onChange={(event) => {
                setContent(event.target.value);
                setConfirming(false);
              }}
              placeholder="所有选中的用户都会收到这条一模一样的消息"
            />
          </div>

          {confirming && (
            <p className="field-hint is-warning">
              确认要给 {total} 人发送吗？提交后会按顺序逐条发出，无法撤回。
            </p>
          )}
        </div>

        <footer className="modal-footer">
          <button className="btn" onClick={props.onClose}>
            取消
          </button>
          {confirming ? (
            <button
              className="btn btn-primary"
              onClick={() => sendMutation.mutate()}
              disabled={!canSend}
            >
              {sendMutation.isPending ? '提交中…' : `确认发送给 ${total} 人`}
            </button>
          ) : (
            <button
              className="btn btn-primary"
              onClick={() => setConfirming(true)}
              disabled={!canSend}
            >
              下一步
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
