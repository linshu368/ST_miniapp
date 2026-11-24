import { Alert, Button, Space, Typography } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { fetchProviderBalance } from '@miniapp/admin-client';
import { RelayProviderSchema, type LlmModelProvider, type ProviderBalance } from '@miniapp/shared';
import { useAdminApi } from '../lib/adminApiContext';

/** Environment identity owns every pending result; switching environments discards late responses. */
export function RelayProviderBalance({ provider }: { provider: LlmModelProvider }) {
  const api = useAdminApi();
  const identity = `${api?.environment}:${provider}`;
  const current = useRef(identity);
  current.current = identity;
  const [state, setState] = useState<{
    identity: string;
    loading: boolean;
    value?: ProviderBalance;
    error?: string;
  }>({ identity, loading: false });
  useEffect(() => {
    current.current = identity;
    return () => {
      if (current.current === identity) current.current = '';
    };
  }, [identity]);
  const parsed = RelayProviderSchema.safeParse(provider);
  if (!parsed.success || !api) return null;
  const visible = state.identity === identity ? state : { identity, loading: false };
  const refresh = async () => {
    setState({ identity, loading: true });
    try {
      const value = await fetchProviderBalance(api.client, api.apiUrl(), parsed.data, true);
      if (current.current === identity) setState({ identity, loading: false, value });
    } catch {
      if (current.current === identity)
        setState({ identity, loading: false, error: '账户余额暂不可用' });
    }
  };
  return (
    <Space direction="vertical">
      <Button size="small" loading={visible.loading} onClick={() => void refresh()}>
        查询账户余额
      </Button>
      {visible.error ? <Alert type="error" message={visible.error} /> : null}
      {visible.value ? (
        visible.value.status === 'ok' ? (
          <Typography.Text>
            原生额度：{visible.value.native_balance?.toLocaleString()} quota
            {visible.value.balance_cny !== null
              ? ` · ¥${visible.value.balance_cny.toFixed(4)}`
              : ''}
            {visible.value.balance_usd !== null
              ? ` · $${visible.value.balance_usd.toFixed(4)}`
              : ' · USD 未知'}
            {' · '}
            {new Date(visible.value.fetched_at).toLocaleString()}
          </Typography.Text>
        ) : (
          <Alert type="warning" message={`余额不可用：${visible.value.error_code}`} />
        )
      ) : null}
    </Space>
  );
}
