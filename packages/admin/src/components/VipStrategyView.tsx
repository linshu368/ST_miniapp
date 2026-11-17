import { PlanEditor, CheckinRewardEditor } from './VipPlanEditor';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Divider,
  InputNumber,
  List,
  Modal,
  Space,
  Switch,
  Tag,
  Typography,
} from 'antd';
import {
  DEFAULT_FEATURE_FREE_TRIAL_LIMITS,
  DEFAULT_VIP_CHECKIN_BONUS_CONFIG,
  DEFAULT_VIP_PLANS_CONFIG,
  DEFAULT_VIP_TEXT_DISCOUNT_RATE,
  FeatureFreeTrialLimitsSchema,
  VipCheckinBonusConfigSchema,
  VipPlansConfigSchema,
  VipTextDiscountRateSchema,
  type FeatureFreeTrialLimits,
  type VipCheckinBonusConfig,
  type VipPlansConfig,
  type VipStrategyConfigKey,
} from '@miniapp/shared';
import {
  discardDraft,
  publishDraft,
  rollbackRelease,
  saveDraft,
  type ConfigDraft,
  type ConfigRelease,
  type ManagedConfig,
} from '@miniapp/admin-client';
import {
  configMetadata,
  parseManagedConfig,
  resolveManagedWorkingValue,
} from '@miniapp/admin-client';
import type { AdminEnvironment } from '../lib/environment';

function confirmWrite(
  environment: AdminEnvironment,
  title: string,
  before: unknown,
  after: unknown
): Promise<boolean> {
  const production = environment === 'production';
  return new Promise((resolve) => {
    Modal.confirm({
      title: `${production ? '生产环境：' : ''}${title}`,
      content: (
        <div>
          <Typography.Paragraph>
            {production ? '此操作会影响线上配置，请确认变更内容。' : '请确认本次变更内容。'}
          </Typography.Paragraph>
          <Typography.Text type="secondary">变更前</Typography.Text>
          <pre className="diff-preview">{JSON.stringify(before, null, 2)}</pre>
          <Typography.Text type="secondary">变更后</Typography.Text>
          <pre className="diff-preview">{JSON.stringify(after, null, 2)}</pre>
        </div>
      ),
      okText: '确认',
      cancelText: '取消',
      okButtonProps: production ? { danger: true } : undefined,
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

function StrategyKeyCard(props: {
  configKey: VipStrategyConfigKey;
  client: SupabaseClient;
  environment: AdminEnvironment;
  canWrite: boolean;
  configs: ManagedConfig[];
  drafts: ConfigDraft[];
  releases: ConfigRelease[];
  onReload: () => Promise<void>;
  children: (value: unknown, onChange: (next: unknown) => void) => ReactNode;
}) {
  const { message } = AntApp.useApp();
  const [saving, setSaving] = useState(false);
  const config = props.configs.find((item) => item.key === props.configKey);
  const draft = props.drafts.find(
    (item) => item.config_key === props.configKey && item.status === 'draft'
  );
  const releases = props.releases.filter((item) => item.config_key === props.configKey);
  const resolved = useMemo(
    () =>
      resolveManagedWorkingValue({
        key: props.configKey,
        draft,
        config,
      }),
    [config, draft, props.configKey]
  );
  const signature = JSON.stringify(resolved);
  const [value, setValue] = useState(resolved);

  useEffect(() => {
    setValue(structuredClone(resolved));
  }, [resolved, signature]);

  const save = async () => {
    if (!props.canWrite) return;
    setSaving(true);
    try {
      const parsed = parseManagedConfig(props.configKey, value);
      const before = resolveManagedWorkingValue({
        key: props.configKey,
        draft,
        config,
      });
      if (!(await confirmWrite(props.environment, '保存草稿', before, parsed))) return;
      await saveDraft({
        client: props.client,
        environment: props.environment,
        key: props.configKey,
        value: parsed,
        description: configMetadata[props.configKey].description,
      });
      message.success('草稿已保存');
      await props.onReload();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '草稿保存失败');
    } finally {
      setSaving(false);
    }
  };

  const publish = async () => {
    if (!props.canWrite || !draft) return;
    setSaving(true);
    try {
      const published = resolveManagedWorkingValue({
        key: props.configKey,
        draft: null,
        config,
      });
      parseManagedConfig(props.configKey, draft.value);
      if (!(await confirmWrite(props.environment, '发布配置', published, draft.value))) return;
      await publishDraft(props.client, draft.id);
      message.success('已发布');
      await props.onReload();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '发布失败');
    } finally {
      setSaving(false);
    }
  };

  const discard = async () => {
    if (!props.canWrite || !draft) return;
    setSaving(true);
    try {
      await discardDraft(props.client, draft.id);
      message.success('草稿已放弃');
      await props.onReload();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '放弃草稿失败');
    } finally {
      setSaving(false);
    }
  };

  const rollback = async (release: ConfigRelease) => {
    if (!props.canWrite) return;
    setSaving(true);
    try {
      const current = resolveManagedWorkingValue({
        key: props.configKey,
        draft: null,
        config,
      });
      if (!(await confirmWrite(props.environment, '回滚配置', current, release.value))) return;
      await rollbackRelease(props.client, release.id);
      message.success('已回滚并发布为新版本');
      await props.onReload();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '回滚失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card
      title={configMetadata[props.configKey].label}
      extra={
        <Space>
          <Tag>正式版本 {config?.version ?? 0}</Tag>
          {draft ? <Tag color="orange">有未发布草稿</Tag> : <Tag>已同步</Tag>}
        </Space>
      }
    >
      <Typography.Paragraph type="secondary">
        {configMetadata[props.configKey].description}
      </Typography.Paragraph>
      {props.children(value, setValue)}
      <Divider />
      <Space wrap>
        <Button
          type="primary"
          loading={saving}
          disabled={!props.canWrite}
          onClick={() => void save()}
        >
          保存草稿
        </Button>
        <Button
          danger={props.environment === 'production'}
          loading={saving}
          disabled={!props.canWrite || !draft}
          onClick={() => void publish()}
        >
          发布当前草稿
        </Button>
        <Button
          danger
          loading={saving}
          disabled={!props.canWrite || !draft}
          onClick={() => void discard()}
        >
          放弃当前草稿
        </Button>
      </Space>
      <Divider>该配置发布历史</Divider>
      {releases.length === 0 ? (
        <Typography.Text type="secondary">暂无发布记录</Typography.Text>
      ) : (
        <List
          dataSource={releases.slice(0, 5)}
          renderItem={(release) => (
            <List.Item
              actions={[
                <Button
                  key="rollback"
                  size="small"
                  disabled={!props.canWrite}
                  onClick={() => void rollback(release)}
                >
                  回滚到此版本
                </Button>,
              ]}
            >
              <List.Item.Meta title={`运行时版本 ${release.runtime_version}`} />
            </List.Item>
          )}
        />
      )}
    </Card>
  );
}

function asPlans(value: unknown): VipPlansConfig {
  const parsed = VipPlansConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : structuredClone(DEFAULT_VIP_PLANS_CONFIG);
}

function asCheckin(value: unknown): VipCheckinBonusConfig {
  const parsed = VipCheckinBonusConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : DEFAULT_VIP_CHECKIN_BONUS_CONFIG;
}

function asLimits(value: unknown): FeatureFreeTrialLimits {
  const parsed = FeatureFreeTrialLimitsSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...DEFAULT_FEATURE_FREE_TRIAL_LIMITS };
}

export function VipStrategyView(props: {
  client: SupabaseClient;
  environment: AdminEnvironment;
  canWrite: boolean;
  configs: ManagedConfig[];
  drafts: ConfigDraft[];
  releases: ConfigRelease[];
  onReload: () => Promise<void>;
}) {
  const shared = {
    client: props.client,
    environment: props.environment,
    canWrite: props.canWrite,
    configs: props.configs,
    drafts: props.drafts,
    releases: props.releases,
    onReload: props.onReload,
  };

  return (
    <Space direction="vertical" size="middle" className="editor-stack">
      <Card title="VIP策略">
        <Typography.Paragraph type="secondary">
          管理当前{props.environment === 'production' ? '生产' : '测试'}
          环境的 VIP 购买、商品、生成折扣、签到绝对额和媒体免费次数。保存草稿不会立即生效。
          价格只按整数分发布，页面上的元仅用于对照。
        </Typography.Paragraph>
        {!props.canWrite ? (
          <Alert type="info" showIcon message="当前账号只能查看，不能保存或发布。" />
        ) : null}
      </Card>

      <Typography.Title level={4}>功能开关</Typography.Title>
      <StrategyKeyCard {...shared} configKey="vip_purchase_enabled">
        {(value, onChange) => (
          <Space>
            <Switch checked={value === true} disabled={!props.canWrite} onChange={onChange} />
            <Typography.Text>{value === true ? '允许购买 VIP' : 'VIP 购买关闭'}</Typography.Text>
          </Space>
        )}
      </StrategyKeyCard>
      <StrategyKeyCard {...shared} configKey="vip_reminders_enabled">
        {(value, onChange) => (
          <Space direction="vertical">
            <Space>
              <Switch checked={value === true} disabled={!props.canWrite} onChange={onChange} />
              <Typography.Text>{value === true ? '到期提醒开启' : '到期提醒关闭'}</Typography.Text>
            </Space>
            <Typography.Text type="secondary">
              本页不配置提前天数、提醒文案或时区。开关默认关闭。
            </Typography.Text>
          </Space>
        )}
      </StrategyKeyCard>

      <Typography.Title level={4}>周卡 / 月卡商品</Typography.Title>
      <StrategyKeyCard {...shared} configKey="vip_plans_config">
        {(value, onChange) => {
          const plans = asPlans(value);
          const invalid = !VipPlansConfigSchema.safeParse(value).success;
          return (
            <Space direction="vertical" className="editor-stack">
              {invalid ? (
                <Alert
                  type="warning"
                  showIcon
                  message="当前商品配置无法解析，编辑区已载入安全默认值。"
                />
              ) : null}
              <PlanEditor
                label="周卡"
                value={plans.week}
                disabled={!props.canWrite}
                lockBonus
                onChange={(week) =>
                  onChange({ ...plans, week: { ...week, bonus_credits: 0, bonus_main_credits: 0 } })
                }
              />
              <PlanEditor
                label="月卡"
                value={plans.month}
                disabled={!props.canWrite}
                lockBonus={false}
                onChange={(month) => onChange({ ...plans, month })}
              />
            </Space>
          );
        }}
      </StrategyKeyCard>

      <Typography.Title level={4}>生成折扣</Typography.Title>
      <StrategyKeyCard {...shared} configKey="vip_text_discount_rate">
        {(value, onChange) => {
          const rate = VipTextDiscountRateSchema.safeParse(value).success
            ? (value as number)
            : DEFAULT_VIP_TEXT_DISCOUNT_RATE;
          return (
            <Space direction="vertical">
              <InputNumber
                min={0.000001}
                max={1}
                step={0.01}
                disabled={!props.canWrite}
                value={rate}
                onChange={(next) => {
                  if (typeof next === 'number') onChange(next);
                }}
              />
              <Typography.Text type="secondary">1 表示不打折，0.95 表示 95 折。</Typography.Text>
            </Space>
          );
        }}
      </StrategyKeyCard>

      <Typography.Title level={4}>签到奖励</Typography.Title>
      <StrategyKeyCard {...shared} configKey="vip_checkin_bonus_config">
        {(value, onChange) => (
          <CheckinRewardEditor
            value={asCheckin(value)}
            disabled={!props.canWrite}
            onChange={onChange}
          />
        )}
      </StrategyKeyCard>

      <Typography.Title level={4}>媒体免费次数</Typography.Title>
      <StrategyKeyCard {...shared} configKey="feature_free_trial_limits">
        {(value, onChange) => {
          const limits = asLimits(value);
          const update = (patch: Partial<FeatureFreeTrialLimits>) =>
            onChange({ ...limits, ...patch });
          return (
            <Space direction="vertical">
              <Typography.Text>语音免费次数</Typography.Text>
              <InputNumber
                min={0}
                max={20}
                precision={0}
                disabled={!props.canWrite}
                value={limits.voice}
                onChange={(next) => {
                  if (typeof next === 'number') update({ voice: next });
                }}
              />
              <Typography.Text>初级图片免费次数</Typography.Text>
              <InputNumber
                min={0}
                max={20}
                precision={0}
                disabled={!props.canWrite}
                value={limits.basic_image}
                onChange={(next) => {
                  if (typeof next === 'number') update({ basic_image: next });
                }}
              />
              <Typography.Text type="secondary">
                0 表示关闭对应功能的免费体验。两项互不影响。
              </Typography.Text>
            </Space>
          );
        }}
      </StrategyKeyCard>
    </Space>
  );
}
