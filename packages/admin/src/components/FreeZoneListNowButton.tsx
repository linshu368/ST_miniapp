import { useState } from 'react';
import { App as AntApp, Button, Popconfirm, Typography } from 'antd';
import { listFreeZoneModelNow } from '@miniapp/admin-client';
import type { AdminFreeZoneStatusModel } from '@miniapp/shared';
import { useAdminApi } from '../lib/adminApiContext';

/**
 * 线上状态里未上架 / 冷却中 / 业务下架的候选可以手动立即上架：跳过连续达标和冷却，
 * 供应商按当前行情和初筛门槛选。上架后照常评估，不达标照样会换供应商或下架。
 */
export function FreeZoneListNowButton(props: {
  model: AdminFreeZoneStatusModel;
  onListed: () => void;
}) {
  const api = useAdminApi();
  const { message } = AntApp.useApp();
  const [busy, setBusy] = useState(false);
  const { model } = props;
  if (!api || !model.in_config) return null;
  const name = model.display_name ?? model.candidate_id;

  const listNow = async () => {
    setBusy(true);
    try {
      const result = await listFreeZoneModelNow(api.client, api.apiUrl(), {
        candidate_id: model.candidate_id,
      });
      message.success(`已上架 ${result.display_name}，供应商 ${result.provider}`);
      props.onListed();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '上架失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popconfirm
      title={`立即上架 ${name}？`}
      description={
        <Typography.Text type="secondary" style={{ display: 'block', maxWidth: 280 }}>
          跳过连续达标和冷却，用户马上能看到。供应商按当前行情选，并先真发一次请求确认按折扣底线派得出单；
          之后照常每 30 分钟评估，不达标照样换供应商或下架。
        </Typography.Text>
      }
      okText="上架"
      cancelText="取消"
      onConfirm={() => listNow()}
    >
      <Button size="small" loading={busy}>
        立即上架
      </Button>
    </Popconfirm>
  );
}
