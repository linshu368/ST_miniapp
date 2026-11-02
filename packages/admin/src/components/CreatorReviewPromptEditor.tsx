import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Input, Space, Tag, Typography } from 'antd';
import {
  CreatorReviewTestRequestSchema,
  type CreatorReviewTestData,
  type CreatorReviewTestRequest,
} from '@miniapp/shared';

const EXAMPLE_MATERIAL = `名称：旧书店的林舟
描述：一封旧信，和一段等待续写的重逢。
开场白：「你终于回来了。」他轻轻合上手里的书。
背景：林舟，32岁，书店店主。随和但敏锐，习惯用玩笑隐藏心事。角色只回应玩家，不代替玩家决定行动。
标签：日常、重逢`;

export function CreatorReviewPromptEditor(props: {
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onTest: (input: CreatorReviewTestRequest, signal?: AbortSignal) => Promise<CreatorReviewTestData>;
}) {
  const [material, setMaterial] = useState('');
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<{
    data: CreatorReviewTestData;
    prompt: string;
    material: string;
  } | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function test() {
    if (pending.current || props.disabled) return;
    const parsed = CreatorReviewTestRequestSchema.safeParse({
      prompt: props.value,
      material: {
        name: '',
        description: '',
        opening: '',
        tags: [],
        systemPrompt: material,
      },
    });
    if (!parsed.success) {
      setError('请填写审核规则正文和测试角色资料，并检查是否超出字数限制。');
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    setTesting(true);
    setCompleted(null);
    setError(null);
    try {
      const data = await props.onTest(parsed.data, controller.signal);
      if (!controller.signal.aborted) setCompleted({ data, prompt: props.value.trim(), material });
    } catch (err) {
      if (!controller.signal.aborted)
        setError(err instanceof Error ? err.message : '测试暂时未能完成，请稍后重试。');
    } finally {
      if (pending.current === controller) pending.current = null;
      if (!controller.signal.aborted) setTesting(false);
    }
  }

  const currentResult =
    completed?.prompt === props.value.trim() && completed.material === material
      ? completed.data.result
      : null;
  const disabled = props.disabled || testing;
  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      <Alert
        type="info"
        showIcon
        message="输出格式由系统固定"
        description={
          <>
            这里只编辑审核标准。审核结果固定包含是否通过（approved）和原因（reason），两个字段均必填，不能增加或更改。
            <Typography.Paragraph style={{ marginTop: 8, marginBottom: 0 }}>
              <Typography.Text code>
                {'{"approved": true, "reason": "符合公开要求"}'}
              </Typography.Text>
            </Typography.Paragraph>
          </>
        }
      />
      <Input.TextArea
        aria-label="角色卡审核规则正文"
        value={props.value}
        rows={16}
        maxLength={12000}
        showCount
        disabled={disabled}
        onChange={(event) => {
          props.onChange(event.target.value);
          setCompleted(null);
          setError(null);
        }}
      />
      <Card
        size="small"
        title="测试审核"
        extra={
          <Button
            size="small"
            type="text"
            disabled={disabled}
            onClick={() => {
              setMaterial(EXAMPLE_MATERIAL);
              setCompleted(null);
              setError(null);
            }}
          >
            填入示例
          </Button>
        }
      >
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            使用上方当前规则，无需保存或发布。测试不会修改或公开角色。
          </Typography.Paragraph>
          <Input.TextArea
            aria-label="测试角色资料"
            placeholder="粘贴要测试的角色资料，包括名称、描述、开场白、背景或预设。"
            rows={5}
            maxLength={250000}
            value={material}
            disabled={disabled}
            onChange={(event) => {
              setMaterial(event.target.value);
              setCompleted(null);
              setError(null);
            }}
          />
          <Button type="primary" loading={testing} disabled={disabled} onClick={() => void test()}>
            {testing ? '正在测试审核…' : '测试当前规则'}
          </Button>
          {error ? <Alert type="error" showIcon message="测试未完成" description={error} /> : null}
          {currentResult ? (
            <Alert
              type={currentResult.approved ? 'success' : 'warning'}
              showIcon
              message={currentResult.approved ? '审核通过' : '审核未通过'}
              description={
                <Space direction="vertical" size="small">
                  <span>{currentResult.reason}</span>
                  <Tag color="success">固定输出结构校验通过</Tag>
                </Space>
              }
            />
          ) : null}
        </Space>
      </Card>
    </Space>
  );
}
