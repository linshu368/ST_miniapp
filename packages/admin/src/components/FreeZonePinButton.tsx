import { useState } from 'react';
import { App as AntApp, Button, Popconfirm, Typography } from 'antd';
import { pinFreeZoneModel } from '@miniapp/admin-client';
import type { AdminFreeZoneStatusModel } from '@miniapp/shared';
import { useAdminApi } from '../lib/adminApiContext';

/**
 * 「保上」：点了以后这个模型在架期间不再被自动下架（连续拒单只记日志）。
 * 没在架时点保上会顺手上架；再点一次取消保上，在架状态不变。运营手动下架也会取消保上。
 */
export function FreeZonePinButton(props: {
  model: AdminFreeZoneStatusModel;
  onChanged: () => void;
}) {
  const api = useAdminApi();
  const { message } = AntApp.useApp();
  const [busy, setBusy] = useState(false);
  const { model } = props;
  if (!api || !model.in_config) return null;
  const name = model.display_name ?? model.candidate_id;
  const next = !model.pinned;

  const toggle = async () => {
    setBusy(true);
    try {
      const result = await pinFreeZoneModel(api.client, api.apiUrl(), {
        candidate_id: model.candidate_id,
        pinned: next,
      });
      if (result.note) message.warning(`${result.display_name}：${result.note}`);
      else
        message.success(
          next ? `${result.display_name} 已保上` : `已取消 ${result.display_name} 保上`
        );
      props.onChanged();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popconfirm
      title={next ? `保上 ${name}？` : `取消保上 ${name}？`}
      description={
        <Typography.Text type="secondary" style={{ display: 'block', maxWidth: 300 }}>
          {next
            ? '保上后在架期间不再自动下架：连续被拒单也不动，这些轮次由兜底交付。没在架会马上上架。要下架只能手动下架（同时取消保上）。'
            : '取消后恢复连续拒单自动下架，在架状态不变。'}
        </Typography.Text>
      }
      okText={next ? '保上' : '取消保上'}
      cancelText="取消"
      onConfirm={() => toggle()}
    >
      <Button size="small" type={model.pinned ? 'primary' : 'default'} loading={busy}>
        {model.pinned ? '取消保上' : '保上'}
      </Button>
    </Popconfirm>
  );
}
