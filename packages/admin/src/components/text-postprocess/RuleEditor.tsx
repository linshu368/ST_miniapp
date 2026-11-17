import { Alert, Button, Empty, Input, Modal, Space, Switch, Tabs, Typography } from 'antd';
import { RICH_REPLY_RULE_STYLES, type TextPostprocessDiagnostic } from '@miniapp/shared';
import {
  RULE_FIELD_HELP,
  isBodyStyleRule,
  type EditableRule,
  type EditableSource,
} from '../../lib/textPostprocessTemplates';
import {
  deleteRule,
  duplicateRule,
  moveRule,
  setRuleEnabled,
  updateRuleField,
  type EnvSession,
} from '../../lib/textPostprocessWorkbench';

type EditableField = 'name' | 'description' | 'pattern' | 'flags' | 'replacement' | 'css' | 'notes';
type ChangeRule = (field: EditableField, value: string) => void;

const FIELD_LABEL: Record<string, string> = {
  description: '描述',
  pattern: '正则',
  replacement: '模板',
  css: '样式',
  notes: '说明',
};

function diagnosticText(item: TextPostprocessDiagnostic): string {
  const location = item.location
    ? `第 ${item.location.line} 行，第 ${item.location.column} 列。`
    : '';
  return `${item.message} ${location}`.trim();
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

function RuleActionButtons(props: {
  session: EnvSession;
  rule: EditableRule;
  disabled: boolean;
  position: number;
  onEdit: (local: EditableSource, selectedRuleId: string | null) => void;
}) {
  const { rule, session } = props;
  return (
    <Space size={2}>
      <Button
        aria-label="上移规则"
        size="small"
        disabled={props.disabled || props.position <= 0}
        onClick={() => props.onEdit(moveRule(session.local, rule.id, 'up'), rule.id)}
      >
        ↑
      </Button>
      <Button
        aria-label="下移规则"
        size="small"
        disabled={props.disabled || props.position === session.local.rules.length - 1}
        onClick={() => props.onEdit(moveRule(session.local, rule.id, 'down'), rule.id)}
      >
        ↓
      </Button>
      <Button
        aria-label="复制规则"
        size="small"
        disabled={props.disabled}
        onClick={() => {
          const copied = duplicateRule(session.local, rule.id);
          if (copied) props.onEdit(copied.local, copied.selectedRuleId);
        }}
      >
        ⧉
      </Button>
      <Button
        aria-label="删除规则"
        size="small"
        danger
        disabled={props.disabled}
        onClick={() => {
          void confirmAction(
            `删除规则 ${rule.name}？`,
            '删除后还需要保存草稿才会写到服务器。',
            true
          ).then((ok) => {
            if (!ok) return;
            const next = deleteRule(session.local, rule.id);
            props.onEdit(next.local, next.selectedRuleId);
          });
        }}
      >
        ×
      </Button>
    </Space>
  );
}

function RuleParseFields(props: {
  rule: EditableRule;
  diagnostics: TextPostprocessDiagnostic[];
  bodyOnly: boolean;
  disabled: boolean;
  parseDisabled: boolean;
  onChange: ChangeRule;
  onToggleFlag: (flag: string, enabled: boolean) => void;
}) {
  return (
    <Space direction="vertical" className="field-full">
      {props.bodyOnly ? <Alert type="info" showIcon message={RULE_FIELD_HELP.bodyOnly} /> : null}
      <Field
        label="正则"
        help={RULE_FIELD_HELP.pattern}
        value={props.rule.pattern}
        disabled={props.parseDisabled}
        diagnostics={props.diagnostics}
        field="pattern"
        onChange={(value) => props.onChange('pattern', value)}
      />
      <div className="text-postprocess-flags">
        <Typography.Text>flags</Typography.Text>
        {['g', 'i', 'm', 's', 'u'].map((flag) => (
          <label key={flag}>
            <input
              type="checkbox"
              checked={props.rule.flags.includes(flag)}
              disabled={props.parseDisabled}
              onChange={(event) => props.onToggleFlag(flag, event.target.checked)}
            />{' '}
            {flag}
          </label>
        ))}
        <Typography.Text type="secondary">{RULE_FIELD_HELP.flags}</Typography.Text>
      </div>
      <Field
        label="模板"
        help={RULE_FIELD_HELP.replacement}
        value={props.rule.replacement}
        disabled={props.parseDisabled}
        diagnostics={props.diagnostics}
        field="replacement"
        onChange={(value) => props.onChange('replacement', value)}
      />
    </Space>
  );
}

function RuleStyleFields(props: {
  rule: EditableRule;
  diagnostics: TextPostprocessDiagnostic[];
  bodyOnly: boolean;
  disabled: boolean;
  richReplyDefault: string | undefined;
  onChange: ChangeRule;
}) {
  return (
    <Space direction="vertical" className="field-full">
      {props.richReplyDefault ? (
        <Alert
          type="info"
          showIcon
          message="富回复独立样式"
          description={
            props.bodyOnly
              ? '此规则的样式只会作用于普通正文段落，选项、状态、记忆卡片内部不受影响。恢复默认不会影响其他四条规则。'
              : '此规则的样式只会作用于对应的选项、状态、记忆或对白组件。恢复默认不会影响其他四条规则。'
          }
          action={
            <Button
              size="small"
              disabled={props.disabled}
              onClick={() => props.onChange('css', props.richReplyDefault ?? '')}
            >
              恢复默认样式
            </Button>
          }
        />
      ) : null}
      <Field
        label="样式"
        help={props.bodyOnly ? RULE_FIELD_HELP.bodyCss : RULE_FIELD_HELP.css}
        value={props.rule.css}
        disabled={props.disabled}
        diagnostics={props.diagnostics}
        field="css"
        onChange={(value) => props.onChange('css', value)}
      />
    </Space>
  );
}

function RuleNotesFields(props: {
  rule: EditableRule;
  diagnostics: TextPostprocessDiagnostic[];
  disabled: boolean;
  onChange: ChangeRule;
}) {
  return (
    <Space direction="vertical" className="field-full">
      <Field
        label="描述"
        help="描述只帮助运营识别规则。"
        value={props.rule.description}
        disabled={props.disabled}
        diagnostics={props.diagnostics}
        field="description"
        onChange={(value) => props.onChange('description', value)}
      />
      <Field
        label="说明"
        help={RULE_FIELD_HELP.notes}
        value={props.rule.notes}
        disabled={props.disabled}
        diagnostics={props.diagnostics}
        field="notes"
        onChange={(value) => props.onChange('notes', value)}
      />
    </Space>
  );
}

function RuleTabs(props: {
  rule: EditableRule;
  diagnostics: TextPostprocessDiagnostic[];
  bodyOnly: boolean;
  parseDisabled: boolean;
  disabled: boolean;
  richReplyDefault: string | undefined;
  onChange: ChangeRule;
  onToggleFlag: (flag: string, enabled: boolean) => void;
}) {
  return (
    <Tabs
      key={props.bodyOnly ? 'body' : 'regular'}
      defaultActiveKey={props.bodyOnly ? 'css' : 'parse'}
      items={[
        {
          key: 'parse',
          label: '解析',
          children: (
            <RuleParseFields
              rule={props.rule}
              diagnostics={props.diagnostics}
              bodyOnly={props.bodyOnly}
              disabled={props.disabled}
              parseDisabled={props.parseDisabled}
              onChange={props.onChange}
              onToggleFlag={props.onToggleFlag}
            />
          ),
        },
        {
          key: 'css',
          label: '样式',
          children: (
            <RuleStyleFields
              rule={props.rule}
              diagnostics={props.diagnostics}
              bodyOnly={props.bodyOnly}
              disabled={props.disabled}
              richReplyDefault={props.richReplyDefault}
              onChange={props.onChange}
            />
          ),
        },
        {
          key: 'notes',
          label: '说明',
          children: (
            <RuleNotesFields
              rule={props.rule}
              diagnostics={props.diagnostics}
              disabled={props.disabled}
              onChange={props.onChange}
            />
          ),
        },
      ]}
    />
  );
}

function RuleStatusCard(props: { rule: EditableRule; bodyOnly: boolean }) {
  return (
    <div className="text-postprocess-match-card">
      <strong>
        {!props.rule.enabled ? '规则已停用' : props.bodyOnly ? '正文样式规则' : '规则已启用'}
      </strong>
      <Typography.Text type="secondary">
        {props.bodyOnly
          ? '正文规则只控制普通正文段落的样式。'
          : '保存草稿并发布后，规则才会进入正式回复处理链。'}
      </Typography.Text>
    </div>
  );
}

export function RuleEditor(props: {
  session: EnvSession;
  rule: EditableRule | null;
  disabled: boolean;
  onEdit: (local: EditableSource, selectedRuleId: string | null) => void;
  onIdDraft: (value: string) => void;
  onCommitId: () => void;
}) {
  if (!props.rule) {
    return (
      <section className="text-postprocess-column text-postprocess-editor">
        <div className="text-postprocess-column-head">
          <strong>编辑规则</strong>
        </div>
        <Empty description="选择或新建一条规则" />
      </section>
    );
  }
  const rule = props.rule;
  const idValue = props.session.idDraft?.ruleId === rule.id ? props.session.idDraft.value : rule.id;
  const diagnostics = props.session.apiDiagnostics.filter(
    (item) => item.rule_id === rule.id || item.rule_id === null
  );
  const position = props.session.local.rules.findIndex((item) => item.id === rule.id);
  const richReplyDefault = RICH_REPLY_RULE_STYLES[rule.id as keyof typeof RICH_REPLY_RULE_STYLES];
  const bodyOnly = isBodyStyleRule(rule.id);
  const parseDisabled = props.disabled || bodyOnly;
  const change: ChangeRule = (field, value) => {
    props.onEdit(updateRuleField(props.session.local, rule.id, field, value), rule.id);
  };
  const toggleFlag = (flag: string, enabled: boolean) => {
    const flags = new Set(rule.flags.split(''));
    if (enabled) flags.add(flag);
    else flags.delete(flag);
    change('flags', ['g', 'i', 'm', 's', 'u'].filter((item) => flags.has(item)).join(''));
  };

  return (
    <section className="text-postprocess-column text-postprocess-editor">
      <div className="text-postprocess-column-head">
        <div>
          <strong>编辑规则</strong>
          <Typography.Text type="secondary">
            #{String(position + 1).padStart(2, '0')} · {rule.enabled ? '已启用' : '已停用'}
          </Typography.Text>
        </div>
        <RuleActionButtons
          session={props.session}
          rule={rule}
          disabled={props.disabled}
          position={position}
          onEdit={props.onEdit}
        />
      </div>
      <Space direction="vertical" className="field-full">
        <div className="text-postprocess-name-row">
          <label className="text-postprocess-field">
            <span>名称</span>
            <Input
              aria-label="规则名称"
              value={rule.name}
              disabled={props.disabled}
              onChange={(event) => change('name', event.target.value)}
            />
          </label>
          <Switch
            checked={rule.enabled}
            disabled={props.disabled}
            checkedChildren="启用"
            unCheckedChildren="停用"
            aria-label="启用规则"
            onChange={(enabled) =>
              props.onEdit(setRuleEnabled(props.session.local, rule.id, enabled), rule.id)
            }
          />
        </div>
        <label className="text-postprocess-field">
          <span>稳定规则 ID（次级编辑）</span>
          <Input
            aria-label="规则编号"
            value={idValue}
            disabled={props.disabled}
            onChange={(event) => props.onIdDraft(event.target.value)}
            onBlur={props.onCommitId}
          />
        </label>
        <RuleTabs
          rule={rule}
          diagnostics={diagnostics}
          bodyOnly={bodyOnly}
          parseDisabled={parseDisabled}
          disabled={props.disabled}
          richReplyDefault={richReplyDefault}
          onChange={change}
          onToggleFlag={toggleFlag}
        />
        <RuleStatusCard rule={rule} bodyOnly={bodyOnly} />
      </Space>
    </section>
  );
}

function Field(props: {
  label: string;
  help: string;
  value: string;
  disabled: boolean;
  diagnostics: TextPostprocessDiagnostic[];
  field: string;
  rows?: number;
  onChange: (value: string) => void;
}) {
  const matched = props.diagnostics.filter((item) => item.field === props.field);
  return (
    <label className="text-postprocess-field">
      <span>{props.label}</span>
      <Input.TextArea
        aria-label={props.label}
        value={props.value}
        disabled={props.disabled}
        rows={props.rows ?? 4}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <Typography.Paragraph type="secondary">{props.help}</Typography.Paragraph>
      {matched.map((item, index) => (
        <Alert
          key={`${item.code}-${index}`}
          type="error"
          showIcon
          message={`${FIELD_LABEL[item.field] ?? item.field}：${item.code}`}
          description={diagnosticText(item)}
        />
      ))}
    </label>
  );
}
