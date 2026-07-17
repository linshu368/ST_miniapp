import { useMemo, useState } from 'react';
import {
  Avatar,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Skeleton,
  Space,
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
  onRefresh: () => void;
}

function formatCharacterDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

export function CharacterCardsView(props: CharacterCardsViewProps) {
  const [selectedCharacter, setSelectedCharacter] = useState<CharacterCard | null>(null);
  const supabaseUrl = getAdminSupabaseUrl(props.environment);
  const summary = useMemo(
    () => ({
      enabled: props.characters.filter((character) => character.enabled).length,
      disabled: props.characters.filter((character) => !character.enabled).length,
    }),
    [props.characters]
  );

  return (
    <>
      <Card
        title="角色卡"
        extra={
          <Space wrap>
            <Tag color="green">已上架 {summary.enabled}</Tag>
            <Tag>已下架 {summary.disabled}</Tag>
            <Button loading={props.loading} onClick={props.onRefresh}>
              刷新
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          当前仅提供角色卡展示，数据来自所选环境的 miniapp.characters。
        </Typography.Paragraph>

        {props.error ? (
          <Empty
            description={
              <Space direction="vertical">
                <Typography.Text type="danger">{props.error}</Typography.Text>
                <Button onClick={props.onRefresh}>重新加载</Button>
              </Space>
            }
          />
        ) : props.loading && props.characters.length === 0 ? (
          <div className="character-card-grid">
            {Array.from({ length: 8 }).map((_, index) => (
              <Card key={index} className="character-admin-card">
                <Skeleton active avatar paragraph={{ rows: 3 }} />
              </Card>
            ))}
          </div>
        ) : props.characters.length === 0 ? (
          <Empty description="当前环境暂无角色卡" />
        ) : (
          <div className="character-card-grid">
            {props.characters.map((character) => {
              const tags = normalizeCharacterTags(character.tags);
              return (
                <Card
                  key={character.id}
                  hoverable
                  className="character-admin-card"
                  onClick={() => setSelectedCharacter(character)}
                >
                  <div className="character-admin-card-header">
                    <Avatar size={72} src={getCharacterAvatarUrl(character, supabaseUrl)}>
                      {character.name.slice(0, 1)}
                    </Avatar>
                    <div>
                      <Typography.Title level={4}>{character.name}</Typography.Title>
                      <Typography.Text type="secondary">
                        {character.creator || '未填写作者'}
                      </Typography.Text>
                    </div>
                    <Tag color={character.enabled ? 'green' : 'default'}>
                      {character.enabled ? '已上架' : '已下架'}
                    </Tag>
                  </div>
                  <Typography.Paragraph ellipsis={{ rows: 3 }} className="character-description">
                    {character.description || '暂无角色描述'}
                  </Typography.Paragraph>
                  <div className="character-tags">
                    {tags.length > 0 ? (
                      tags.slice(0, 5).map((tag) => <Tag key={tag}>{tag}</Tag>)
                    ) : (
                      <Typography.Text type="secondary">暂无标签</Typography.Text>
                    )}
                  </div>
                  <div className="character-card-footer">
                    <Typography.Text type="secondary">排序 {character.sort_order}</Typography.Text>
                    <Button type="link" size="small">
                      查看详情
                    </Button>
                  </div>
                </Card>
              );
            })}
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
              <Descriptions.Item label="创作者备注">
                <Typography.Paragraph className="character-long-copy">
                  {selectedCharacter.creator_notes || '未填写'}
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
