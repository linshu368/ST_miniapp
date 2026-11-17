import { Button, Card, Space, Tag, Typography } from 'antd';
import {
  publishedAvailability,
  summarizeVersionChange,
  type EnvSession,
} from '../../lib/textPostprocessWorkbench';

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export function HistoryColumn(props: {
  session: EnvSession;
  currentVersion: number | null;
  allowWrite: boolean;
  onRollback: (version: number) => void;
  onLoadMore: () => void;
}) {
  const availability = publishedAvailability(props.session.server);
  return (
    <Card title="发布历史">
      <Space direction="vertical" className="field-full">
        {availability.status === 'available' ? (
          <Typography.Text>
            当前正式版本 {availability.version}，发布时间 {formatDate(availability.publishedAt)}。
          </Typography.Text>
        ) : null}
        {availability.status === 'none' ? (
          <Typography.Text>这个环境还没有正式版本。</Typography.Text>
        ) : null}
        {props.session.server?.draft ? (
          <Typography.Text type="secondary">
            已保存草稿更新于 {formatDate(props.session.server.draft.updated_at)}，基线版本{' '}
            {props.session.server.draft.base_version}。
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">没有已保存草稿。</Typography.Text>
        )}
        {props.session.history.map((item, index) => {
          const previous = props.session.history[index + 1] ?? null;
          const current = item.version === props.currentVersion;
          return (
            <div key={item.version} className="text-postprocess-release">
              <Space wrap>
                <strong>版本 {item.version}</strong>
                {current ? <Tag color="green">当前正式版本</Tag> : null}
                <Typography.Text type="secondary">{formatDate(item.published_at)}</Typography.Text>
              </Space>
              <Typography.Paragraph>{summarizeVersionChange(item, previous)}</Typography.Paragraph>
              <Button
                disabled={!props.allowWrite || props.session.server?.runtime_version === null}
                onClick={() => props.onRollback(item.version)}
              >
                基于版本 {item.version} 创建新发布
              </Button>
            </div>
          );
        })}
        {props.session.hasMore ? <Button onClick={props.onLoadMore}>加载更早版本</Button> : null}
        {!props.session.hasMore && props.session.history.length > 0 ? (
          <Typography.Text type="secondary">这一页之后没有更早的版本。</Typography.Text>
        ) : null}
      </Space>
    </Card>
  );
}
