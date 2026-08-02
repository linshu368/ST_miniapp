import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Input,
  InputNumber,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { AdminEnvironment } from '../lib/environment';
import {
  AMOUNT_PLACEHOLDER,
  DEFAULT_GRANT_AMOUNT,
  DEFAULT_GRANT_BODY,
  DEFAULT_GRANT_TITLE,
  MAX_GRANT_AMOUNT,
  MIN_GRANT_AMOUNT,
  clearGrantRequestId,
  describeGrantIssue,
  ensureGrantRequestId,
  grantRequestKey,
  grantUserCredits,
  lookupUserForCreditGrant,
  renderGrantMessage,
  type GrantUserLookup,
} from '../lib/outreachCreditsApi';

interface OutreachCreditGrantViewProps {
  client: SupabaseClient;
  environment: AdminEnvironment;
  canWrite: boolean;
}

interface GrantRecord {
  key: string;
  userId: string;
  userLabel: string;
  amount: number;
  grantedAt: string;
}

function describeUser(user: GrantUserLookup): string {
  const name = user.display_name?.trim();
  if (name) return name;
  const username = user.tg_username?.trim();
  if (username) return `@${username}`;
  return `Telegram ${user.tg_id ?? '—'}`;
}

function formatTime(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export function OutreachCreditGrantView(props: OutreachCreditGrantViewProps) {
  const [identifier, setIdentifier] = useState('');
  const [lookup, setLookup] = useState<GrantUserLookup | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookingUp, setLookingUp] = useState(false);

  const [amount, setAmount] = useState<number | null>(DEFAULT_GRANT_AMOUNT);
  const [title, setTitle] = useState(DEFAULT_GRANT_TITLE);
  const [body, setBody] = useState(DEFAULT_GRANT_BODY);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [granting, setGranting] = useState(false);
  const [duplicateWarning, setDuplicateWarning] = useState<string | null>(null);
  const [records, setRecords] = useState<GrantRecord[]>([]);

  const targetUserId = lookup?.found ? (lookup.user_id ?? null) : null;
  const preview = renderGrantMessage({ title, body, amount: amount ?? DEFAULT_GRANT_AMOUNT });
  const issue = describeGrantIssue({ userId: targetUserId, amount, title, body });
  const recentGrants = lookup?.recent_grants ?? [];

  const runLookup = async () => {
    const trimmed = identifier.trim();
    if (!trimmed) {
      setLookup(null);
      setLookupError('请输入用户 ID');
      return;
    }
    setLookingUp(true);
    try {
      const result = await lookupUserForCreditGrant(props.client, trimmed);
      if (result.found) {
        setLookup(result);
        setLookupError(null);
      } else {
        setLookup(null);
        setLookupError('未找到该用户，请检查用户 UUID 或 Telegram ID 是否正确');
      }
    } catch (error) {
      setLookup(null);
      setLookupError(error instanceof Error ? error.message : '用户查询失败');
    } finally {
      setLookingUp(false);
    }
  };

  const submitGrant = async (allowDuplicate: boolean) => {
    if (!lookup || !targetUserId || amount === null) return;
    const storageKey = grantRequestKey({
      environment: props.environment,
      userId: targetUserId,
      amount,
    });
    const requestId = ensureGrantRequestId(window.localStorage, storageKey, () =>
      crypto.randomUUID()
    );

    setGranting(true);
    try {
      const result = await grantUserCredits({
        client: props.client,
        userId: targetUserId,
        amount,
        title: preview.title,
        body: preview.body,
        requestId,
        allowDuplicate,
      });

      if (result.blocked) {
        setDuplicateWarning(
          `该用户在 ${result.last_granted_at ? formatTime(result.last_granted_at) : '十分钟内'} 已收到过 ${result.last_amount ?? amount} 星尘。如果这是刚才那笔发放超时后的重试，取消即可，星尘不会重复到账；确认要再发一笔请点「仍然发放」。`
        );
        return;
      }

      message.success(
        result.granted
          ? `已赠送 ${result.amount} 星尘，当前余额 ${result.total_credits}`
          : '该笔赠送此前已成功，未重复发放'
      );
      // 只有确认结果落定才作废幂等键，下一笔发放才会拿到新的 id。
      clearGrantRequestId(window.localStorage, storageKey);
      setRecords((current) => [
        {
          key: result.notification_id ?? requestId,
          userId: result.user_id,
          userLabel: describeUser(lookup),
          amount: result.amount,
          grantedAt: result.granted_at
            ? formatTime(result.granted_at)
            : formatTime(new Date().toISOString()),
        },
        ...current,
      ]);
      setConfirmOpen(false);
      setDuplicateWarning(null);
      setIdentifier('');
      setLookup(null);
      setLookupError(null);
      setAmount(DEFAULT_GRANT_AMOUNT);
    } catch (error) {
      // 保留已填内容与幂等键：无论客服是原地重试、关掉弹窗重来还是刷新页面，
      // 拿到的都是同一个 request id，服务端不会把超时的那笔再发一遍。
      message.error(
        error instanceof Error
          ? `${error.message}（如果是超时，重试不会重复发放）`
          : '赠送失败，请重试。如果是超时，重试不会重复发放'
      );
    } finally {
      setGranting(false);
    }
  };

  return (
    <Card title="回访星尘赠送">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          按用户 ID
          精准发放回访奖励。赠送成功后星尘立即到账，用户端消息中心「官方」会收到一条到账通知。
          {props.environment === 'production'
            ? '当前处于生产环境，发放的是真实星尘，请谨慎操作。'
            : null}
        </Typography.Paragraph>

        {props.canWrite ? null : (
          <Alert type="warning" showIcon message="当前账号没有该环境的写入权限，无法执行赠送。" />
        )}

        <div>
          <Typography.Text strong>用户 ID</Typography.Text>
          <Input.Search
            value={identifier}
            enterButton="查询用户"
            loading={lookingUp}
            placeholder="粘贴用户 UUID，或直接填 Telegram ID"
            style={{ marginTop: 8 }}
            onChange={(event) => {
              setIdentifier(event.target.value);
              setLookup(null);
              setLookupError(null);
            }}
            onSearch={() => void runLookup()}
          />
        </div>

        {lookupError ? <Alert type="error" showIcon message={lookupError} /> : null}

        {lookup?.found ? (
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="用户">{describeUser(lookup)}</Descriptions.Item>
            <Descriptions.Item label="Telegram ID">{lookup.tg_id ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="用户 UUID" span={2}>
              <Typography.Text copyable>{lookup.user_id}</Typography.Text>
            </Descriptions.Item>
            <Descriptions.Item label="当前星尘">{lookup.total_credits ?? 0}</Descriptions.Item>
            <Descriptions.Item label="其中赠送">{lookup.bonus_credits ?? 0}</Descriptions.Item>
            <Descriptions.Item label="最近回访发放" span={2}>
              {recentGrants.length === 0 ? (
                '暂无发放记录'
              ) : (
                <Space size={[8, 4]} wrap>
                  {recentGrants.map((grant) => (
                    <Tag key={`${grant.created_at}-${grant.amount}`}>
                      +{grant.amount} · {formatTime(grant.created_at)}
                    </Tag>
                  ))}
                </Space>
              )}
            </Descriptions.Item>
          </Descriptions>
        ) : null}

        <div>
          <Typography.Text strong>赠送数量</Typography.Text>
          <div style={{ marginTop: 8 }}>
            <InputNumber
              min={MIN_GRANT_AMOUNT}
              max={MAX_GRANT_AMOUNT}
              precision={0}
              value={amount}
              style={{ width: 200 }}
              onChange={(value) => setAmount(value)}
            />
          </div>
        </div>

        <div>
          <Typography.Text strong>推送消息</Typography.Text>
          <Typography.Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 8 }}>
            正文里的 {AMOUNT_PLACEHOLDER} 会自动替换成实际赠送数量；标题或正文留空则使用默认话术。
          </Typography.Paragraph>
          <Space direction="vertical" size="small" style={{ width: '100%' }}>
            <Input
              value={title}
              maxLength={120}
              placeholder={DEFAULT_GRANT_TITLE}
              onChange={(event) => setTitle(event.target.value)}
            />
            <Input.TextArea
              value={body}
              maxLength={4000}
              rows={3}
              placeholder={DEFAULT_GRANT_BODY}
              onChange={(event) => setBody(event.target.value)}
            />
          </Space>
        </div>

        <Card size="small" type="inner" title="用户将看到">
          <Typography.Text strong>{preview.title}</Typography.Text>
          <Typography.Paragraph style={{ marginTop: 6, marginBottom: 0, whiteSpace: 'pre-wrap' }}>
            {preview.body}
          </Typography.Paragraph>
        </Card>

        <Space>
          <Button
            type="primary"
            disabled={!props.canWrite || issue !== null}
            onClick={() => {
              setDuplicateWarning(null);
              setConfirmOpen(true);
            }}
          >
            赠送星尘
          </Button>
          {issue ? <Typography.Text type="secondary">{issue}</Typography.Text> : null}
        </Space>

        {records.length > 0 ? (
          <Table<GrantRecord>
            size="small"
            rowKey="key"
            pagination={false}
            dataSource={records}
            columns={[
              { title: '用户', dataIndex: 'userLabel' },
              { title: '用户 UUID', dataIndex: 'userId' },
              {
                title: '数量',
                dataIndex: 'amount',
                render: (value: number) => <Tag color="green">+{value}</Tag>,
              },
              { title: '时间', dataIndex: 'grantedAt' },
            ]}
          />
        ) : null}
      </Space>

      <Modal
        open={confirmOpen}
        title={props.environment === 'production' ? '生产环境：确认赠送星尘？' : '确认赠送星尘？'}
        okText={duplicateWarning ? '仍然发放' : '确认赠送'}
        cancelText="取消"
        confirmLoading={granting}
        okButtonProps={{ danger: props.environment === 'production' || duplicateWarning !== null }}
        onOk={() => void submitGrant(duplicateWarning !== null)}
        // 只关弹窗，不动幂等键：客服取消后重新发起，拿到的仍是同一个 request id。
        onCancel={() => {
          setConfirmOpen(false);
          setDuplicateWarning(null);
        }}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {duplicateWarning ? (
            <Alert type="warning" showIcon message="疑似重复发放" description={duplicateWarning} />
          ) : null}
          <Descriptions bordered size="small" column={1}>
            <Descriptions.Item label="用户">
              {lookup ? describeUser(lookup) : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="用户 UUID">{targetUserId ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="赠送数量">{amount ?? '—'} 星尘</Descriptions.Item>
            <Descriptions.Item label="推送标题">{preview.title}</Descriptions.Item>
            <Descriptions.Item label="推送正文">
              <span style={{ whiteSpace: 'pre-wrap' }}>{preview.body}</span>
            </Descriptions.Item>
          </Descriptions>
        </Space>
      </Modal>
    </Card>
  );
}
