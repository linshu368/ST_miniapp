import { Alert, Button, Card, Empty, Select, Space, Tag, Typography } from 'antd';
import {
  DEFAULT_LOBBY_PINNED_CHARACTERS,
  LOBBY_MAX_PINNED_CHARACTERS,
  LobbyPinnedCharactersSchema,
} from '@miniapp/shared';
import type { CharacterCard } from '@miniapp/admin-client';

/**
 * 复用原运营名单作为全量推荐的加权候选。
 * 单独的固定主推不借用名单首项，避免旧八张配置在升级后意外成为强推。
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
  const fixedId = parsed.success ? (parsed.data.fixed_character_id ?? null) : null;

  const byId = new Map(props.characters.map((character) => [character.id, character]));

  // 下架卡不会进入推荐，编辑器保留它供运营辨认和替换。
  const selectable = props.characters
    .filter((character) => character.enabled && !character.archived_at)
    .sort((a, b) => a.sort_order - b.sort_order);

  const emit = (next: string[]) =>
    props.onChange({ character_ids: next, fixed_character_id: fixedId });

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

  const stale = [...new Set([...ids, ...(fixedId ? [fixedId] : [])])].filter((id) => {
    const character = byId.get(id);
    return (
      props.characters.length > 0 && (!character || !character.enabled || character.archived_at)
    );
  });

  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      {!parsed.success ? (
        <Alert type="warning" showIcon message="主推配置结构无效，已载入空名单。保存前请核对。" />
      ) : null}

      {props.charactersError ? (
        <Alert type="error" showIcon message={`角色卡加载失败：${props.charactersError}`} />
      ) : null}

      {stale.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          message={`有 ${stale.length} 张卡已下架或归档，推荐时会跳过。请替换或移出名单。`}
        />
      ) : null}

      <Alert
        type="info"
        showIcon
        message="主推增加被选中的机会，日常无需固定位置"
        description={`下方最多 ${LOBBY_MAX_PINNED_CHARACTERS} 张卡作为加权候选，仍需满足推荐质量要求，不会按名单顺序固定在前。金框不由个人列表中的位置决定。`}
      />

      <Card size="small" title="固定主推 · 最多 1 张">
        <Typography.Paragraph type="secondary">
          仅在确有强推需求时选择。符合质量要求的这张卡保留在前排，
          并计入相邻批次的重复额度；留空即可让推荐自然轮换。
        </Typography.Paragraph>
        <Select
          aria-label="固定主推角色"
          showSearch
          allowClear
          className="field-full"
          placeholder="不设置固定主推"
          value={fixedId ?? undefined}
          disabled={props.disabled}
          loading={props.charactersLoading}
          optionFilterProp="label"
          options={selectable.map((item) => ({ value: item.id, label: item.name }))}
          onChange={(nextId: string | undefined) =>
            props.onChange({ character_ids: ids, fixed_character_id: nextId ?? null })
          }
        />
      </Card>

      <Typography.Text strong>优先推荐候选</Typography.Text>

      {ids.length === 0 ? (
        <Empty description="暂无主推候选，按质量自然推荐" image={Empty.PRESENTED_IMAGE_SIMPLE} />
      ) : (
        <Space direction="vertical" size="small" className="editor-stack">
          {ids.map((id, index) => {
            const character = byId.get(id);
            const missing = props.characters.length > 0 && !character;
            const offline = character
              ? !character.enabled || Boolean(character.archived_at)
              : false;

            return (
              <Space key={id} wrap align="center">
                <Tag>候选 {index + 1}</Tag>
                <Select
                  aria-label={`主推候选 ${index + 1}`}
                  showSearch
                  className="field-full"
                  style={{ width: 230, maxWidth: '100%' }}
                  value={id}
                  disabled={props.disabled}
                  loading={props.charactersLoading}
                  optionFilterProp="label"
                  options={selectable.map((item) => ({
                    value: item.id,
                    label: item.name,
                    // 候选名单保持唯一，不能靠重复添加提高权重。
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
          : '添加主推候选'}
      </Button>
    </Space>
  );
}
