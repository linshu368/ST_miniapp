import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Alert,
  Avatar,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Modal,
  Popconfirm,
  Segmented,
  Skeleton,
  Space,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  discardCharacterLayoutDraft,
  getCharacterLayout,
  listCharacterLayoutReleases,
  publishCharacterLayoutDraft,
  rollbackCharacterLayoutRelease,
  saveCharacterLayoutDraft,
  type CharacterCard,
  type CharacterLayoutRelease,
  type CharacterLayoutSnapshot,
  type CharacterLayoutValue,
} from '../lib/adminApi';
import { getAdminSupabaseUrl, type AdminEnvironment } from '../lib/environment';
import {
  charactersForIds,
  getCharacterAvatarUrl,
  layoutsEqual,
  moveCharacterId,
  normalizeCharacterTags,
} from '../lib/characterCards';

interface CharacterCardsViewProps {
  client: SupabaseClient;
  characters: CharacterCard[];
  environment: AdminEnvironment;
  loading: boolean;
  error: string | null;
  canWrite: boolean;
  onRefresh: () => Promise<void> | void;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function confirmAction(title: string, content: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title,
      content,
      okText: '确认',
      cancelText: '取消',
      okButtonProps: danger ? { danger: true } : undefined,
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

export function CharacterCardsView(props: CharacterCardsViewProps) {
  const [snapshot, setSnapshot] = useState<CharacterLayoutSnapshot | null>(null);
  const [working, setWorking] = useState<CharacterLayoutValue | null>(null);
  const [selected, setSelected] = useState<CharacterCard | null>(null);
  const [tab, setTab] = useState<'listed' | 'delisted' | 'deleted'>('listed');
  const [preview, setPreview] = useState<'draft' | 'published'>('draft');
  const [releases, setReleases] = useState<CharacterLayoutRelease[]>([]);
  const [saving, setSaving] = useState(false);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const supabaseUrl = getAdminSupabaseUrl(props.environment);

  const reloadLayout = useCallback(async () => {
    setLayoutError(null);
    try {
      const [next, nextReleases] = await Promise.all([
        getCharacterLayout(props.client),
        listCharacterLayoutReleases(props.client),
      ]);
      setSnapshot(next);
      setWorking(next.draft ?? next.published);
      setReleases(nextReleases);
    } catch (error) {
      setLayoutError(error instanceof Error ? error.message : '角色布局加载失败');
    }
  }, [props.client]);

  useEffect(() => {
    void reloadLayout();
  }, [reloadLayout]);

  const listed = useMemo(
    () => charactersForIds(props.characters, working?.listed_ids ?? []),
    [props.characters, working]
  );
  const delisted = useMemo(
    () => charactersForIds(props.characters, working?.delisted_ids ?? []),
    [props.characters, working]
  );
  const deleted = useMemo(
    () => charactersForIds(props.characters, working?.deleted_ids ?? []),
    [props.characters, working]
  );
  const publishedListed = useMemo(
    () => charactersForIds(props.characters, snapshot?.published.listed_ids ?? []),
    [props.characters, snapshot]
  );
  const previewCharacters = preview === 'draft' ? listed : publishedListed;
  const hydrated = snapshot?.draft ?? snapshot?.published;
  const dirty = Boolean(working && hydrated && !layoutsEqual(working, hydrated));

  const move = (id: string, direction: 'up' | 'down', shiftKey: boolean) => {
    if (!working) return;
    setWorking({
      ...working,
      listed_ids: moveCharacterId(working.listed_ids, id, direction, shiftKey),
    });
  };

  const moveState = (
    id: string,
    from: keyof CharacterLayoutValue,
    to: keyof CharacterLayoutValue
  ) => {
    if (!working) return;
    setWorking({
      ...working,
      [from]: working[from].filter((candidate) => candidate !== id),
      [to]: [...working[to], id],
    });
  };

  const saveDraft = async () => {
    if (!working || !snapshot || !props.canWrite) return;
    setSaving(true);
    try {
      await saveCharacterLayoutDraft(
        props.client,
        working,
        snapshot.draft?.base_layout_version ?? snapshot.layout_version
      );
      message.success('角色布局草稿已保存，MiniApp 尚未改变');
      await reloadLayout();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '草稿保存失败');
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (!snapshot?.draft || dirty || !props.canWrite) return;
    const confirmed = await confirmAction(
      `${props.environment === 'production' ? '生产环境：' : ''}发布角色布局？`,
      '发布后排序、上下架、删除和恢复状态将同步到 MiniApp。',
      props.environment === 'production'
    );
    if (!confirmed) return;
    setSaving(true);
    try {
      const version = await publishCharacterLayoutDraft(props.client, snapshot.draft.id);
      message.success(`角色布局版本 ${version} 已发布`);
      await Promise.all([props.onRefresh(), reloadLayout()]);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '角色布局发布失败');
    } finally {
      setSaving(false);
    }
  };

  const discard = async () => {
    if (!snapshot?.draft || !props.canWrite) return;
    if (!(await confirmAction('放弃角色布局草稿？', '所有未发布的角色状态和排序将丢失。', true))) {
      return;
    }
    setSaving(true);
    try {
      await discardCharacterLayoutDraft(props.client, snapshot.draft.id);
      message.success('角色布局草稿已放弃');
      await reloadLayout();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '草稿放弃失败');
    } finally {
      setSaving(false);
    }
  };

  const rollback = async (release: CharacterLayoutRelease) => {
    if (!snapshot || snapshot.draft || dirty || !props.canWrite) return;
    const confirmed = await confirmAction(
      `${props.environment === 'production' ? '生产环境：' : ''}回滚到布局版本 ${release.layout_version}？`,
      `将恢复该版本的上架 ${release.listed_count}、下架 ${release.delisted_count}、已删除 ${release.deleted_count} 个角色，并生成新的发布版本。`,
      true
    );
    if (!confirmed) return;
    setSaving(true);
    try {
      const version = await rollbackCharacterLayoutRelease(
        props.client,
        release.id,
        snapshot.layout_version
      );
      message.success(`已回滚并发布为角色布局版本 ${version}`);
      await Promise.all([props.onRefresh(), reloadLayout()]);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '角色布局回滚失败');
    } finally {
      setSaving(false);
    }
  };

  const renderRow = (
    character: CharacterCard,
    status: 'listed' | 'delisted' | 'deleted',
    index: number
  ) => (
    <div className="character-management-row" key={character.id}>
      <Avatar size={54} src={getCharacterAvatarUrl(character, supabaseUrl)}>
        {character.name.slice(0, 1)}
      </Avatar>
      <div className="character-management-copy" onClick={() => setSelected(character)}>
        <strong>{character.name}</strong>
        <span>
          {status === 'listed'
            ? `草稿位置 ${index + 1}`
            : status === 'deleted'
              ? '发布后进入已删除区域'
              : '发布后保持下架'}
        </span>
      </div>
      <Space wrap>
        {status === 'listed' ? (
          <>
            <Button
              size="small"
              disabled={!props.canWrite || saving || index === 0}
              onClick={() => move(character.id, 'up', true)}
            >
              置顶
            </Button>
            <Button
              size="small"
              disabled={!props.canWrite || saving || index === 0}
              onClick={() => move(character.id, 'up', false)}
            >
              上移
            </Button>
            <Button
              size="small"
              disabled={!props.canWrite || saving || index === listed.length - 1}
              onClick={() => move(character.id, 'down', false)}
            >
              下移
            </Button>
            <Button
              size="small"
              disabled={!props.canWrite || saving || index === listed.length - 1}
              onClick={() => move(character.id, 'down', true)}
            >
              置底
            </Button>
            <Button
              size="small"
              disabled={!props.canWrite || saving}
              onClick={() => moveState(character.id, 'listed_ids', 'delisted_ids')}
            >
              下架
            </Button>
          </>
        ) : status === 'delisted' ? (
          <Button
            size="small"
            disabled={!props.canWrite || saving}
            onClick={() => moveState(character.id, 'delisted_ids', 'listed_ids')}
          >
            重新上架
          </Button>
        ) : (
          <Popconfirm
            title="恢复此角色？"
            description="角色将恢复到已下架区域，发布前不会影响 MiniApp。"
            okText="恢复"
            cancelText="取消"
            onConfirm={() => moveState(character.id, 'deleted_ids', 'delisted_ids')}
          >
            <Button size="small" disabled={!props.canWrite || saving}>
              恢复
            </Button>
          </Popconfirm>
        )}
        {status !== 'deleted' ? (
          <Popconfirm
            title="移入已删除区域？"
            description="保存草稿后仍不会影响 MiniApp，发布后才正式隐藏。"
            okText="确认"
            cancelText="取消"
            onConfirm={() =>
              moveState(
                character.id,
                status === 'listed' ? 'listed_ids' : 'delisted_ids',
                'deleted_ids'
              )
            }
          >
            <Button size="small" danger disabled={!props.canWrite || saving}>
              删除
            </Button>
          </Popconfirm>
        ) : null}
      </Space>
    </div>
  );

  const emptyOrLoading =
    props.error || layoutError || (props.loading && props.characters.length === 0) || !working;

  return (
    <>
      <Card
        title="角色卡展示管理"
        extra={
          <Space wrap>
            <Tag color="green">草稿上架 {listed.length}</Tag>
            <Tag>下架 {delisted.length}</Tag>
            <Tag color="red">已删除 {deleted.length}</Tag>
            {dirty ? <Tag color="orange">有未保存修改</Tag> : null}
            {snapshot?.draft ? <Tag color="blue">有未发布草稿</Tag> : <Tag>已同步</Tag>}
            <Button
              loading={props.loading}
              onClick={() => void Promise.all([props.onRefresh(), reloadLayout()])}
            >
              刷新
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          使用置顶、上移、下移、置底按钮调整顺序。所有状态变更仅在发布后同步到 MiniApp。
        </Typography.Paragraph>
        {!props.canWrite ? (
          <Alert type="info" showIcon message="当前账号只能查看角色布局。" />
        ) : null}
        {layoutError || props.error ? (
          <Alert
            type="error"
            showIcon
            message={layoutError ?? props.error}
            className="form-alert"
          />
        ) : null}
        <Space wrap className="character-draft-actions">
          <Button
            type="primary"
            loading={saving}
            disabled={!props.canWrite || !dirty}
            onClick={() => void saveDraft()}
          >
            保存草稿
          </Button>
          <Button
            danger={props.environment === 'production'}
            loading={saving}
            disabled={!props.canWrite || !snapshot?.draft || dirty}
            onClick={() => void publish()}
          >
            发布
          </Button>
          <Button
            danger
            disabled={!props.canWrite || !snapshot?.draft || saving}
            onClick={() => void discard()}
          >
            放弃草稿
          </Button>
        </Space>
        <Card size="small" title="发布历史与回滚" className="character-release-history">
          {releases.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无角色布局发布历史" />
          ) : (
            <Space direction="vertical" className="field-full" size="small">
              {releases.map((release) => (
                <div className="character-release-row" key={release.id}>
                  <div>
                    <strong>版本 {release.layout_version}</strong>
                    <span>
                      上架 {release.listed_count} · 下架 {release.delisted_count} · 已删除{' '}
                      {release.deleted_count}
                    </span>
                    <span>
                      {release.released_by_name || release.released_by_email || '未知操作人'} ·{' '}
                      {formatDate(release.released_at)}
                    </span>
                  </div>
                  <Button
                    size="small"
                    danger
                    disabled={
                      !props.canWrite ||
                      saving ||
                      dirty ||
                      Boolean(snapshot?.draft) ||
                      release.layout_version === snapshot?.layout_version
                    }
                    onClick={() => void rollback(release)}
                  >
                    回滚到此版本
                  </Button>
                </div>
              ))}
            </Space>
          )}
        </Card>
        {emptyOrLoading ? (
          props.loading ? (
            <Skeleton active paragraph={{ rows: 8 }} />
          ) : (
            <Empty description="暂无角色布局" />
          )
        ) : (
          <div className="character-management-layout">
            <div className="character-management-panel">
              <Tabs
                activeKey={tab}
                onChange={(key) => setTab(key as typeof tab)}
                items={[
                  {
                    key: 'listed',
                    label: `已上架（${listed.length}）`,
                    children: listed.length ? (
                      <Space direction="vertical" className="field-full" size="small">
                        {listed.map((character, index) => renderRow(character, 'listed', index))}
                      </Space>
                    ) : (
                      <Empty description="暂无上架角色" />
                    ),
                  },
                  {
                    key: 'delisted',
                    label: `已下架（${delisted.length}）`,
                    children: delisted.length ? (
                      <Space direction="vertical" className="field-full" size="small">
                        {delisted.map((character, index) =>
                          renderRow(character, 'delisted', index)
                        )}
                      </Space>
                    ) : (
                      <Empty description="暂无下架角色" />
                    ),
                  },
                  {
                    key: 'deleted',
                    label: `已删除（${deleted.length}）`,
                    children: deleted.length ? (
                      <Space direction="vertical" className="field-full" size="small">
                        {deleted.map((character, index) => renderRow(character, 'deleted', index))}
                      </Space>
                    ) : (
                      <Empty description="暂无已删除角色" />
                    ),
                  },
                ]}
              />
            </div>
            <div className="character-preview-column">
              <Segmented
                block
                value={preview}
                options={[
                  { label: '草稿预览', value: 'draft' },
                  { label: '已发布预览', value: 'published' },
                ]}
                onChange={(value) => setPreview(value as typeof preview)}
              />
              <div className="character-lobby-phone">
                <div className="character-lobby-screen">
                  <Typography.Title level={4}>探索角色</Typography.Title>
                  <div className="character-lobby-grid">
                    {previewCharacters.map((character, index) => (
                      <button
                        type="button"
                        key={character.id}
                        className={index < 8 ? 'is-golden' : ''}
                      >
                        <img
                          src={getCharacterAvatarUrl(character, supabaseUrl)}
                          alt={character.name}
                        />
                        {index < 8 ? <i>流金 {index + 1}</i> : null}
                        <strong>{character.name}</strong>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </Card>
      <Drawer
        width={640}
        title={selected?.name ?? '角色详情'}
        open={selected !== null}
        onClose={() => setSelected(null)}
      >
        {selected ? (
          <Space direction="vertical" size="large" className="field-full">
            <div className="character-detail-heading">
              <Avatar size={96} src={getCharacterAvatarUrl(selected, supabaseUrl)} />
              <div>
                <Typography.Title level={3}>{selected.name}</Typography.Title>
                {normalizeCharacterTags(selected.tags).map((tag) => (
                  <Tag key={tag}>{tag}</Tag>
                ))}
              </div>
            </div>
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label="角色 ID">{selected.id}</Descriptions.Item>
              <Descriptions.Item label="作者">{selected.creator || '未填写'}</Descriptions.Item>
              <Descriptions.Item label="描述">{selected.description || '未填写'}</Descriptions.Item>
              <Descriptions.Item label="更新时间">
                {formatDate(selected.updated_at)}
              </Descriptions.Item>
            </Descriptions>
          </Space>
        ) : null}
      </Drawer>
    </>
  );
}
