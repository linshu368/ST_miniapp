import { useState } from 'react';
import { App as AntApp, Button, Popconfirm, Typography } from 'antd';
import { delistFreeZoneModelNow } from '@miniapp/admin-client';
import type { AdminFreeZoneStatusModel } from '@miniapp/shared';
import { useAdminApi } from '../lib/adminApiContext';

/**
 * 在架模型可以手动下架：用户马上看不到，正在用它的用户下一轮自动换成别的免费模型。
 * 下架后一直停着，评估不会自动加回来；要用时点「立即上架」。
 */
export function FreeZoneDelistNowButton(props: {
  model: AdminFreeZoneStatusModel;
  onDelisted: () => void;
}) {
  const api = useAdminApi();
  const { message } = AntApp.useApp();
  const [busy, setBusy] = useState(false);
  const { model } = props;
  if (!api) return null;
  const name = model.display_name ?? model.candidate_id;

  const delistNow = async () => {
    setBusy(true);
    try {
      const result = await delistFreeZoneModelNow(api.client, api.apiUrl(), {
        candidate_id: model.candidate_id,
      });
      message.success(`已下架 ${result.display_name}`);
      props.onDelisted();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '下架失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popconfirm
      title={`下架 ${name}？`}
      description={
        <Typography.Text type="secondary" style={{ display: 'block', maxWidth: 280 }}>
          用户马上看不到；正在用它的用户下一轮自动换成别的免费模型。下架后不会自动回来，要用时点「立即上架」。
        </Typography.Text>
      }
      okText="下架"
      okButtonProps={{ danger: true }}
      cancelText="取消"
      onConfirm={() => delistNow()}
    >
      <Button size="small" danger loading={busy}>
        下架
      </Button>
    </Popconfirm>
  );
}
