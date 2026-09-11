import {
  Alert,
  AutoComplete,
  Button,
  Card,
  Col,
  Input,
  Row,
  Select,
  Space,
  Typography,
} from 'antd';
import type { OpenRouterModelDirectory } from '@miniapp/shared';

/**
 * 「模型 × 供应商」路由规则编辑器。
 *
 * 本地态刻意宽松（允许模型名暂空、供应商列表暂空），严格校验由保存草稿时的
 * LlmProviderRoutingConfigSchema 把关——与模型目录编辑器同一套「编辑宽、落库严」口径。
 */

interface EditableRule {
  openrouter_model_id: string;
  blocked_providers: string[];
  preferred_providers: string[];
  note: string;
}

interface EditableConfig {
  rules: EditableRule[];
}

/** 文档与历史数据里出现过的 OpenRouter 供应商 slug，仅作输入提示，不限制自由填写。 */
const COMMON_PROVIDER_SLUGS = [
  'alibaba',
  'deepinfra',
  'digitalocean',
  'fireworks',
  'friendli',
  'google-ai-studio',
  'google-vertex',
  'novita',
  'together',
];

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

export function normalizeProviderRoutingConfig(value: unknown): EditableConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { rules: [] };
  const rawRules = (value as { rules?: unknown }).rules;
  if (!Array.isArray(rawRules)) return { rules: [] };

  const rules = rawRules
    .filter((rule): rule is Record<string, unknown> => !!rule && typeof rule === 'object')
    .map((rule) => ({
      openrouter_model_id:
        typeof rule.openrouter_model_id === 'string' ? rule.openrouter_model_id : '',
      blocked_providers: toStringArray(rule.blocked_providers),
      preferred_providers: toStringArray(rule.preferred_providers),
      note: typeof rule.note === 'string' ? rule.note : '',
    }));
  return { rules };
}

export function ProviderRoutingConfigEditor(props: {
  value: unknown;
  disabled?: boolean;
  onChange: (value: unknown) => void;
  openRouterDirectory: OpenRouterModelDirectory | null;
}) {
  const config = normalizeProviderRoutingConfig(props.value);

  const modelOptions = (props.openRouterDirectory?.models ?? []).map((model) => ({
    value: model.id,
    label: `${model.id}（${model.name}）`,
  }));
  const providerOptions = COMMON_PROVIDER_SLUGS.map((slug) => ({ value: slug, label: slug }));

  const updateRule = (index: number, patch: Partial<EditableRule>) => {
    const next = structuredClone(config);
    next.rules[index] = { ...next.rules[index], ...patch };
    props.onChange(next);
  };

  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      <Alert
        type="info"
        showIcon
        message="规则按「模型 × 供应商」生效，不存在全局屏蔽"
        description={
          <>
            「屏蔽供应商」会写入 OpenRouter 请求的 provider.ignore，该模型完全不再走这些供应商；
            「优先供应商」会写入 provider.order 并允许兜底回落——优先列表试完后其余供应商仍可承接。
            两者可同时配置。供应商请填 OpenRouter 的 slug（如
            alibaba、google-vertex、google-ai-studio）。
          </>
        }
      />
      {config.rules.map((rule, index) => (
        <Card
          key={index}
          size="small"
          title={rule.openrouter_model_id || `规则 ${index + 1}（未选模型）`}
          extra={
            <Button
              danger
              size="small"
              disabled={props.disabled}
              onClick={() =>
                props.onChange({
                  rules: config.rules.filter((_, itemIndex) => itemIndex !== index),
                })
              }
            >
              删除
            </Button>
          }
        >
          <Row gutter={[12, 12]}>
            <Col xs={24}>
              <Typography.Text>模型（openrouter_model_id）</Typography.Text>
              <AutoComplete
                className="field-full"
                value={rule.openrouter_model_id}
                options={modelOptions}
                disabled={props.disabled}
                placeholder="如 deepseek/deepseek-chat-v3.2"
                filterOption={(input, option) =>
                  (option?.value ?? '').toLowerCase().includes(input.toLowerCase())
                }
                onChange={(value) => updateRule(index, { openrouter_model_id: value })}
              />
            </Col>
            <Col xs={24} md={12}>
              <Typography.Text>屏蔽供应商（provider.ignore）</Typography.Text>
              <Select
                mode="tags"
                className="field-full"
                value={rule.blocked_providers}
                options={providerOptions}
                disabled={props.disabled}
                placeholder="如 alibaba"
                tokenSeparators={[',', ' ']}
                onChange={(value) => updateRule(index, { blocked_providers: value })}
              />
            </Col>
            <Col xs={24} md={12}>
              <Typography.Text>优先供应商（provider.order，其余兜底）</Typography.Text>
              <Select
                mode="tags"
                className="field-full"
                value={rule.preferred_providers}
                options={providerOptions}
                disabled={props.disabled}
                placeholder="如 google-vertex"
                tokenSeparators={[',', ' ']}
                onChange={(value) => updateRule(index, { preferred_providers: value })}
              />
            </Col>
            <Col xs={24}>
              <Typography.Text>备注（屏蔽原因 / 数据依据 / 日期，供复盘）</Typography.Text>
              <Input
                value={rule.note}
                maxLength={200}
                disabled={props.disabled}
                placeholder="如：Alibaba 失败率 52.78%，2026-08 屏蔽"
                onChange={(event) => updateRule(index, { note: event.target.value })}
              />
            </Col>
          </Row>
        </Card>
      ))}
      <Button
        block
        disabled={props.disabled}
        onClick={() =>
          props.onChange({
            rules: [
              ...config.rules,
              {
                openrouter_model_id: '',
                blocked_providers: [],
                preferred_providers: [],
                note: '',
              } satisfies EditableRule,
            ],
          })
        }
      >
        添加路由规则
      </Button>
    </Space>
  );
}
