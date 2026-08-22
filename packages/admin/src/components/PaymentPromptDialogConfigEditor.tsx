import { Card, Col, ColorPicker, Input, Row, Space, Switch, Tag, Typography } from 'antd';
import type { PaymentPromptDialogConfig } from '@miniapp/shared';

interface PaymentPromptDialogConfigEditorProps {
  value: PaymentPromptDialogConfig;
  disabled?: boolean;
  onChange: (value: PaymentPromptDialogConfig) => void;
}

export function PaymentPromptDialogConfigEditor(props: PaymentPromptDialogConfigEditorProps) {
  const update = (patch: Partial<PaymentPromptDialogConfig>) =>
    props.onChange({ ...props.value, ...patch });

  return (
    <Row gutter={[20, 20]} align="top">
      <Col xs={24} xl={14}>
        <Card size="small" title="支付提示弹窗内容">
          <Space direction="vertical" size="middle" className="field-full">
            <div className="payment-prompt-enabled-row">
              <div>
                <Typography.Text strong>启用支付前提醒</Typography.Text>
                <br />
                <Typography.Text type="secondary">
                  关闭后，点击“立即支付”会直接创建订单并打开支付页。
                </Typography.Text>
              </div>
              <Switch
                checked={props.value.enabled}
                disabled={props.disabled}
                onChange={(enabled) => update({ enabled })}
              />
            </div>
            <div>
              <Typography.Text>弹窗标题</Typography.Text>
              <Input
                maxLength={40}
                showCount
                value={props.value.title}
                disabled={props.disabled}
                onChange={(event) => update({ title: event.target.value })}
              />
            </div>
            <div>
              <Typography.Text>说明文案（支持换行）</Typography.Text>
              <Input.TextArea
                rows={4}
                maxLength={200}
                showCount
                value={props.value.description}
                disabled={props.disabled}
                onChange={(event) => update({ description: event.target.value })}
              />
            </div>
            <div>
              <Typography.Text>底部提示文案（支持换行）</Typography.Text>
              <Input.TextArea
                rows={2}
                maxLength={100}
                showCount
                value={props.value.footer_note}
                disabled={props.disabled}
                onChange={(event) => update({ footer_note: event.target.value })}
              />
            </div>
            <div>
              <Typography.Text>确认按钮文字</Typography.Text>
              <Input
                maxLength={30}
                showCount
                value={props.value.confirm_text}
                disabled={props.disabled}
                onChange={(event) => update({ confirm_text: event.target.value })}
              />
            </div>
            <div>
              <Typography.Text>统一强调色</Typography.Text>
              <div className="recharge-color-control">
                <ColorPicker
                  value={props.value.accent_color}
                  disabled={props.disabled}
                  showText
                  onChangeComplete={(color) => update({ accent_color: color.toHexString() })}
                />
                <span
                  className="recharge-color-swatch"
                  style={{ backgroundColor: props.value.accent_color }}
                  aria-label={`统一强调色 ${props.value.accent_color}`}
                />
                <Typography.Text code>{props.value.accent_color}</Typography.Text>
              </div>
              <Typography.Text type="secondary">
                同时用于弹窗边框、顶部色条、警示图标和确认按钮。
              </Typography.Text>
            </div>
          </Space>
        </Card>
      </Col>

      <Col xs={24} xl={10}>
        <Card
          size="small"
          title="移动端实时预览"
          extra={
            <Tag color={props.value.enabled ? 'green' : 'default'}>
              {props.value.enabled ? '已启用' : '已停用'}
            </Tag>
          }
        >
          <div className="payment-prompt-phone-preview">
            <div className="payment-prompt-phone-screen">
              <div className="payment-prompt-page">
                <strong>星尘充值</strong>
                <span>选择适合你的星尘套餐，支付完成后即时到账。</span>
                {[100, 300, 680, 1280].map((credits) => (
                  <div key={credits} className="payment-prompt-plan">
                    <strong>{credits} 星尘</strong>
                    <span>立即到账</span>
                  </div>
                ))}
                <button type="button" style={{ backgroundColor: props.value.accent_color }}>
                  立即支付
                </button>
              </div>

              {props.value.enabled ? (
                <div className="payment-prompt-overlay">
                  <div
                    className="payment-prompt-dialog"
                    style={{ borderColor: props.value.accent_color }}
                  >
                    <div
                      className="payment-prompt-dialog-accent"
                      style={{ backgroundColor: props.value.accent_color }}
                    />
                    <div className="payment-prompt-dialog-content">
                      <span
                        className="payment-prompt-warning"
                        style={{
                          color: props.value.accent_color,
                          borderColor: props.value.accent_color,
                        }}
                      >
                        !
                      </span>
                      <strong>{props.value.title || '支付提示'}</strong>
                      <p>{props.value.description || '说明文案'}</p>
                      <button type="button" style={{ backgroundColor: props.value.accent_color }}>
                        {props.value.confirm_text || '继续支付'}
                      </button>
                      <small>{props.value.footer_note || '底部提示文案'}</small>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </Card>
      </Col>
    </Row>
  );
}
