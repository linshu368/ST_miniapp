import { useCallback, useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Alert,
  Button,
  Card,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { AdminEnvironment } from '../lib/environment';
import {
  createAnnouncement,
  deleteAnnouncement,
  listAnnouncements,
  setAnnouncementPublished,
  updateAnnouncement,
  type Announcement,
  type AnnouncementCategory,
} from '../lib/announcementsApi';

interface AnnouncementsViewProps {
  client: SupabaseClient;
  environment: AdminEnvironment;
  canWrite: boolean;
}

// MiniApp 消息中心「官方」分页只展示这两类；system / interaction 属于系统下发，不在这里创建。
const CATEGORY_OPTIONS: Array<{ value: AnnouncementCategory; label: string }> = [
  { value: 'announcement', label: '官方公告' },
  { value: 'activity', label: '活动' },
];

const CATEGORY_LABELS: Record<AnnouncementCategory, string> = {
  announcement: '官方公告',
  activity: '活动',
  system: '系统',
  interaction: '互动',
};

interface EditorState {
  open: boolean;
  id: string | null;
  category: AnnouncementCategory;
  title: string;
  body: string;
  sortOrder: number;
  isPublished: boolean;
}

const EMPTY_EDITOR: EditorState = {
  open: false,
  id: null,
  category: 'announcement',
  title: '',
  body: '',
  sortOrder: 0,
  isPublished: false,
};

function formatDate(value: string | null): string {
  if (!value) return '—';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export function AnnouncementsView(props: AnnouncementsViewProps) {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState>(EMPTY_EDITOR);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setAnnouncements(await listAnnouncements(props.client));
      setError(null);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '公告列表加载失败');
    } finally {
      setLoading(false);
    }
  }, [props.client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const runMutation = async (action: () => Promise<unknown>, successText: string) => {
    setMutating(true);
    try {
      await action();
      message.success(successText);
      await reload();
      return true;
    } catch (mutationError) {
      message.error(mutationError instanceof Error ? mutationError.message : '操作失败');
      return false;
    } finally {
      setMutating(false);
    }
  };

  const submitEditor = async () => {
    const title = editor.title.trim();
    const body = editor.body.trim();
    if (!title || !body) {
      message.error('标题和正文都不能为空');
      return;
    }

    const succeeded = await runMutation(
      () =>
        editor.id
          ? updateAnnouncement({
              client: props.client,
              id: editor.id,
              category: editor.category,
              title,
              body,
              sortOrder: editor.sortOrder,
            })
          : createAnnouncement({
              client: props.client,
              category: editor.category,
              title,
              body,
              sortOrder: editor.sortOrder,
              isPublished: editor.isPublished,
            }),
      editor.id ? '公告已更新' : '公告已创建'
    );
    if (succeeded) setEditor(EMPTY_EDITOR);
  };

  return (
    <Card
      title="公告管理"
      extra={
        <Space>
          <Button onClick={() => void reload()} disabled={loading || mutating}>
            刷新
          </Button>
          <Button
            type="primary"
            disabled={!props.canWrite || mutating}
            onClick={() => setEditor({ ...EMPTY_EDITOR, open: true })}
          >
            新建公告
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          发布后的公告会出现在 MiniApp「消息中心 → 官方」分页，并触发用户端未读红点。
          {props.environment === 'production' ? '当前处于生产环境，请谨慎发布。' : null}
        </Typography.Paragraph>

        {error ? <Alert type="error" showIcon message={error} /> : null}

        {loading ? (
          <Spin />
        ) : announcements.length === 0 ? (
          <Empty description="还没有公告" />
        ) : (
          <Table<Announcement>
            rowKey="id"
            dataSource={announcements}
            pagination={false}
            size="small"
            columns={[
              {
                title: '状态',
                dataIndex: 'is_published',
                width: 90,
                render: (isPublished: boolean) =>
                  isPublished ? <Tag color="green">已发布</Tag> : <Tag>草稿</Tag>,
              },
              {
                title: '类型',
                dataIndex: 'category',
                width: 100,
                render: (category: AnnouncementCategory) => CATEGORY_LABELS[category],
              },
              { title: '标题', dataIndex: 'title' },
              { title: '排序', dataIndex: 'sort_order', width: 70 },
              {
                title: '发布时间',
                dataIndex: 'published_at',
                width: 180,
                render: (value: string | null) => formatDate(value),
              },
              {
                title: '操作',
                width: 240,
                render: (_value, record) => (
                  <Space size="small">
                    <Button
                      size="small"
                      disabled={!props.canWrite || mutating}
                      onClick={() =>
                        setEditor({
                          open: true,
                          id: record.id,
                          category: record.category,
                          title: record.title,
                          body: record.body,
                          sortOrder: record.sort_order,
                          isPublished: record.is_published,
                        })
                      }
                    >
                      编辑
                    </Button>
                    <Button
                      size="small"
                      disabled={!props.canWrite || mutating}
                      onClick={() =>
                        void runMutation(
                          () =>
                            setAnnouncementPublished(props.client, record.id, !record.is_published),
                          record.is_published ? '公告已下架' : '公告已发布'
                        )
                      }
                    >
                      {record.is_published ? '下架' : '发布'}
                    </Button>
                    <Popconfirm
                      title="删除该公告？"
                      description="删除后用户端立即不可见。"
                      okText="删除"
                      cancelText="取消"
                      okButtonProps={{ danger: true }}
                      disabled={!props.canWrite || mutating}
                      onConfirm={() =>
                        void runMutation(
                          () => deleteAnnouncement(props.client, record.id),
                          '公告已删除'
                        )
                      }
                    >
                      <Button size="small" danger disabled={!props.canWrite || mutating}>
                        删除
                      </Button>
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Space>

      <Modal
        open={editor.open}
        title={editor.id ? '编辑公告' : '新建公告'}
        okText="保存"
        cancelText="取消"
        confirmLoading={mutating}
        onOk={() => void submitEditor()}
        onCancel={() => setEditor(EMPTY_EDITOR)}
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Select<AnnouncementCategory>
            value={editor.category}
            options={CATEGORY_OPTIONS}
            style={{ width: '100%' }}
            onChange={(category) => setEditor((current) => ({ ...current, category }))}
          />
          <Input
            value={editor.title}
            maxLength={120}
            placeholder="公告标题"
            onChange={(event) =>
              setEditor((current) => ({ ...current, title: event.target.value }))
            }
          />
          <Input.TextArea
            value={editor.body}
            maxLength={4000}
            rows={6}
            placeholder="公告正文"
            onChange={(event) => setEditor((current) => ({ ...current, body: event.target.value }))}
          />
          <Space>
            <span>排序</span>
            <InputNumber
              min={0}
              value={editor.sortOrder}
              onChange={(value) => setEditor((current) => ({ ...current, sortOrder: value ?? 0 }))}
            />
            {editor.id ? null : (
              <>
                <span>立即发布</span>
                <Switch
                  checked={editor.isPublished}
                  onChange={(isPublished) => setEditor((current) => ({ ...current, isPublished }))}
                />
              </>
            )}
          </Space>
        </Space>
      </Modal>
    </Card>
  );
}
