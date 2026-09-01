import { useRef, useState } from 'react';
import { Alert, App as AntApp, Button, Card, Input, Space, Typography } from 'antd';
import type { InviteCenterConfig } from '../lib/configSchemas';

const LINK_PLACEHOLDER = '{link}';
const POSTER_ALLOWED_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const POSTER_MAX_BYTES = 10 * 1024 * 1024;

interface InviteCenterConfigEditorProps {
  value: InviteCenterConfig;
  disabled?: boolean;
  onChange: (value: InviteCenterConfig) => void;
  /** 上传海报图片并返回 public URL（由 App 注入，走 backend /api/admin/invite-poster）。 */
  onUploadPoster: (file: File) => Promise<string>;
}

export function InviteCenterConfigEditor(props: InviteCenterConfigEditorProps) {
  const { message } = AntApp.useApp();
  const posterFileInputRef = useRef<HTMLInputElement>(null);
  const [posterUploading, setPosterUploading] = useState(false);
  const templates = props.value.copy_templates;

  const updateTemplates = (next: string[]) =>
    props.onChange({ ...props.value, copy_templates: next });

  const handlePosterFile = async (file: File) => {
    if (!POSTER_ALLOWED_MIME_TYPES.includes(file.type)) {
      message.error('仅支持 PNG / JPG / WEBP 图片');
      return;
    }
    if (file.size > POSTER_MAX_BYTES) {
      message.error('图片不能超过 10 MB');
      return;
    }
    setPosterUploading(true);
    try {
      const posterUrl = await props.onUploadPoster(file);
      props.onChange({ ...props.value, poster_url: posterUrl });
      message.success('海报已上传并填入 URL，保存草稿并发布后 C 端生效');
    } catch (error) {
      message.error(error instanceof Error ? error.message : '邀请海报上传失败');
    } finally {
      setPosterUploading(false);
    }
  };

  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      <Card size="small" title="邀请海报">
        <Space direction="vertical" size="small" className="field-full">
          <input
            ref={posterFileInputRef}
            type="file"
            accept={POSTER_ALLOWED_MIME_TYPES.join(',')}
            style={{ display: 'none' }}
            onChange={(event) => {
              const file = event.target.files?.[0];
              // 立即清空 value，同一文件重选也能再次触发 onChange
              event.target.value = '';
              if (file) void handlePosterFile(file);
            }}
          />
          <Space wrap>
            <Button
              type="primary"
              loading={posterUploading}
              disabled={props.disabled}
              onClick={() => posterFileInputRef.current?.click()}
            >
              上传海报图片
            </Button>
            {props.value.poster_url ? (
              <Button
                danger
                disabled={props.disabled || posterUploading}
                onClick={() => props.onChange({ ...props.value, poster_url: '' })}
              >
                清空海报
              </Button>
            ) : null}
          </Space>
          <Input
            value={props.value.poster_url}
            placeholder="上传图片自动填入，也可手动粘贴图片 URL"
            disabled={props.disabled || posterUploading}
            onChange={(event) => props.onChange({ ...props.value, poster_url: event.target.value })}
          />
          {props.value.poster_url ? (
            <img
              src={props.value.poster_url}
              alt="邀请海报预览"
              style={{
                width: 135,
                aspectRatio: '9 / 16',
                objectFit: 'cover',
                borderRadius: 8,
                border: '1px solid rgba(5, 5, 5, 0.12)',
              }}
            />
          ) : null}
          <Typography.Text type="secondary">
            海报按 2160×3840（9:16）展示；支持上传 PNG / JPG / WEBP（不超过 10
            MB），上传成功后自动填入 URL，仍需保存草稿并发布。留空表示未发布，C 端会降级隐藏海报。
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
