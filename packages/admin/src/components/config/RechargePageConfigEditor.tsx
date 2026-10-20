import { Card, Col, ColorPicker, Input, Row, Space, Tag, Typography } from 'antd';
import type { PaymentPlan, RechargePageConfig } from '@miniapp/shared';

interface RechargePageConfigEditorProps {
  value: RechargePageConfig;
  plans: PaymentPlan[];
  disabled?: boolean;
  onChange: (value: RechargePageConfig) => void;
}

type RechargeColorKey =
  | 'theme_color'
  | 'balance_color'
  | 'selected_plan_color'
  | 'badge_color'
  | 'button_color';

const colorFields: Array<{ key: RechargeColorKey; label: string }> = [
  { key: 'theme_color', label: '顶部主题色' },
  { key: 'balance_color', label: '余额区域颜色' },
  { key: 'selected_plan_color', label: '套餐选中颜色' },
  { key: 'badge_color', label: '套餐标签颜色' },
  { key: 'button_color', label: '支付按钮颜色' },
];

export function RechargePageConfigEditor(props: RechargePageConfigEditorProps) {
  const update = (patch: Partial<RechargePageConfig>) =>
    props.onChange({ ...props.value, ...patch });

  return (
    <Row gutter={[20, 20]} align="top">
      <Col xs={24} xl={14}>
        <Card size="small" title="充值页面内容">
          <Space direction="vertical" size="middle" className="field-full">
            <div>
              <Typography.Text>页面主标题</Typography.Text>
              <Input
                maxLength={30}
                showCount
                value={props.value.title}
                disabled={props.disabled}
                onChange={(event) => update({ title: event.target.value })}
              />
            </div>
            <div>
              <Typography.Text>页面说明</Typography.Text>
              <Input.TextArea
                rows={3}
                maxLength={120}
                showCount
                value={props.value.description}
                disabled={props.disabled}
                onChange={(event) => update({ description: event.target.value })}
              />
            </div>
            <div>
              <Typography.Text>支付按钮文字</Typography.Text>
              <Input
                maxLength={20}
                showCount
                value={props.value.button_text}
                disabled={props.disabled}
                onChange={(event) => update({ button_text: event.target.value })}
              />
            </div>
            <div>
              <Typography.Text>订单等待页到账提示</Typography.Text>
              <Input.TextArea
                rows={2}
                maxLength={80}
                showCount
                value={props.value.pending_arrival_hint}
                disabled={props.disabled}
                onChange={(event) => update({ pending_arrival_hint: event.target.value })}
              />
            </div>
            <div className="recharge-color-grid">
              {colorFields.map((field) => (
                <div key={field.key}>
                  <Typography.Text>{field.label}</Typography.Text>
                  <div className="recharge-color-control">
                    <ColorPicker
                      value={props.value[field.key]}
                      disabled={props.disabled}
                      showText
                      onChangeComplete={(color) => update({ [field.key]: color.toHexString() })}
                    />
                    <span
                      className="recharge-color-swatch"
                      style={{ backgroundColor: props.value[field.key] }}
                      aria-label={`${field.label} ${props.value[field.key]}`}
                    />
                    <Typography.Text code>{props.value[field.key]}</Typography.Text>
                  </div>
                </div>
              ))}
            </div>
          </Space>
        </Card>
      </Col>
      <Col xs={24} xl={10}>
        <Card size="small" title="移动端实时预览">
          <div className="recharge-phone-preview">
            <div className="recharge-phone-screen">
              <div
                className="recharge-preview-header"
                style={{ backgroundColor: props.value.theme_color }}
              >
                <Typography.Title level={3}>{props.value.title || '星尘商店'}</Typography.Title>
                <Typography.Text>{props.value.description || '页面说明'}</Typography.Text>
              </div>
              <div className="recharge-preview-body">
                <div
                  className="recharge-preview-balance"
                  style={{
                    borderColor: props.value.balance_color,
                    backgroundColor: `${props.value.balance_color}1f`,
                  }}
                >
                  <Typography.Text type="secondary">当前星尘余额</Typography.Text>
                  <strong>1,280</strong>
                </div>
                <div className="recharge-preview-plans">
                  {props.plans.slice(0, 4).map((plan, index) => (
                    <div
                      key={plan.id}
                      className="recharge-preview-plan"
                      style={
                        index === 0
                          ? {
                              borderColor: props.value.selected_plan_color,
                              backgroundColor: `${props.value.selected_plan_color}14`,
                              boxShadow: `0 0 0 1px ${props.value.selected_plan_color}`,
                            }
                          : undefined
                      }
                    >
                      <strong>{plan.credits_amount + plan.bonus_credits} 星尘</strong>
                      <span>¥{(plan.price_cents / 100).toFixed(0)}</span>
                      {plan.badge_text ? (
                        <Tag color={props.value.badge_color}>{plan.badge_text}</Tag>
                      ) : null}
                    </div>
                  ))}
                </div>
                <button
                  type="button"
                  className="recharge-preview-button"
                  style={{ backgroundColor: props.value.button_color }}
                >
                  {props.value.button_text || '立即支付'}
                </button>
              </div>
            </div>
          </div>
        </Card>
      </Col>
    </Row>
  );
}
