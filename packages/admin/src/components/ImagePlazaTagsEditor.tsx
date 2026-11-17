import { ImagePlazaTagConfigSchema, type ImagePlazaTagConfig } from '@miniapp/shared';
import { Alert, Button, Card, Col, Input, InputNumber, Row, Select, Space, Switch } from 'antd';
import { useState } from 'react';

export function ImagePlazaTagsEditor(props: {
  value: ImagePlazaTagConfig;
  disabled?: boolean;
  onChange: (value: ImagePlazaTagConfig) => void;
}) {
  // 业务 ID 可编辑，不能用作 React key；行标识只属于 UI，不进入保存的配置。
  const [rowKeys, setRowKeys] = useState(() => props.value.map(() => crypto.randomUUID()));
  if (rowKeys.length !== props.value.length) {
    setRowKeys(props.value.map(() => crypto.randomUUID()));
  }
  const validation = ImagePlazaTagConfigSchema.safeParse(props.value);
  const update = (index: number, patch: Partial<ImagePlazaTagConfig[number]>) => {
    const next = structuredClone(props.value);
    next[index] = { ...next[index], ...patch };
    props.onChange(next);
  };
  const updateGroup = (
    index: number,
    patch: Pick<
      Partial<ImagePlazaTagConfig[number]>,
      'group_label' | 'group_sort_order' | 'group_layout'
    >
  ) => {
    const groupId = props.value[index]?.group_id;
    props.onChange(
      props.value.map((tag) => (tag.group_id === groupId ? { ...tag, ...patch } : tag))
    );
  };
  const moveToGroup = (index: number, groupId: string) => {
    const existing = props.value.find(
      (tag, itemIndex) => itemIndex !== index && tag.group_id === groupId
    );
    update(index, {
      group_id: groupId,
      ...(existing
        ? {
            group_label: existing.group_label,
            group_sort_order: existing.group_sort_order,
            group_layout: existing.group_layout,
          }
        : {}),
    });
  };
  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      <Alert
        showIcon
        type="info"
        message="图片与视频共用同一标签目录"
        description="“全部”是系统固定项；筛选按标签名称模糊匹配 prompt_zh。相同分组 ID 会共享分组名称、顺序和布局。"
      />
      {!validation.success && (
        <Alert
          type="warning"
          showIcon
          message="请完善标签后保存，当前输入会保留"
          description={validation.error.issues.map((issue) => issue.message).join('；')}
        />
      )}
      <Card size="small">
        <Row gutter={12}>
          <Col span={8}>
            <Input value="all" disabled />
          </Col>
          <Col span={10}>
            <Input value="全部" disabled />
          </Col>
          <Col span={6}>
            <Switch checked disabled />
          </Col>
        </Row>
      </Card>
      {props.value.map((tag, index) => (
        <TagRow
          key={rowKeys[index]}
          tag={tag}
          index={index}
          disabled={props.disabled}
          update={update}
          updateGroup={updateGroup}
          moveToGroup={moveToGroup}
          onRemove={(removedIndex) => {
            setRowKeys((current) => current.filter((_, itemIndex) => itemIndex !== removedIndex));
            props.onChange(props.value.filter((_, itemIndex) => itemIndex !== removedIndex));
          }}
        />
      ))}
      <Button
        block
        disabled={props.disabled}
        onClick={() => {
          const previous = props.value.at(-1);
          setRowKeys((current) => [...current, crypto.randomUUID()]);
          props.onChange([
            ...props.value,
            {
              id: `tag-${Date.now()}`,
              label: '新标签',
              enabled: true,
              sort_order: props.value.length,
              group_id: previous?.group_id ?? 'style',
              group_label: previous?.group_label ?? '风格',
              group_sort_order: previous?.group_sort_order ?? 0,
              group_layout: previous?.group_layout ?? 'chips',
            },
          ]);
        }}
      >
        添加标签
      </Button>
    </Space>
  );
}

type TagFieldsProps = {
  tag: ImagePlazaTagConfig[number];
  index: number;
  disabled?: boolean;
  update: (index: number, patch: Partial<ImagePlazaTagConfig[number]>) => void;
  updateGroup: (
    index: number,
    patch: Pick<
      Partial<ImagePlazaTagConfig[number]>,
      'group_label' | 'group_sort_order' | 'group_layout'
    >
  ) => void;
  moveToGroup: (index: number, groupId: string) => void;
  onRemove: (index: number) => void;
};

function TagRow({
  tag,
  index,
  disabled,
  update,
  updateGroup,
  moveToGroup,
  onRemove,
}: TagFieldsProps) {
  return (
    <Card size="small">
      <Row gutter={[12, 12]} align="middle">
        <Col xs={24} md={6}>
          <Input
            addonBefore="ID"
            aria-label={`标签 ${index + 1} ID`}
            value={tag.id}
            disabled={disabled}
            onChange={(event) => update(index, { id: event.target.value })}
          />
        </Col>
        <Col xs={24} md={6}>
          <Input
            addonBefore="名称"
            aria-label={`标签 ${index + 1} 名称`}
            value={tag.label}
            disabled={disabled}
            onChange={(event) => update(index, { label: event.target.value })}
          />
        </Col>
        <Col xs={8} md={3}>
          <Switch
            checked={tag.enabled}
            disabled={disabled}
            onChange={(enabled) => update(index, { enabled })}
          />
        </Col>
        <Col xs={8} md={3}>
          <InputNumber
            addonBefore="标签顺序"
            min={0}
            precision={0}
            value={tag.sort_order}
            disabled={disabled}
            onChange={(sort_order) => update(index, { sort_order: sort_order ?? 0 })}
          />
        </Col>
        <Col xs={8} md={6}>
          <Button
            danger
            block
            disabled={disabled}
            onClick={() => {
              onRemove(index);
            }}
          >
            删除
          </Button>
        </Col>
        <TagGroupFields
          tag={tag}
          index={index}
          disabled={disabled}
          updateGroup={updateGroup}
          moveToGroup={moveToGroup}
        />
      </Row>
    </Card>
  );
}

function TagGroupFields({
  tag,
  index,
  disabled,
  updateGroup,
  moveToGroup,
}: Omit<TagFieldsProps, 'update' | 'onRemove'>) {
  return (
    <>
      <Col xs={24} md={6}>
        <Input
          addonBefore="分组 ID"
          aria-label={`标签 ${index + 1} 分组 ID`}
          value={tag.group_id}
          disabled={disabled}
          onChange={(event) => moveToGroup(index, event.target.value)}
        />
      </Col>
      <Col xs={24} md={6}>
        <Input
          addonBefore="分组名称"
          aria-label={`标签 ${index + 1} 分组名称`}
          value={tag.group_label}
          disabled={disabled}
          onChange={(event) => updateGroup(index, { group_label: event.target.value })}
        />
      </Col>
      <Col xs={12} md={6}>
        <InputNumber
          addonBefore="分组顺序"
          className="field-full"
          min={0}
          precision={0}
          value={tag.group_sort_order}
          disabled={disabled}
          onChange={(group_sort_order) =>
            updateGroup(index, { group_sort_order: group_sort_order ?? 0 })
          }
        />
      </Col>
      <Col xs={12} md={6}>
        <Select
          aria-label={`标签 ${index + 1} 分组布局`}
          className="field-full"
          value={tag.group_layout}
          disabled={disabled}
          options={[
            { value: 'chips', label: '标签流式布局' },
            { value: 'grid', label: '卡片网格布局' },
          ]}
          onChange={(group_layout) => updateGroup(index, { group_layout })}
        />
      </Col>
    </>
  );
}
