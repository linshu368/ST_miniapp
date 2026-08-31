import { Alert, Button, Card, Input, Space, Typography } from 'antd';
import type { InviteCenterConfig } from '../lib/configSchemas';

const LINK_PLACEHOLDER = '{link}';

interface InviteCenterConfigEditorProps {
  value: InviteCenterConfig;
  disabled?: boolean;
  onChange: (value: InviteCenterConfig) => void;
}

export function InviteCenterConfigEditor(props: InviteCenterConfigEditorProps) {
  const templates = props.value.copy_templates;

  const updateTemplates = (next: string[]) =>
    props.onChange({ ...props.value, copy_templates: next });

  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      <Card size="small" title="邀请海报">
        <Space direction="vertical" size="small" className="field-full">
          <Input
            value={props.value.poster_url}
            placeholder="https://…（2160×3840 图片 URL）"
            disabled={props.disabled}
            onChange={(event) => props.onChange({ ...props.value, poster_url: event.target.value })}
          />
          <Typography.Text type="secondary">
            海报按 2160×3840（9:16）展示；先支持贴图片 URL，留空表示未发布，C 端会降级隐藏海报。
          </Typography.Text>
        </Space>
      </Card>

      <Card size="small" title="邀请文案库">
        <Space direction="vertical" size="middle" className="field-full">
          <Typography.Text type="secondary">
            C 端「刷新」按钮会在已发布文案中轮换；文案里的 {LINK_PLACEHOLDER}{' '}
            会被替换为用户专属邀请链接，建议每条都带上。至少保留 1 条文案。
          </Typography.Text>
          {templates.map((template, index) => (
            <div key={index}>
              <Space direction="vertical" size="small" className="field-full">
                <Space>
                  <Typography.Text strong>文案 {index + 1}</Typography.Text>
                  <Button
                    danger
                    size="small"
                    disabled={props.disabled || templates.length <= 1}
                    onClick={() =>
                      updateTemplates(templates.filter((_, itemIndex) => itemIndex !== index))
                    }
                  >
                    删除
                  </Button>
                </Space>
                <Input.TextArea
                  rows={3}
                  maxLength={1000}
                  showCount
                  value={template}
                  disabled={props.disabled}
                  onChange={(event) => {
                    const next = [...templates];
                    next[index] = event.target.value;
                    updateTemplates(next);
                  }}
                />
                {template.includes(LINK_PLACEHOLDER) ? null : (
                  <Alert
                    type="warning"
                    showIcon
                    message={`这条文案没有 ${LINK_PLACEHOLDER} 占位符，用户复制时不会带上专属邀请链接。`}
                  />
                )}
              </Space>
            </div>
          ))}
          <Button
            block
            disabled={props.disabled}
            onClick={() => updateTemplates([...templates, ''])}
          >
            添加文案
          </Button>
        </Space>
      </Card>
    </Space>
  );
}
