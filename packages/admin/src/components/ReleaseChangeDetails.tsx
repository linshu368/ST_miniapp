import { Typography } from 'antd';
import type { ConfigRelease } from '@miniapp/admin-client';
import {
  collectValueChanges,
  formatChangeValue,
  getPreviousRelease,
  jsonPreview,
  maskConfigSecret,
  releasePreviewValue,
} from '../lib/configReleaseDiff';

export function ReleaseChangeDetails(props: {
  release: ConfigRelease;
  allReleases: ConfigRelease[];
  compact?: boolean;
}) {
  const previousRelease = getPreviousRelease(props.allReleases, props.release);
  const currentValue = maskConfigSecret(
    props.release.config_key,
    releasePreviewValue(props.release)
  );
  if (!previousRelease) {
    return (
      <div className="release-change-details">
        <Typography.Text strong>首次发布的完整配置</Typography.Text>
        {!props.compact ? <pre className="diff-preview">{jsonPreview(currentValue)}</pre> : null}
      </div>
    );
  }

  const changes = collectValueChanges(
    maskConfigSecret(previousRelease.config_key, releasePreviewValue(previousRelease)),
    currentValue
  );
  const visibleChanges = props.compact ? changes.slice(0, 3) : changes;

  return (
    <div className="release-change-details">
      <Typography.Text strong>具体修改（{changes.length} 项）</Typography.Text>
      {changes.length === 0 ? (
        <Typography.Text type="secondary">配置内容未变化</Typography.Text>
      ) : (
        <div className="release-change-list">
          {visibleChanges.map((change, index) => (
            <div className="release-change-item" key={`${change.path}-${index}`}>
              <code>{change.path}</code>
              <span className="release-change-before">{formatChangeValue(change.before)}</span>
              <span aria-hidden>→</span>
              <span className="release-change-after">{formatChangeValue(change.after)}</span>
            </div>
          ))}
          {props.compact && changes.length > visibleChanges.length ? (
            <Typography.Text type="secondary">
              另有 {changes.length - visibleChanges.length} 项修改，请在“发布历史”中展开查看。
            </Typography.Text>
          ) : null}
        </div>
      )}
    </div>
  );
}
