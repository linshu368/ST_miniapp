import { Alert, Button, Empty, Select, Space, Tag, Typography } from 'antd';
import {
  DEFAULT_LOBBY_PINNED_CHARACTERS,
  LOBBY_MAX_PINNED_CHARACTERS,
  LobbyPinnedCharactersSchema,
} from '@miniapp/shared';
import type { CharacterCard } from '../lib/adminApi';

/**
 * 首页「推荐」页固定前八的编辑器。
 *
 * 一张一行、可上下换位、可删可换，而不是一个多选框：固定位是有顺序的，
 * 「谁在第一个」是运营真正在决定的事，多选框表达不了这个。
 */
export function LobbyPinnedCharactersEditor(props: {
  value: unknown;
  characters: CharacterCard[];
  charactersLoading: boolean;
  charactersError: string | null;
  disabled?: boolean;
  onChange: (value: unknown) => void;
}) {
  const parsed = LobbyPinnedCharactersSchema.safeParse(props.value);
  const ids = parsed.success
    ? parsed.data.character_ids
    : DEFAULT_LOBBY_PINNED_CHARACTERS.character_ids;

  const byId = new Map(props.characters.map((character) => [character.id, character]));

  // 只有在架卡能进固定位：配了下架卡，读路径会跳过它，运营却以为占住了位置
  const selectable = props.characters
    .filter((character) => character.enabled && !character.archived_at)
    .sort((a, b) => a.sort_order - b.sort_order);

  const emit = (next: string[]) => props.onChange({ character_ids: next });

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= ids.length) return;
    const next = [...ids];
    const moved = next[index];
    const swapped = next[target];
    if (moved === undefined || swapped === undefined) return;
    next[index] = swapped;
    next[target] = moved;
    emit(next);
  };

  const stale = ids.filter((id) => {
    const character = byId.get(id);
    return (
      props.characters.length > 0 && (!character || !character.enabled || character.archived_at)
    );
  });

  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      {!parsed.success ? (
        <Alert type="warning" showIcon message="固定位配置结构无效，已载入空列表（即不固定）。" />
      ) : null}

      {props.charactersError ? (
        <Alert type="error" showIcon message={`角色卡加载失败：${props.charactersError}`} />
      ) : null}

      {stale.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${stale.length} 张卡已下架或归档，首页会跳过它们，固定位实际会少这么多个。建议换掉。`}
        />
      ) : null}

      <Typography.Text type="secondary">
        按顺序占据推荐页最前面的位置，最多 {LOBBY_MAX_PINNED_CHARACTERS} 张，同时拿到金框。 第{' '}
        {LOBBY_MAX_PINNED_CHARACTERS + 1} 张起仍按排序分。全部删掉表示不固定。
      </Typography.Text>

      {ids.length === 0 ? (
        <Empty description="当前不固定，推荐页完全按排序分" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <Space direction="vertical" size="small" className="editor-stack">
          {ids.map((id, index) => {
            const character = byId.get(id);
            const missing = props.characters.length > 0 && !character;
            const offline = character
              ? !character.enabled || Boolean(character.archived_at)
              : false;

            return (
              <Space key={`${id}-${index}`} wrap align="center">
                <Tag color="gold">第 {index + 1} 位</Tag>
                <Select
                  showSearch
                  className="field-full"
                  style={{ minWidth: 260 }}
                  value={id}
                  disabled={props.disabled}
                  loading={props.charactersLoading}
                  optionFilterProp="label"
                  options={selectable.map((item) => ({
                    value: item.id,
                    label: item.name,
                    // 已经占了别的位置的卡不能再选，避免同一张卡占两格
                    disabled: item.id !== id && ids.includes(item.id),
                  }))}
                  onChange={(nextId: string) => {
                    const next = [...ids];
                    next[index] = nextId;
                    emit(next);
                  }}
                />
                {missing ? <Tag color="red">卡不存在</Tag> : null}
                {offline ? <Tag color="orange">已下架</Tag> : null}
                <Button
                  size="small"
                  disabled={props.disabled || index === 0}
                  onClick={() => move(index, -1)}
                >
                  上移
                </Button>
                <Button
                  size="small"
                  disabled={props.disabled || index === ids.length - 1}
                  onClick={() => move(index, 1)}
                >
                  下移
                </Button>
                <Button
                  size="small"
                  danger
                  disabled={props.disabled}
                  onClick={() => emit(ids.filter((_, itemIndex) => itemIndex !== index))}
                >
                  移出
                </Button>
              </Space>
            );
          })}
        </Space>
      )}

      <Button
        block
        disabled={props.disabled || ids.length >= LOBBY_MAX_PINNED_CHARACTERS}
        loading={props.charactersLoading}
        onClick={() => {
          const next = selectable.find((item) => !ids.includes(item.id));
          if (next) emit([...ids, next.id]);
        }}
      >
        {ids.length >= LOBBY_MAX_PINNED_CHARACTERS
          ? `已满 ${LOBBY_MAX_PINNED_CHARACTERS} 张`
          : '添加固定位'}
      </Button>
    </Space>
  );
}
