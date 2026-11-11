import { useState } from 'react';
import { Button, Empty, Input, Modal, Select, Space, Switch, Typography } from 'antd';
import {
  STARTER_RULES,
  blankRule,
  type EditableRule,
  type EditableSource,
} from '../../lib/textPostprocessTemplates';
import {
  createRuleId,
  filterRules,
  insertRule,
  setRuleEnabled,
  type EnvSession,
} from '../../lib/textPostprocessWorkbench';

function RuleItem(props: {
  rule: EditableRule;
  position: number;
  selected: string | null;
  disabled: boolean;
  onSelect: (ruleId: string) => void;
  onToggle: (ruleId: string, enabled: boolean) => void;
}) {
  const { rule } = props;
  return (
    <div
      className={
        rule.id === props.selected ? 'text-postprocess-rule is-selected' : 'text-postprocess-rule'
      }
    >
      <button type="button" onClick={() => props.onSelect(rule.id)}>
        <span className="text-postprocess-rule-top">
          <strong>{rule.name || rule.id}</strong>
          <small>#{String(props.position + 1).padStart(2, '0')}</small>
        </span>
        <span className="text-postprocess-rule-description">
          {rule.description || '自定义后处理规则'}
        </span>
        <span className="text-postprocess-rule-bottom">
          <span>{rule.enabled ? '已启用' : '已停用'}</span>
          <span>{rule.enabled ? '发布后生效' : '不参与处理'}</span>
        </span>
      </button>
      <Switch
        className="text-postprocess-rule-switch"
        size="small"
        aria-label={`${rule.name || rule.id} 启用`}
        checked={rule.enabled}
        disabled={props.disabled}
        onChange={(enabled) => props.onToggle(rule.id, enabled)}
      />
    </div>
  );
}

function NewRuleModal(props: {
  open: boolean;
  disabled: boolean;
  existingIds: string[];
  onCancel: () => void;
  onCreate: (rule: EditableRule) => void;
}) {
  const [templateId, setTemplateId] = useState('dialogue');
  const [newName, setNewName] = useState('对白');
  const create = () => {
    const template = STARTER_RULES.find((item) => item.id === templateId);
    const id =
      template && !props.existingIds.includes(template.id)
        ? template.id
        : createRuleId(props.existingIds);
    const base = template ? { ...template } : blankRule(id);
    props.onCreate({ ...base, id, name: newName.trim() || base.name, enabled: false });
  };

  return (
    <Modal
      title="新建回复规则"
      open={props.open}
      onCancel={props.onCancel}
      onOk={create}
      okText="创建"
      okButtonProps={{ disabled: props.disabled }}
    >
      <Space direction="vertical" className="field-full">
        <Typography.Text type="secondary">选择起点后创建；新规则默认停用。</Typography.Text>
        <div className="text-postprocess-template-grid">
          {[...STARTER_RULES, null].map((item) => {
            const id = item?.id ?? 'custom';
            return (
              <button
                key={id}
                type="button"
                className={templateId === id ? 'is-selected' : ''}
                onClick={() => {
                  setTemplateId(id);
                  setNewName(item?.name ?? '自定义规则');
                }}
                aria-pressed={templateId === id}
              >
                <strong>{item?.name ?? '自定义'}</strong>
                <span>{item?.description ?? '从空白规则开始'}</span>
              </button>
            );
          })}
        </div>
        <Input
          aria-label="新规则名称"
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="规则名称"
        />
      </Space>
    </Modal>
  );
}

export function RuleList(props: {
  session: EnvSession;
  disabled: boolean;
  onSelect: (ruleId: string) => void;
  onEdit: (local: EditableSource, selectedRuleId: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [newRuleOpen, setNewRuleOpen] = useState(false);
  const visible = filterRules(props.session.local.rules, query, status);
  const selected = props.session.selectedRuleId;
  const add = (rule: EditableRule) => {
    props.onEdit(insertRule(props.session.local, rule, selected), rule.id);
    setNewRuleOpen(false);
  };

  return (
    <section className="text-postprocess-column text-postprocess-rules-column">
      <div className="text-postprocess-column-head">
        <div>
          <strong>规则</strong>
          <Typography.Text type="secondary">
            {props.session.local.rules.length} 条 · 按顺序执行
          </Typography.Text>
        </div>
        <Button
          type="primary"
          size="small"
          disabled={props.disabled}
          onClick={() => setNewRuleOpen(true)}
        >
          + 新建
        </Button>
      </div>
      <Space direction="vertical" className="field-full">
        <Input
          aria-label="搜索规则"
          placeholder="搜索名称、编号或正则"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select
          aria-label="按状态筛选"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: '全部状态' },
            { value: 'enabled', label: '只看启用' },
            { value: 'disabled', label: '只看停用' },
          ]}
        />
        {visible.length === 0 ? <Empty description="没有匹配的规则" /> : null}
        <div className="text-postprocess-rules">
          {visible.map((rule) => (
            <RuleItem
              key={rule.id}
              rule={rule}
              position={props.session.local.rules.indexOf(rule)}
              selected={selected}
              disabled={props.disabled}
              onSelect={props.onSelect}
              onToggle={(ruleId, enabled) =>
                props.onEdit(setRuleEnabled(props.session.local, ruleId, enabled), selected)
              }
            />
          ))}
        </div>
        {selected && !visible.some((rule) => rule.id === selected) ? (
          <Typography.Text type="secondary">
            当前选中的规则被筛选隐藏，编辑区仍对应该规则编号。
          </Typography.Text>
        ) : null}
      </Space>
      <NewRuleModal
        open={newRuleOpen}
        disabled={props.disabled}
        existingIds={props.session.local.rules.map((rule) => rule.id)}
        onCancel={() => setNewRuleOpen(false)}
        onCreate={add}
      />
    </section>
  );
}
