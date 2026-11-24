import { useState } from 'react';
import { App as AntApp, Button, Input, Popconfirm, Space, Typography } from 'antd';
import { listFreeZoneModelNow } from '@miniapp/admin-client';
import type { AdminFreeZoneStatusModel } from '@miniapp/shared';
import { useAdminApi } from '../lib/adminApiContext';

/**
 * 未上架的候选手动上架：固定一家供应商，之后不自动变。留空就按当前报价选达到折扣底线、折扣最高的一家。
 */
export function FreeZoneListNowButton(props: {
  model: AdminFreeZoneStatusModel;
  onListed: () => void;
}) {
  const api = useAdminApi();
  const { message } = AntApp.useApp();
  const [busy, setBusy] = useState(false);
  const [provider, setProvider] = useState('');
  const { model } = props;
  if (!api || !model.in_config) return null;
  const name = model.display_name ?? model.candidate_id;

  const listNow = async () => {
    setBusy(true);
    try {
      const result = await listFreeZoneModelNow(api.client, api.apiUrl(), {
        candidate_id: model.candidate_id,
        provider: provider.trim().toLowerCase() || undefined,
      });
      message.success(`已上架 ${result.display_name}，供应商 ${result.provider}`);
      setProvider('');
      props.onListed();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '上架失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Popconfirm
      title={`上架 ${name}？`}
      description={
        <Space orientation="vertical" size={6} style={{ maxWidth: 280 }}>
          <Typography.Text type="secondary">
            用户马上能看到。供应商固定一家，之后不自动变；连续被拒单会自动下架。
          </Typography.Text>
          <Input
            size="small"
            value={provider}
            placeholder="供应商，留空自动选折扣最高的"
            onChange={(event) => setProvider(event.target.value)}
          />
        </Space>
      }
      okText="上架"
      cancelText="取消"
      onConfirm={() => listNow()}
    >
      <Button size="small" loading={busy}>
        上架
      </Button>
    </Popconfirm>
  );
}
