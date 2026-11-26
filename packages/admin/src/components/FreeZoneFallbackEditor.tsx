import { Input, InputNumber, Radio, Switch, Typography } from 'antd';
import { FreeZoneFallbackSchema, type FreeZoneFallback } from '@miniapp/shared';

const DEFAULT_FALLBACK: FreeZoneFallback = FreeZoneFallbackSchema.parse({});

/**
 * 畅聊专用兜底：只管畅聊轮次（首字前兜底、出字后擦掉重写），和模型目录里付费档位的兜底分开。
 * 关掉（null）就沿用付费档位的兜底。
 */
export function FreeZoneFallbackEditor(props: {
  value: FreeZoneFallback | null;
  disabled?: boolean;
  onChange: (value: FreeZoneFallback | null) => void;
}) {
  const { value, onChange } = props;
  const on = value !== null;
  const patch = (next: Partial<FreeZoneFallback>) =>
    onChange({ ...(value ?? DEFAULT_FALLBACK), ...next });
  return (
    <>
      <div>
        <Switch
          checked={on}
          disabled={props.disabled}
          onChange={(checked) => onChange(checked ? DEFAULT_FALLBACK : null)}
        />{' '}
        <Typography.Text strong>
          {on ? '畅聊用自己的兜底' : '沿用付费档位兜底（模型目录）'}
        </Typography.Text>
      </div>
      {on ? (
        <>
          <div>
            <Typography.Text strong>Surplus 模型</Typography.Text>
            <Input
              className="field-full"
              value={value.surplus_model}
              disabled={props.disabled}
              placeholder="deepseek-v4.1-flash-1017"
              onChange={(event) => patch({ surplus_model: event.target.value.trim() })}
            />
            <Typography.Text type="secondary">
              不设折扣底线，原价也照样兜底；不计连续拒单，也没有上下架。
            </Typography.Text>
          </div>
          <div>
            <Typography.Text strong>优先供应商</Typography.Text>
            <Input
              className="field-full"
              value={value.preferred_provider ?? ''}
              disabled={props.disabled}
              placeholder="留空不排序"
              onChange={(event) =>
                patch({ preferred_provider: event.target.value.trim().toLowerCase() || null })
              }
            />
            <Typography.Text type="secondary">
              有它的卖家先用它，没有就让 Surplus 自己挑。屏蔽渠道和阿里（dashscope-cn）一律不派。
            </Typography.Text>
          </div>
          <div>
            <Typography.Text strong>派单方式</Typography.Text>
            <div>
              <Radio.Group
                value={value.route_objective}
                disabled={props.disabled}
                onChange={(event) => patch({ route_objective: event.target.value })}
              >
                <Radio.Button value="latency">速度优先</Radio.Button>
                <Radio.Button value="reliability">成功率优先</Radio.Button>
              </Radio.Group>
            </div>
          </div>
          <div>
            <Typography.Text strong>价格带（%）</Typography.Text>
            <InputNumber
              className="field-full"
              min={0}
              max={10000}
              precision={0}
              value={value.price_tolerance_pct}
              disabled={props.disabled}
              onChange={(next) => patch({ price_tolerance_pct: (next as number | null) ?? 0 })}
            />
            <Typography.Text type="secondary">
              比最便宜的报价贵这么多以内都按上面的方式挑；更贵的排在后面，失败时仍会轮到。
            </Typography.Text>
          </div>
        </>
      ) : null}
    </>
  );
}
