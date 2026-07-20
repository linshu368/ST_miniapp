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
  Form,
  Input,
  Modal,
  Popconfirm,
  Segmented,
  Select,
  Skeleton,
  Space,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import {
  createCharacter,
  deleteCharacterLayoutRelease,
  discardCharacterLayoutDraft,
  getCharacterLayout,
  listCharacterLayoutReleases,
  publishCharacterLayoutDraft,
  rollbackCharacterLayoutRelease,
  saveCharacterLayoutDraft,
  uploadCharacterAvatar,
  type CharacterCard,
  type CharacterLayoutRelease,
  type CharacterLayoutSnapshot,
  type CharacterLayoutValue,
} from '../lib/adminApi';
import { getAdminSupabaseUrl, type AdminEnvironment } from '../lib/environment';
import {
  charactersForIds,
  filterCharacters,
  getCharacterAvatarUrl,
  layoutsEqual,
  moveCharacterId,
  normalizeCharacterTags,
  summarizeCharacterLayoutChanges,
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

interface CreateCharacterFormValue {
  name: string;
  description?: string;
  avatarUrl?: string;
  tags?: string[];
  creator?: string;
  firstMes?: string;
  creatorNotes?: string;
  personality?: string;
  scenario?: string;
  systemPrompt?: string;
  mesExample?: string;
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
  const [selectedRelease, setSelectedRelease] = useState<CharacterLayoutRelease | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createLoading, setCreateLoading] = useState(false);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [characterSearch, setCharacterSearch] = useState('');
  const [createForm] = Form.useForm<CreateCharacterFormValue>();
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
  const filteredListed = useMemo(
    () => filterCharacters(listed, characterSearch),
    [listed, characterSearch]
  );
  const filteredDelisted = useMemo(
    () => filterCharacters(delisted, characterSearch),
    [delisted, characterSearch]
  );
  const filteredDeleted = useMemo(
    () => filterCharacters(deleted, characterSearch),
    [deleted, characterSearch]
  );
  const publishedListed = useMemo(
    () => charactersForIds(props.characters, snapshot?.published.listed_ids ?? []),
    [props.characters, snapshot]
  );
  const previewCharacters = preview === 'draft' ? listed : publishedListed;
  const hydrated = snapshot?.draft ?? snapshot?.published;
  const dirty = Boolean(working && hydrated && !layoutsEqual(working, hydrated));
  const characterNames = useMemo(
    () => new Map(props.characters.map((character) => [character.id, character.name])),
    [props.characters]
  );
  const selectedReleaseIndex = selectedRelease
    ? releases.findIndex((release) => release.id === selectedRelease.id)
    : -1;
  const selectedPreviousRelease =
    selectedReleaseIndex >= 0 ? (releases[selectedReleaseIndex + 1] ?? null) : null;
  const selectedReleaseChanges = selectedRelease
    ? summarizeCharacterLayoutChanges(
        {
          listed_ids: selectedRelease.listed_ids,
          delisted_ids: selectedRelease.delisted_ids,
          deleted_ids: selectedRelease.deleted_ids,
        },
        selectedPreviousRelease
          ? {
              listed_ids: selectedPreviousRelease.listed_ids,
              delisted_ids: selectedPreviousRelease.delisted_ids,
              deleted_ids: selectedPreviousRelease.deleted_ids,
            }
          : null
      )
    : null;

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

  const deleteRelease = async (release: CharacterLayoutRelease) => {
    if (!snapshot || !props.canWrite || release.layout_version === snapshot.layout_version) return;
    const confirmed = await confirmAction(
      `删除角色布局版本 ${release.layout_version}？`,
      '只会删除该历史快照，不会改变当前已发布布局、草稿或 MiniApp 展示。删除后无法再回滚到此版本。',
      true
    );
    if (!confirmed) return;
    setSaving(true);
    try {
      await deleteCharacterLayoutRelease(props.client, release.id);
      if (selectedRelease?.id === release.id) setSelectedRelease(null);
      message.success(`角色布局版本 ${release.layout_version} 已删除`);
      await reloadLayout();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '角色布局版本删除失败');
    } finally {
      setSaving(false);
    }
  };

  const submitCreate = async (values: CreateCharacterFormValue) => {
    setCreateLoading(true);
    try {
      const character = await createCharacter(props.client, {
        name: values.name.trim(),
        description: values.description?.trim() ?? '',
        avatarUrl: values.avatarUrl?.trim() ?? '',
        tags: values.tags ?? [],
        creator: values.creator?.trim() ?? '',
        firstMes: values.firstMes ?? '',
        creatorNotes: values.creatorNotes ?? '',
        personality: values.personality ?? '',
        scenario: values.scenario ?? '',
        systemPrompt: values.systemPrompt ?? '',
        mesExample: values.mesExample ?? '',
      });
      if (avatarFile) {
        try {
          await uploadCharacterAvatar(props.client, props.environment, character.id, avatarFile);
        } catch (uploadError) {
          await Promise.all([props.onRefresh(), reloadLayout()]);
          setCreateOpen(false);
          createForm.resetFields();
          setAvatarFile(null);
          setTab('delisted');
          message.warning(
            `角色已创建并保持下架，但头像上传失败：${
              uploadError instanceof Error ? uploadError.message : '未知错误'
            }`
          );
          return;
        }
      }
      await Promise.all([props.onRefresh(), reloadLayout()]);
      setCreateOpen(false);
      createForm.resetFields();
      setAvatarFile(null);
      setTab('delisted');
      message.success(`角色“${character.name}”已创建并放入已下架区域`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '角色卡创建失败');
    } finally {
      setCreateLoading(false);
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
              type="primary"
              disabled={!props.canWrite || saving}
              onClick={() => setCreateOpen(true)}
            >
              创建角色卡
            </Button>
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
        <div className="character-draft-toolbar">
          <Space wrap>
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
          <Input.Search
            allowClear
            value={characterSearch}
            className="character-search"
            placeholder="搜索角色名称、ID、作者或标签"
            onChange={(event) => setCharacterSearch(event.target.value)}
          />
        </div>
        <Card size="small" title="发布历史与回滚" className="character-release-history">
          {releases.length === 0 ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无角色布局发布历史" />
          ) : (
            <Space direction="vertical" className="field-full" size="small">
              {releases.map((release) => (
                <div className="character-release-row" key={release.id}>
                  <div>
                    <Space size="small">
                      <strong>版本 {release.layout_version}</strong>
                      <Tag
                        color={
                          release.release_kind === 'rollback'
                            ? 'orange'
                            : release.release_kind === 'baseline'
                              ? 'default'
                              : 'blue'
                        }
                      >
                        {release.release_kind === 'rollback'
                          ? `回滚发布${release.rollback_target_version === null ? '' : ` · 来源 v${release.rollback_target_version}`}`
                          : release.release_kind === 'baseline'
                            ? '初始基线'
                            : '草稿发布'}
                      </Tag>
                    </Space>
                    <span>
                      上架 {release.listed_count} · 下架 {release.delisted_count} · 已删除{' '}
                      {release.deleted_count}
                    </span>
                    <span>
                      {release.released_by_name || release.released_by_email || '未知操作人'} ·{' '}
                      {formatDate(release.released_at)}
                    </span>
                  </div>
                  <Space>
                    <Button size="small" onClick={() => setSelectedRelease(release)}>
                      查看详情
                    </Button>
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
                    <Button
                      size="small"
                      danger
                      disabled={
                        !props.canWrite ||
                        saving ||
                        release.layout_version === snapshot?.layout_version
                      }
                      title={
                        release.layout_version === snapshot?.layout_version
                          ? '当前已发布版本不能删除'
                          : '删除该历史快照'
                      }
                      onClick={() => void deleteRelease(release)}
                    >
                      删除版本
                    </Button>
                  </Space>
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
                    label: `已上架（${characterSearch ? `${filteredListed.length}/` : ''}${listed.length}）`,
                    children: filteredListed.length ? (
                      <Space direction="vertical" className="field-full" size="small">
                        {filteredListed.map((character) =>
                          renderRow(
                            character,
                            'listed',
                            listed.findIndex((item) => item.id === character.id)
                          )
                        )}
                      </Space>
                    ) : (
                      <Empty
                        description={characterSearch ? '没有匹配的上架角色' : '暂无上架角色'}
                      />
                    ),
                  },
                  {
                    key: 'delisted',
                    label: `已下架（${characterSearch ? `${filteredDelisted.length}/` : ''}${delisted.length}）`,
                    children: filteredDelisted.length ? (
                      <Space direction="vertical" className="field-full" size="small">
                        {filteredDelisted.map((character) =>
                          renderRow(
                            character,
                            'delisted',
                            delisted.findIndex((item) => item.id === character.id)
                          )
                        )}
                      </Space>
                    ) : (
                      <Empty
                        description={characterSearch ? '没有匹配的下架角色' : '暂无下架角色'}
                      />
                    ),
                  },
                  {
                    key: 'deleted',
                    label: `已删除（${characterSearch ? `${filteredDeleted.length}/` : ''}${deleted.length}）`,
                    children: filteredDeleted.length ? (
                      <Space direction="vertical" className="field-full" size="small">
                        {filteredDeleted.map((character) =>
                          renderRow(
                            character,
                            'deleted',
                            deleted.findIndex((item) => item.id === character.id)
                          )
                        )}
                      </Space>
                    ) : (
                      <Empty
                        description={characterSearch ? '没有匹配的已删除角色' : '暂无已删除角色'}
                      />
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
      <Modal
        width={760}
        title="创建新角色卡"
        open={createOpen}
        confirmLoading={createLoading}
        okText="创建并放入已下架"
        cancelText="取消"
        onOk={() => createForm.submit()}
        onCancel={() => {
          if (createLoading) return;
          setCreateOpen(false);
          createForm.resetFields();
          setAvatarFile(null);
        }}
      >
        <Alert
          type="info"
          showIcon
          message="新角色默认进入“已下架”，不会立即出现在 MiniApp。完成内容检查后，可重新上架、保存草稿并发布。"
          className="form-alert"
        />
        <Form<CreateCharacterFormValue>
          form={createForm}
          layout="vertical"
          onFinish={(values) => void submitCreate(values)}
        >
          <Form.Item
            label="角色名称"
            name="name"
            rules={[
              { required: true, whitespace: true, message: '请输入角色名称' },
              { max: 120, message: '角色名称不能超过 120 个字符' },
            ]}
          >
            <Input placeholder="用户在大厅中看到的角色名称" maxLength={120} showCount />
          </Form.Item>
          <Form.Item
            label="角色头像 URL"
            name="avatarUrl"
            rules={[{ type: 'url', message: '请输入完整的 HTTPS 图片地址' }]}
          >
            <Input placeholder="https://...（可稍后补充）" />
          </Form.Item>
          <Form.Item
            label="或上传头像 PNG"
            extra="仅支持 PNG，最大 5 MB；上传文件时将覆盖上面的头像 URL。"
          >
            <input
              type="file"
              accept="image/png"
              onChange={(event) => {
                const file = event.target.files?.[0] ?? null;
                if (file && (file.type !== 'image/png' || file.size > 5 * 1024 * 1024)) {
                  message.error('请选择不超过 5 MB 的 PNG 图片');
                  event.target.value = '';
                  setAvatarFile(null);
                  return;
                }
                setAvatarFile(file);
              }}
            />
            {avatarFile ? (
              <Typography.Text type="secondary">已选择：{avatarFile.name}</Typography.Text>
            ) : null}
          </Form.Item>
          <Form.Item label="角色描述" name="description">
            <Input.TextArea rows={3} maxLength={4000} showCount />
          </Form.Item>
          <Form.Item label="标签" name="tags">
            <Select
              mode="tags"
              tokenSeparators={[',', '，']}
              placeholder="输入标签后按回车"
              maxTagCount="responsive"
            />
          </Form.Item>
          <Form.Item label="作者" name="creator">
            <Input maxLength={120} />
          </Form.Item>
          <Form.Item label="开场白" name="firstMes">
            <Input.TextArea rows={4} maxLength={20000} showCount />
          </Form.Item>
          <Form.Item label="角色性格" name="personality">
            <Input.TextArea rows={3} maxLength={20000} showCount />
          </Form.Item>
          <Form.Item label="场景设定" name="scenario">
            <Input.TextArea rows={3} maxLength={20000} showCount />
          </Form.Item>
          <Form.Item label="系统提示词" name="systemPrompt">
            <Input.TextArea rows={4} maxLength={30000} showCount />
          </Form.Item>
          <Form.Item label="对话示例" name="mesExample">
            <Input.TextArea rows={4} maxLength={30000} showCount />
          </Form.Item>
          <Form.Item label="创作者备注" name="creatorNotes">
            <Input.TextArea rows={3} maxLength={20000} showCount />
          </Form.Item>
        </Form>
      </Modal>
      <Drawer
        width={760}
        title={selectedRelease ? `角色布局版本 ${selectedRelease.layout_version} 详情` : '发布详情'}
        open={selectedRelease !== null}
        onClose={() => setSelectedRelease(null)}
      >
        {selectedRelease ? (
          <Space direction="vertical" size="large" className="field-full">
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label="发布类型">
                {selectedRelease.release_kind === 'rollback'
                  ? '回滚发布'
                  : selectedRelease.release_kind === 'baseline'
                    ? '初始基线'
                    : '草稿发布'}
              </Descriptions.Item>
              <Descriptions.Item label="发布版本">
                {selectedRelease.layout_version}
              </Descriptions.Item>
              {selectedRelease.rollback_target_version !== null ? (
                <Descriptions.Item label="回滚来源版本">
                  {selectedRelease.rollback_target_version}
                </Descriptions.Item>
              ) : null}
              <Descriptions.Item label="操作人">
                {selectedRelease.released_by_name || '未填写姓名'}
                {selectedRelease.released_by_email
                  ? `（${selectedRelease.released_by_email}）`
                  : ''}
              </Descriptions.Item>
              <Descriptions.Item label="发布时间">
                {formatDate(selectedRelease.released_at)}
              </Descriptions.Item>
              <Descriptions.Item label="发布记录 ID">{selectedRelease.id}</Descriptions.Item>
              <Descriptions.Item label="来源草稿 ID">
                {selectedRelease.source_draft_id || '无'}
              </Descriptions.Item>
            </Descriptions>
            <Card size="small" title="相对上一版本的变更">
              {selectedPreviousRelease && selectedReleaseChanges ? (
                <Space wrap>
                  <Tag color="green">转为上架 {selectedReleaseChanges.listed.length}</Tag>
                  <Tag>转为下架 {selectedReleaseChanges.delisted.length}</Tag>
                  <Tag color="red">转为删除 {selectedReleaseChanges.deleted.length}</Tag>
                  <Tag color="cyan">从删除恢复 {selectedReleaseChanges.restored.length}</Tag>
                  <Tag color="purple">顺序变化 {selectedReleaseChanges.reordered.length}</Tag>
                </Space>
              ) : (
                <Typography.Text type="secondary">
                  这是最早的基线快照，没有上一版本。
                </Typography.Text>
              )}
            </Card>
            {(
              [
                ['已上架角色（按大厅顺序）', selectedRelease.listed_ids, true],
                ['已下架角色', selectedRelease.delisted_ids, false],
                ['已删除角色', selectedRelease.deleted_ids, false],
              ] as const
            ).map(([title, ids, ordered]) => (
              <Card size="small" title={`${title} · ${ids.length}`} key={title}>
                {ids.length === 0 ? (
                  <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="无角色" />
                ) : (
                  <ol
                    className={
                      ordered ? 'character-release-list is-ordered' : 'character-release-list'
                    }
                  >
                    {ids.map((id, index) => (
                      <li key={id}>
                        {ordered ? <span>{index + 1}</span> : null}
                        <strong>{characterNames.get(id) ?? '未知或已移除角色'}</strong>
                        <code>{id}</code>
                      </li>
                    ))}
                  </ol>
                )}
              </Card>
            ))}
          </Space>
        ) : null}
      </Drawer>
    </>
  );
}
