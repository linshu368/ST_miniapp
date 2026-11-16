import {
  Alert,
  Button,
  Card,
  Input,
  Popconfirm,
  Radio,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import {
  EditableDriveModesConfigSchema,
  MAX_DRIVE_MODES,
  type EditableDriveModesConfig,
} from '@miniapp/shared';

type EditableMode = EditableDriveModesConfig['modes'][number];

function ordered(config: EditableDriveModesConfig): EditableMode[] {
  return config.modes.slice().sort((a, b) => a.sort_order - b.sort_order);
}

/** 写回时按当前顺序重排 sort_order，保证与界面顺序一致。 */
function withOrder(config: EditableDriveModesConfig, modes: EditableMode[]) {
  return { ...config, modes: modes.map((mode, index) => ({ ...mode, sort_order: index })) };
}

/**
 * 剧情模式（drive_mode_options）编辑器。
 * id 一经发布就写进用户偏好与每轮诊断，所以已有档位的 id 只读；改名请改「按钮名」。
 */
export function DriveModeOptionsEditor(props: {
  value: unknown;
  onChange: (value: EditableDriveModesConfig) => void;
  disabled?: boolean;
}) {
  const parsed = EditableDriveModesConfigSchema.safeParse(props.value);
  if (!parsed.success) {
    return (
      <Alert type="error" showIcon message="剧情模式配置格式有误，请撤销编辑或回滚到有效版本。" />
    );
  }
  const config = parsed.data;
  const modes = ordered(config);

  const update = (index: number, patch: Partial<EditableMode>) => {
    const next = modes.slice();
    next[index] = { ...next[index]!, ...patch };
    props.onChange(withOrder(config, next));
  };
  const move = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= modes.length) return;
    const next = modes.slice();
    [next[index], next[target]] = [next[target]!, next[index]!];
    props.onChange(withOrder(config, next));
  };
  const remove = (index: number) => {
    const next = modes.filter((_, i) => i !== index);
    const keepDefault = next.some((mode) => mode.id === config.default_mode_id);
    props.onChange({
      ...withOrder(config, next),
      default_mode_id: keepDefault
        ? config.default_mode_id
        : (next.find((mode) => mode.enabled)?.id ?? next[0]?.id ?? ''),
    });
  };
  const add = () => {
    const id = `mode-${Date.now().toString(36)}`;
    props.onChange(
      withOrder(config, [
        ...modes,
        { id, ui_label: '', description: '', rules: '', enabled: false, sort_order: modes.length },
      ])
    );
  };

  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      <Alert
        type="info"
        showIcon
        message="用户在回复偏好最上方四选一。按钮名和说明展示给用户；规则替换主体模板里的 {{DRIVE_RULES}}。模型每次只看到用户所选的一档，每档规则必须自成一体。没选过的用户使用默认档。"
      />
      {modes.map((mode, index) => (
        <DriveModeCard
          key={mode.id}
          mode={mode}
          isDefault={mode.id === config.default_mode_id}
          isFirst={index === 0}
          isLast={index === modes.length - 1}
          canRemove={modes.length > 1}
          disabled={props.disabled}
          onPatch={(patch) => update(index, patch)}
          onMove={(delta) => move(index, delta)}
          onRemove={() => remove(index)}
          onMakeDefault={() => props.onChange({ ...config, default_mode_id: mode.id })}
        />
      ))}
      <Button block disabled={props.disabled || modes.length >= MAX_DRIVE_MODES} onClick={add}>
        添加一档（默认停用，填好再启用）
      </Button>
    </Space>
  );
}

function DriveModeCard(props: {
  mode: EditableMode;
  isDefault: boolean;
  isFirst: boolean;
  isLast: boolean;
  canRemove: boolean;
  disabled?: boolean;
  onPatch: (patch: Partial<EditableMode>) => void;
  onMove: (delta: -1 | 1) => void;
  onRemove: () => void;
  onMakeDefault: () => void;
}) {
  const { mode, isDefault } = props;
  return (
    <Card
      size="small"
      title={
        <Space wrap>
          <span>{mode.ui_label || '未命名'}</span>
          <Typography.Text type="secondary" code>
            {mode.id}
          </Typography.Text>
          {isDefault ? <Tag color="gold">默认档</Tag> : null}
          {!mode.enabled ? <Tag>已停用</Tag> : null}
        </Space>
      }
      extra={
        <Space>
          <Button
            size="small"
            disabled={props.disabled || props.isFirst}
            onClick={() => props.onMove(-1)}
          >
            上移
          </Button>
          <Button
            size="small"
            disabled={props.disabled || props.isLast}
            onClick={() => props.onMove(1)}
          >
            下移
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size="small" className="editor-stack">
        <Typography.Text>按钮名（四档并排，越短越好）</Typography.Text>
        <Input
          value={mode.ui_label}
          maxLength={8}
          showCount
          disabled={props.disabled}
          onChange={(event) => props.onPatch({ ui_label: event.target.value })}
        />
        <Typography.Text>一句白话说明（选中后显示给用户）</Typography.Text>
        <Input
          value={mode.description}
          maxLength={60}
          showCount
          disabled={props.disabled}
          onChange={(event) => props.onPatch({ description: event.target.value })}
        />
        <Typography.Text>注入 {'{{DRIVE_RULES}}'} 的规则</Typography.Text>
        <Input.TextArea
          value={mode.rules}
          maxLength={4000}
          showCount
          autoSize={{ minRows: 6, maxRows: 18 }}
          disabled={props.disabled}
          onChange={(event) => props.onPatch({ rules: event.target.value })}
        />
        <Space wrap>
          <Switch
            checked={mode.enabled}
            disabled={props.disabled || (isDefault && mode.enabled)}
            checkedChildren="启用"
            unCheckedChildren="停用"
            onChange={(enabled) => props.onPatch({ enabled })}
          />
          <Radio
            checked={isDefault}
            disabled={props.disabled || !mode.enabled}
            onChange={props.onMakeDefault}
          >
            默认档
          </Radio>
          <Popconfirm
            title="删除这一档？已选它的用户会回到默认档。"
            disabled={props.disabled || !props.canRemove || isDefault}
            onConfirm={props.onRemove}
          >
            <Button danger size="small" disabled={props.disabled || !props.canRemove || isDefault}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      </Space>
    </Card>
  );
}
