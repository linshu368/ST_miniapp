import { useMemo, useState } from 'react';
import {
  closestCenter,
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Avatar,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Popconfirm,
  Skeleton,
  Space,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { CharacterCard } from '../lib/adminApi';
import { getAdminSupabaseUrl, type AdminEnvironment } from '../lib/environment';
import { getCharacterAvatarUrl, normalizeCharacterTags } from '../lib/characterCards';

interface CharacterCardsViewProps {
  characters: CharacterCard[];
  environment: AdminEnvironment;
  loading: boolean;
  error: string | null;
  canWrite: boolean;
  mutationLoading: boolean;
  onRefresh: () => void;
  onSetEnabled: (character: CharacterCard, enabled: boolean) => Promise<void>;
  onReorder: (characterIds: string[]) => Promise<void>;
  onArchive: (character: CharacterCard) => Promise<void>;
}

function formatCharacterDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function SortableCharacterRow(props: {
  character: CharacterCard;
  disabled: boolean;
  supabaseUrl: string;
  onDetail: () => void;
  onDisable: () => void;
  onArchive: () => void;
}) {
  const sortable = useSortable({ id: props.character.id, disabled: props.disabled });
  return (
    <div
      ref={sortable.setNodeRef}
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
      }}
      className="character-management-row"
    >
      <button
        type="button"
        className="character-drag-handle"
        disabled={props.disabled}
        {...sortable.attributes}
        {...sortable.listeners}
        aria-label={`拖拽排序 ${props.character.name}`}
      >
        ⋮⋮
      </button>
      <Avatar size={54} src={getCharacterAvatarUrl(props.character, props.supabaseUrl)}>
        {props.character.name.slice(0, 1)}
      </Avatar>
      <div className="character-management-copy" onClick={props.onDetail}>
        <strong>{props.character.name}</strong>
        <span>排序 {props.character.sort_order}</span>
      </div>
      <Space>
        <Button size="small" onClick={props.onDetail}>
          详情
        </Button>
        <Button size="small" disabled={props.disabled} onClick={props.onDisable}>
          下架
        </Button>
        <Popconfirm
          title="确认软删除这个角色？"
          description="角色将被归档，不会删除历史聊天和 Storage 资源。"
          okText="确认归档"
          cancelText="取消"
          disabled={props.disabled}
          onConfirm={props.onArchive}
        >
          <Button size="small" danger disabled={props.disabled}>
            删除
          </Button>
        </Popconfirm>
      </Space>
    </div>
  );
}

export function CharacterCardsView(props: CharacterCardsViewProps) {
  const [selectedCharacter, setSelectedCharacter] = useState<CharacterCard | null>(null);
  const [tab, setTab] = useState<'listed' | 'delisted'>('listed');
  const supabaseUrl = getAdminSupabaseUrl(props.environment);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const listed = useMemo(
    () =>
      props.characters
        .filter((character) => character.enabled)
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [props.characters]
  );
  const delisted = useMemo(
    () =>
      props.characters
        .filter((character) => !character.enabled)
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [props.characters]
  );

  const handleDragEnd = (event: DragEndEvent) => {
    if (!event.over || event.active.id === event.over.id) return;
    const oldIndex = listed.findIndex((character) => character.id === event.active.id);
    const newIndex = listed.findIndex((character) => character.id === event.over?.id);
    if (oldIndex < 0 || newIndex < 0) return;
    void props.onReorder(arrayMove(listed, oldIndex, newIndex).map((character) => character.id));
  };

  const emptyOrLoading =
    props.error ||
    (props.loading && props.characters.length === 0) ||
    props.characters.length === 0;

  return (
    <>
      <Card
        title="角色卡展示管理"
        extra={
          <Space wrap>
            <Tag color="green">已上架 {listed.length}</Tag>
            <Tag>已下架 {delisted.length}</Tag>
            <Button loading={props.loading} onClick={props.onRefresh}>
              刷新
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          左侧管理角色顺序和状态，右侧实时预览用户大厅。前 1—8 个上架位置显示流金边框。
        </Typography.Paragraph>
        {emptyOrLoading ? (
          props.error ? (
            <Empty description={props.error}>
              <Button onClick={props.onRefresh}>重新加载</Button>
            </Empty>
          ) : props.loading ? (
            <Skeleton active paragraph={{ rows: 8 }} />
          ) : (
            <Empty description="当前环境暂无角色卡" />
          )
        ) : (
          <div className="character-management-layout">
            <div className="character-management-panel">
              <Tabs
                activeKey={tab}
                onChange={(key) => setTab(key as 'listed' | 'delisted')}
                items={[
                  {
                    key: 'listed',
                    label: `已上架（${listed.length}）`,
                    children: (
                      <DndContext
                        sensors={sensors}
                        collisionDetection={closestCenter}
                        onDragEnd={handleDragEnd}
                      >
                        <SortableContext
                          items={listed.map((character) => character.id)}
                          strategy={verticalListSortingStrategy}
                        >
                          <Space direction="vertical" className="field-full" size="small">
                            {listed.map((character) => (
                              <SortableCharacterRow
                                key={character.id}
                                character={character}
                                supabaseUrl={supabaseUrl}
                                disabled={!props.canWrite || props.mutationLoading}
                                onDetail={() => setSelectedCharacter(character)}
                                onDisable={() => void props.onSetEnabled(character, false)}
                                onArchive={() => void props.onArchive(character)}
                              />
                            ))}
                          </Space>
                        </SortableContext>
                      </DndContext>
                    ),
                  },
                  {
                    key: 'delisted',
                    label: `已下架（${delisted.length}）`,
                    children:
                      delisted.length === 0 ? (
                        <Empty description="暂无下架角色" />
                      ) : (
                        <Space direction="vertical" className="field-full" size="small">
                          {delisted.map((character) => (
                            <div className="character-management-row" key={character.id}>
                              <Avatar
                                size={54}
                                src={getCharacterAvatarUrl(character, supabaseUrl)}
                              />
                              <div
                                className="character-management-copy"
                                onClick={() => setSelectedCharacter(character)}
                              >
                                <strong>{character.name}</strong>
                                <span>已保留角色数据，可重新上架</span>
                              </div>
                              <Space>
                                <Button
                                  size="small"
                                  disabled={!props.canWrite || props.mutationLoading}
                                  onClick={() => void props.onSetEnabled(character, true)}
                                >
                                  重新上架
                                </Button>
                                <Popconfirm
                                  title="确认软删除这个角色？"
                                  description="角色将被归档，不会删除历史聊天和 Storage 资源。"
                                  okText="确认归档"
                                  cancelText="取消"
                                  disabled={!props.canWrite || props.mutationLoading}
                                  onConfirm={() => void props.onArchive(character)}
                                >
                                  <Button
                                    size="small"
                                    danger
                                    disabled={!props.canWrite || props.mutationLoading}
                                  >
                                    删除
                                  </Button>
                                </Popconfirm>
                              </Space>
                            </div>
                          ))}
                        </Space>
                      ),
                  },
                ]}
              />
            </div>
            <div className="character-lobby-phone">
              <div className="character-lobby-screen">
                <Typography.Title level={4}>探索角色</Typography.Title>
                <div className="character-lobby-grid">
                  {listed.map((character, index) => (
                    <button
                      type="button"
                      key={character.id}
                      className={index < 8 ? 'is-golden' : ''}
                      onClick={() => setSelectedCharacter(character)}
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
        )}
      </Card>

      <Drawer
        width={640}
        title={selectedCharacter?.name ?? '角色详情'}
        open={selectedCharacter !== null}
        onClose={() => setSelectedCharacter(null)}
      >
        {selectedCharacter ? (
          <Space direction="vertical" size="large" className="field-full">
            <div className="character-detail-heading">
              <Avatar size={96} src={getCharacterAvatarUrl(selectedCharacter, supabaseUrl)}>
                {selectedCharacter.name.slice(0, 1)}
              </Avatar>
              <div>
                <Typography.Title level={3}>{selectedCharacter.name}</Typography.Title>
                <Space wrap>
                  <Tag color={selectedCharacter.enabled ? 'green' : 'default'}>
                    {selectedCharacter.enabled ? '已上架' : '已下架'}
                  </Tag>
                  <Tag>排序 {selectedCharacter.sort_order}</Tag>
                  {normalizeCharacterTags(selectedCharacter.tags).map((tag) => (
                    <Tag key={tag}>{tag}</Tag>
                  ))}
                </Space>
              </div>
            </div>
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label="角色 ID">{selectedCharacter.id}</Descriptions.Item>
              <Descriptions.Item label="作者">
                {selectedCharacter.creator || '未填写'}
              </Descriptions.Item>
              <Descriptions.Item label="描述">
                <Typography.Paragraph className="character-long-copy">
                  {selectedCharacter.description || '未填写'}
                </Typography.Paragraph>
              </Descriptions.Item>
              <Descriptions.Item label="开场白">
                <Typography.Paragraph className="character-long-copy">
                  {selectedCharacter.first_mes || '未填写'}
                </Typography.Paragraph>
              </Descriptions.Item>
              <Descriptions.Item label="更新时间">
                {formatCharacterDate(selectedCharacter.updated_at)}
              </Descriptions.Item>
            </Descriptions>
          </Space>
        ) : null}
      </Drawer>
    </>
  );
}
