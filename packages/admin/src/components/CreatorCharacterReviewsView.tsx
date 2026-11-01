import { useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Image,
  Input,
  Modal,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import type {
  CreatorCharacter,
  CreatorCharacterSummary,
  CreatorReviewStatus,
} from '@miniapp/shared';
import { composeCharacterSystemPrompt, CREATOR_PRESET_CATALOG } from '@miniapp/shared';
import type { AdminEnvironment } from '../lib/environment';
import { createCreatorCharactersApi } from '../lib/creatorCharactersApi';

const labels: Record<CreatorReviewStatus, string> = {
  pending: '待审核',
  approved: '已通过',
  rejected: '未通过',
  not_submitted: '未提交',
};
export function CreatorCharacterReviewsView(props: {
  client: SupabaseClient;
  environment: AdminEnvironment;
  canWrite: boolean;
}) {
  const api = useMemo(
    () => createCreatorCharactersApi(props.client, props.environment),
    [props.client, props.environment]
  );
  const [status, setStatus] = useState<CreatorReviewStatus>('pending');
  const [rows, setRows] = useState<CreatorCharacterSummary[]>([]);
  const [selected, setSelected] = useState<CreatorCharacter | null>(null);
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void api
      .list(status)
      .then((result) => {
        if (active) setRows(result.characters);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : '读取失败');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api, status, refresh]);
  async function open(id: string) {
    setReading(true);
    setError(null);
    setReason('');
    try {
      setSelected((await api.get(id)).character);
    } catch (err) {
      setError(err instanceof Error ? err.message : '读取失败');
    } finally {
      setReading(false);
    }
  }
  function review(decision: 'approve' | 'reject') {
    if (!selected?.submitted_revision || busy || !props.canWrite) return;
    const current = selected;
    Modal.confirm({
      title: decision === 'approve' ? '通过并展示到角色大厅？' : '不通过这次申请？',
      content: `${props.environment === 'production' ? '生产环境 · ' : ''}${current.name} · 提交版本 ${current.submitted_revision}`,
      okText: decision === 'approve' ? '审核通过' : '确认不通过',
      cancelText: '取消',
      onOk: async () => {
        setBusy(true);
        setError(null);
        try {
          await api.review(current.id, {
            submitted_revision: current.submitted_revision!,
            decision,
            ...(decision === 'reject' ? { reason: reason.trim() } : {}),
          });
          setSelected(null);
          setRefresh((value) => value + 1);
        } catch (err) {
          setError(err instanceof Error ? err.message : '操作未完成，请刷新确认结果后再试');
        } finally {
          setBusy(false);
        }
      },
    });
  }
  return (
    <Card
      title="创作者角色审核"
      extra={
        <Space>
          <Select
            value={status}
            onChange={setStatus}
            options={Object.entries(labels).map(([value, label]) => ({ value, label }))}
          />
          <Button disabled={loading || busy} onClick={() => setRefresh((value) => value + 1)}>
            刷新
          </Button>
        </Space>
      }
    >
      {error && <Alert showIcon type="error" message={error} style={{ marginBottom: 16 }} />}
      <Typography.Paragraph type="secondary">
        审核通过后进入大厅。角色修改后需重新提交；审核期间，已有公开版本继续使用。
      </Typography.Paragraph>
      <Table<CreatorCharacterSummary>
        rowKey="id"
        dataSource={rows}
        loading={loading || reading}
        pagination={{ pageSize: 20 }}
        scroll={{ x: 700 }}
        columns={[
          {
            title: '角色',
            dataIndex: 'name',
            render: (name: string, row) => (
              <Space>
                {row.cover_url && (
                  <Image
                    src={row.cover_url}
                    width={42}
                    height={56}
                    style={{ objectFit: 'cover', borderRadius: 6 }}
                  />
                )}
                <span>{name || '未命名角色'}</span>
              </Space>
            ),
          },
          {
            title: '状态',
            dataIndex: 'review_status',
            render: (value: CreatorReviewStatus) => (
              <Tag
                color={value === 'pending' ? 'gold' : value === 'approved' ? 'green' : undefined}
              >
                {labels[value]}
              </Tag>
            ),
          },
          {
            title: '提交版本',
            dataIndex: 'submitted_revision',
            render: (value: number | null) => value ?? '—',
          },
          {
            title: '更新时间',
            dataIndex: 'updated_at',
            render: (value: string) => new Date(value).toLocaleString('zh-CN'),
          },
          {
            title: '',
            key: 'action',
            render: (_, row) => <Button onClick={() => void open(row.id)}>查看内容</Button>,
          },
        ]}
      />
      <Drawer
        title={selected?.name || '角色详情'}
        open={Boolean(selected)}
        onClose={() => {
          if (!busy) setSelected(null);
        }}
        width={720}
        destroyOnClose
      >
        {selected ? (
          <Space direction="vertical" size={20} style={{ width: '100%' }}>
            {selected.cover_url && <Image src={selected.cover_url} width={160} />}
            <div>
              <Typography.Title level={5}>描述</Typography.Title>
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
                {selected.draft.description}
              </Typography.Paragraph>
            </div>
            <Space wrap>
              {selected.draft.tags.map((tag) => (
                <Tag key={tag}>{tag}</Tag>
              ))}
            </Space>
            <div>
              <Typography.Title level={5}>开场白</Typography.Title>
              <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
                {selected.draft.opening}
              </Typography.Paragraph>
            </div>
            <div style={{ width: '100%' }}>
              <Typography.Title level={5}>已选预设</Typography.Title>
              <Space wrap>
                {CREATOR_PRESET_CATALOG.filter((preset) =>
                  selected.draft.selectedPresetIds.includes(preset.id)
                ).map((preset) => (
                  <Tag key={preset.id}>{preset.title}</Tag>
                ))}
                {!selected.draft.selectedPresetIds.length && (
                  <Typography.Text type="secondary">未选择内置预设</Typography.Text>
                )}
              </Space>
              <Typography.Title level={5}>自写预设与背景（含导入文件）</Typography.Title>
              <pre
                style={{
                  maxHeight: 500,
                  overflow: 'auto',
                  whiteSpace: 'pre-wrap',
                  overflowWrap: 'anywhere',
                  padding: 16,
                  background: '#f6f7f9',
                  borderRadius: 8,
                }}
              >
                {composeCharacterSystemPrompt(selected.draft)}
              </pre>
            </div>
            {selected.review_message && <Alert type="warning" message={selected.review_message} />}
            {selected.review_status === 'pending' && props.canWrite && (
              <>
                <Input.TextArea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  maxLength={1000}
                  placeholder="未通过时填写原因，创作者可据此修改"
                  rows={3}
                />
                <Space>
                  <Button type="primary" loading={busy} onClick={() => review('approve')}>
                    审核通过
                  </Button>
                  <Button danger disabled={busy || !reason.trim()} onClick={() => review('reject')}>
                    不通过
                  </Button>
                </Space>
              </>
            )}
          </Space>
        ) : (
          <Spin />
        )}
      </Drawer>
    </Card>
  );
}
