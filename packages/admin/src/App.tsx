import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient, User } from '@supabase/supabase-js';
import {
  Alert,
  App as AntApp,
  Button,
  Card,
  Descriptions,
  Divider,
  Empty,
  Layout,
  List,
  Menu,
  Modal,
  Result,
  Segmented,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from 'antd';
import { Refine } from '@refinedev/core';
import { dataProvider } from '@refinedev/supabase';
import {
  ModelCatalogSchema,
  type DisplayPricingConfig,
  type ModelCatalog,
  type OpenRouterModelDirectory,
} from '@miniapp/shared';
import { LoginPage } from './components/LoginPage';
import { ConfigValueEditor } from './components/ConfigValueEditor';
import {
  getAuditLogs,
  getCurrentAdmin,
  getDrafts,
  getManagedConfigs,
  getReleases,
  publishDraft,
  rollbackRelease,
  saveDraft,
  type AdminUser,
  type AuditLog,
  type ConfigDraft,
  type ConfigRelease,
  type ManagedConfig,
} from './lib/adminApi';
import {
  configMetadata,
  LlmPricingConfigSchema,
  managedConfigKeys,
  parseManagedConfig,
  type ManagedConfigKey,
} from './lib/configSchemas';
import { getAdminClient, isEnvironmentConfigured, type AdminEnvironment } from './lib/environment';
import { fetchOpenRouterModels, getOpenRouterCatalogIssues } from './lib/openRouterModels';
import { getModelCatalogChangeSummary } from './lib/modelCatalogDiff';

type ViewKey = 'configs' | 'releases' | 'audit';

function confirmAction(title: string, content: React.ReactNode, danger = false): Promise<boolean> {
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

function jsonPreview(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

interface ValueChange {
  path: string;
  before: unknown;
  after: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function collectValueChanges(
  before: unknown,
  after: unknown,
  path = '配置值',
  changes: ValueChange[] = []
): ValueChange[] {
  if (Object.is(before, after)) return changes;

  if (Array.isArray(before) && Array.isArray(after)) {
    const length = Math.max(before.length, after.length);
    for (let index = 0; index < length; index += 1) {
      collectValueChanges(before[index], after[index], `${path}[${index}]`, changes);
    }
    return changes;
  }

  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) {
      collectValueChanges(before[key], after[key], `${path}.${key}`, changes);
    }
    return changes;
  }

  changes.push({ path, before, after });
  return changes;
}

function getPreviousRelease(
  allReleases: ConfigRelease[],
  release: ConfigRelease
): ConfigRelease | undefined {
  return allReleases
    .filter(
      (candidate) =>
        candidate.config_key === release.config_key &&
        candidate.runtime_version < release.runtime_version
    )
    .sort((left, right) => right.runtime_version - left.runtime_version)[0];
}

function formatChangeValue(value: unknown): string {
  if (value === undefined) return '未设置';
  const serialized = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return serialized.length > 160 ? `${serialized.slice(0, 157)}…` : serialized;
}

function getReleaseChangeSummary(allReleases: ConfigRelease[], release: ConfigRelease): string {
  const previousRelease = getPreviousRelease(allReleases, release);
  if (!previousRelease) return '首次发布完整配置';
  if (release.config_key === 'llm_model_catalog') {
    const modelSummary = getModelCatalogChangeSummary(previousRelease.value, release.value);
    if (modelSummary) return modelSummary;
  }
  const changes = collectValueChanges(previousRelease.value, release.value);
  if (changes.length === 0) return '配置内容未变化';
  return `${changes.length} 项：${changes
    .slice(0, 2)
    .map((change) => change.path)
    .join('、')}${changes.length > 2 ? '…' : ''}`;
}

function ReleaseChangeDetails(props: {
  release: ConfigRelease;
  allReleases: ConfigRelease[];
  compact?: boolean;
}) {
  const previousRelease = getPreviousRelease(props.allReleases, props.release);
  if (!previousRelease) {
    return (
      <div className="release-change-details">
        <Typography.Text strong>首次发布的完整配置</Typography.Text>
        {!props.compact ? (
          <pre className="diff-preview">{jsonPreview(props.release.value)}</pre>
        ) : null}
      </div>
    );
  }

  const changes = collectValueChanges(previousRelease.value, props.release.value);
  const visibleChanges = props.compact ? changes.slice(0, 3) : changes;

  return (
    <div className="release-change-details">
      <Typography.Text strong>具体修改（{changes.length} 项）</Typography.Text>
      {changes.length === 0 ? (
        <Typography.Text type="secondary">配置内容未变化</Typography.Text>
      ) : (
        <div className="release-change-list">
          {visibleChanges.map((change, index) => (
            <div className="release-change-item" key={`${change.path}-${index}`}>
              <code>{change.path}</code>
              <span className="release-change-before">{formatChangeValue(change.before)}</span>
              <span aria-hidden>→</span>
              <span className="release-change-after">{formatChangeValue(change.after)}</span>
            </div>
          ))}
          {props.compact && changes.length > visibleChanges.length ? (
            <Typography.Text type="secondary">
              另有 {changes.length - visibleChanges.length} 项修改，请在“发布历史”中展开查看。
            </Typography.Text>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function AdminApp() {
  const [environment, setEnvironment] = useState<AdminEnvironment>('test');
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [admin, setAdmin] = useState<AdminUser | null>(null);
  const [loadingIdentity, setLoadingIdentity] = useState(true);
  const [identityError, setIdentityError] = useState<string | null>(null);
  const refineDataProvider = useMemo(() => (client ? dataProvider(client) : undefined), [client]);

  const loadIdentity = useCallback(async (targetClient: SupabaseClient) => {
    setLoadingIdentity(true);
    setIdentityError(null);
    try {
      const { data, error } = await targetClient.auth.getSession();
      if (error) throw error;
      const sessionUser = data.session?.user ?? null;
      setUser(sessionUser);
      if (!sessionUser) {
        setAdmin(null);
        return;
      }
      const currentAdmin = await getCurrentAdmin(targetClient, sessionUser.id);
      setAdmin(currentAdmin);
    } catch (error) {
      setAdmin(null);
      setIdentityError(error instanceof Error ? error.message : '无法校验后台权限');
    } finally {
      setLoadingIdentity(false);
    }
  }, []);

  useEffect(() => {
    if (!isEnvironmentConfigured(environment)) {
      setClient(null);
      setUser(null);
      setAdmin(null);
      setLoadingIdentity(false);
      return;
    }
    try {
      const nextClient = getAdminClient(environment);
      setClient(nextClient);
      void loadIdentity(nextClient);
    } catch (error) {
      setIdentityError(error instanceof Error ? error.message : 'Supabase 配置错误');
      setLoadingIdentity(false);
    }
  }, [environment, loadIdentity]);

  const switchEnvironment = async (nextEnvironment: AdminEnvironment) => {
    if (nextEnvironment === environment) return;
    if (
      nextEnvironment === 'production' &&
      !(await confirmAction(
        '切换到生产环境？',
        '生产环境的草稿、发布与回滚会影响线上用户。进入后所有写操作仍需再次确认。',
        true
      ))
    ) {
      return;
    }
    setEnvironment(nextEnvironment);
  };

  if (!isEnvironmentConfigured(environment)) {
    return (
      <Result
        status="warning"
        title={`${environment === 'test' ? '测试' : '生产'}环境未配置`}
        subTitle="请在 Vercel 或本地环境变量中配置对应的 Supabase URL、anon key 与后端 API 地址。"
        extra={
          <Segmented
            value={environment}
            options={[
              { label: '测试环境', value: 'test' },
              { label: '生产环境', value: 'production' },
            ]}
            onChange={(value) => void switchEnvironment(value as AdminEnvironment)}
          />
        }
      />
    );
  }

  if (loadingIdentity || !client) {
    return (
      <div className="center-screen">
        <Spin size="large" />
      </div>
    );
  }

  if (!user || !admin || !admin.display_name) {
    return (
      <>
        <div className="environment-login-switch">
          <Segmented
            value={environment}
            options={[
              { label: '测试环境', value: 'test' },
              { label: '生产环境', value: 'production' },
            ]}
            onChange={(value) => void switchEnvironment(value as AdminEnvironment)}
          />
        </div>
        {identityError ? (
          <Alert className="identity-alert" type="error" message={identityError} showIcon />
        ) : null}
        <LoginPage
          client={client}
          environment={environment}
          onAuthenticated={() => loadIdentity(client)}
        />
      </>
    );
  }

  return (
    <Refine dataProvider={refineDataProvider} resources={[]} options={{ syncWithLocation: false }}>
      <AdminWorkspace
        client={client}
        environment={environment}
        admin={admin}
        onEnvironmentChange={switchEnvironment}
        onLogout={async () => {
          await client.auth.signOut();
          await loadIdentity(client);
        }}
      />
    </Refine>
  );
}

function AdminWorkspace(props: {
  client: SupabaseClient;
  environment: AdminEnvironment;
  admin: AdminUser;
  onEnvironmentChange: (environment: AdminEnvironment) => Promise<void>;
  onLogout: () => Promise<void>;
}) {
  const { message } = AntApp.useApp();
  const [view, setView] = useState<ViewKey>('configs');
  const [selectedKey, setSelectedKey] = useState<ManagedConfigKey>('llm_model_catalog');
  const [configs, setConfigs] = useState<ManagedConfig[]>([]);
  const [drafts, setDrafts] = useState<ConfigDraft[]>([]);
  const [releases, setReleases] = useState<ConfigRelease[]>([]);
  const [audits, setAudits] = useState<AuditLog[]>([]);
  const [workingValue, setWorkingValue] = useState<unknown>(
    configMetadata.llm_model_catalog.defaultValue
  );
  const [openRouterDirectory, setOpenRouterDirectory] = useState<OpenRouterModelDirectory | null>(
    null
  );
  const [openRouterLoading, setOpenRouterLoading] = useState(false);
  const [openRouterError, setOpenRouterError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [autoSaveStatus, setAutoSaveStatus] = useState<
    'idle' | 'pending' | 'saving' | 'saved' | 'invalid' | 'error'
  >('idle');
  const hydratedValueRef = useRef('');

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [nextConfigs, nextDrafts, nextReleases, nextAudits] = await Promise.all([
        getManagedConfigs(props.client),
        getDrafts(props.client, props.environment),
        getReleases(props.client, props.environment),
        getAuditLogs(props.client, props.environment),
      ]);
      setConfigs(nextConfigs);
      setDrafts(nextDrafts);
      setReleases(nextReleases);
      setAudits(nextAudits);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载运营配置失败');
    } finally {
      setLoading(false);
    }
  }, [message, props.client, props.environment]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const reloadOpenRouter = useCallback(
    async (forceRefresh = false) => {
      setOpenRouterLoading(true);
      setOpenRouterError(null);
      try {
        const directory = await fetchOpenRouterModels(props.environment, forceRefresh);
        setOpenRouterDirectory(directory);
        if (forceRefresh) {
          message.success(`OpenRouter 模型目录同步成功，共 ${directory.models.length} 个模型`);
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'OpenRouter 模型同步失败';
        setOpenRouterError(errorMessage);
        if (forceRefresh) message.error(errorMessage);
      } finally {
        setOpenRouterLoading(false);
      }
    },
    [message, props.environment]
  );

  useEffect(() => {
    void reloadOpenRouter();
  }, [reloadOpenRouter]);

  const currentConfig = useMemo(
    () => configs.find((config) => config.key === selectedKey),
    [configs, selectedKey]
  );
  const latestDraft = useMemo(
    () => drafts.find((draft) => draft.config_key === selectedKey && draft.status === 'draft'),
    [drafts, selectedKey]
  );
  const selectedReleases = useMemo(
    () => releases.filter((release) => release.config_key === selectedKey),
    [releases, selectedKey]
  );
  const canWrite =
    props.admin.role !== 'viewer' &&
    (props.environment === 'production'
      ? props.admin.can_access_prod
      : props.admin.can_access_test);
  const pricingConfig = useMemo<DisplayPricingConfig>(() => {
    const runtimeValue = configs.find((config) => config.key === 'llm_pricing_config')?.value;
    const parsed = LlmPricingConfigSchema.safeParse(
      runtimeValue ?? configMetadata.llm_pricing_config.defaultValue
    );
    return parsed.success
      ? { exchangeRate: parsed.data.exchangeRate, markup: parsed.data.markup }
      : { exchangeRate: 680, markup: 2.5 };
  }, [configs]);
  const publishedModelIds = useMemo(() => {
    const runtimeValue = configs.find((config) => config.key === 'llm_model_catalog')?.value;
    const snapshots = [
      runtimeValue,
      ...releases
        .filter((release) => release.config_key === 'llm_model_catalog')
        .map((release) => release.value),
    ];
    const ids = snapshots.flatMap((snapshot) => {
      const parsed = ModelCatalogSchema.safeParse(snapshot);
      return parsed.success
        ? parsed.data.tiers.flatMap((tier) => tier.models.map((model) => model.id))
        : [];
    });
    return new Set(ids);
  }, [configs, releases]);

  useEffect(() => {
    const nextValue = structuredClone(
      latestDraft?.value ?? currentConfig?.value ?? configMetadata[selectedKey].defaultValue
    );
    hydratedValueRef.current = JSON.stringify(nextValue);
    setWorkingValue(nextValue);
    setAutoSaveStatus('idle');
  }, [currentConfig, latestDraft, selectedKey]);

  const validateOpenRouterConfig = useCallback(
    (key: ManagedConfigKey, value: unknown): void => {
      if (key !== 'llm_model_catalog') return;
      if (!openRouterDirectory) {
        throw new Error('OpenRouter 模型目录尚未同步，无法校验模型配置');
      }

      const catalog = ModelCatalogSchema.parse(value) as ModelCatalog;
      const issues = getOpenRouterCatalogIssues(catalog, openRouterDirectory);
      if (issues.length > 0) {
        throw new Error(`模型配置未通过 OpenRouter 校验：${issues.join('；')}`);
      }
    },
    [openRouterDirectory]
  );

  useEffect(() => {
    if (selectedKey !== 'llm_model_catalog' || !canWrite || loading) return;
    const serialized = JSON.stringify(workingValue);
    if (serialized === hydratedValueRef.current) return;

    setAutoSaveStatus('pending');
    const timer = window.setTimeout(async () => {
      let parsed: unknown;
      try {
        parsed = parseManagedConfig(selectedKey, workingValue);
        validateOpenRouterConfig(selectedKey, parsed);
      } catch {
        setAutoSaveStatus('invalid');
        return;
      }

      setAutoSaveStatus('saving');
      try {
        const savedDraft = await saveDraft({
          client: props.client,
          environment: props.environment,
          key: selectedKey,
          value: parsed,
          description: configMetadata[selectedKey].description,
        });
        hydratedValueRef.current = serialized;
        setDrafts((current) => [
          savedDraft,
          ...current.filter(
            (draft) =>
              !(
                draft.environment === savedDraft.environment &&
                draft.config_key === savedDraft.config_key &&
                draft.status === 'draft'
              )
          ),
        ]);
        setAutoSaveStatus('saved');
      } catch (error) {
        console.error('[admin] model catalog autosave failed:', error);
        setAutoSaveStatus('error');
      }
    }, 900);

    return () => window.clearTimeout(timer);
  }, [
    canWrite,
    loading,
    props.client,
    props.environment,
    selectedKey,
    validateOpenRouterConfig,
    workingValue,
  ]);

  const requireWriteConfirmation = async (
    action: string,
    beforeValue: unknown,
    afterValue: unknown
  ) => {
    const isProduction = props.environment === 'production';
    return confirmAction(
      `${isProduction ? '生产环境：' : ''}${action}`,
      <div>
        <Typography.Paragraph>
          {isProduction ? '此操作会影响线上配置，请确认变更内容。' : '请确认本次变更内容。'}
        </Typography.Paragraph>
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="配置">{configMetadata[selectedKey].label}</Descriptions.Item>
          <Descriptions.Item label="变更前">
            <pre className="diff-preview">{jsonPreview(beforeValue)}</pre>
          </Descriptions.Item>
          <Descriptions.Item label="变更后">
            <pre className="diff-preview">{jsonPreview(afterValue)}</pre>
          </Descriptions.Item>
        </Descriptions>
      </div>,
      isProduction
    );
  };

  const handleSaveDraft = async () => {
    if (!canWrite) return;
    setSaving(true);
    try {
      const parsed = parseManagedConfig(selectedKey, workingValue);
      validateOpenRouterConfig(selectedKey, parsed);
      if (
        !(await requireWriteConfirmation(
          '保存草稿',
          latestDraft?.value ?? currentConfig?.value,
          parsed
        ))
      ) {
        return;
      }
      await saveDraft({
        client: props.client,
        environment: props.environment,
        key: selectedKey,
        value: parsed,
        description: configMetadata[selectedKey].description,
      });
      message.success('草稿已保存');
      await reload();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '草稿保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handlePublish = async () => {
    if (!canWrite || !latestDraft) return;
    setSaving(true);
    try {
      validateOpenRouterConfig(selectedKey, latestDraft.value);
      if (!(await requireWriteConfirmation('发布配置', currentConfig?.value, latestDraft.value))) {
        return;
      }
      await publishDraft(props.client, latestDraft.id);
      message.success('配置已发布');
      await reload();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '发布失败');
    } finally {
      setSaving(false);
    }
  };

  const handleRollback = async (release: ConfigRelease) => {
    if (!canWrite) return;
    setSaving(true);
    try {
      validateOpenRouterConfig(selectedKey, release.value);
      if (!(await requireWriteConfirmation('回滚配置', currentConfig?.value, release.value))) {
        return;
      }
      await rollbackRelease(props.client, release.id);
      message.success(`已回滚并发布为新版本`);
      await reload();
    } catch (error) {
      message.error(error instanceof Error ? error.message : '回滚失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Layout className="admin-layout">
      <Layout.Sider width={240} theme="light" className="admin-sider">
        <div className="admin-brand">
          <img
            className="admin-brand-mark"
            src="/mijing-ai-operations-icon-v2.png"
            alt="蜜镜AI运营平台"
          />
          <div>
            <strong>蜜镜AI运营平台</strong>
            <small>配置与模型管理</small>
          </div>
        </div>
        <Menu
          selectedKeys={[view]}
          onClick={({ key }) => setView(key as ViewKey)}
          items={[
            { key: 'configs', label: '运营配置' },
            { key: 'releases', label: '发布历史' },
            { key: 'audit', label: '审计日志' },
          ]}
        />
      </Layout.Sider>
      <Layout>
        <Layout.Header className="admin-header">
          <Space>
            <Segmented
              value={props.environment}
              options={[
                { label: '测试环境', value: 'test' },
                { label: '生产环境', value: 'production' },
              ]}
              onChange={(value) => void props.onEnvironmentChange(value as AdminEnvironment)}
            />
            <Tag color={props.environment === 'production' ? 'red' : 'blue'}>
              {props.environment === 'production' ? '生产环境' : '测试环境'}
            </Tag>
          </Space>
          <Space>
            <Typography.Text>
              {props.admin.display_name} · {props.admin.email} · {props.admin.role}
            </Typography.Text>
            <Button onClick={() => void props.onLogout()}>退出</Button>
          </Space>
        </Layout.Header>
        {props.environment === 'production' ? (
          <Alert
            banner
            showIcon
            type="error"
            message="当前为生产环境：保存草稿、发布与回滚均会再次确认。"
          />
        ) : null}
        <Layout.Content className="admin-content">
          {loading ? (
            <div className="content-loading">
              <Spin />
            </div>
          ) : view === 'configs' ? (
            <div className="config-grid">
              <Card className="config-nav-card" title="白名单配置">
                <Menu
                  selectedKeys={[selectedKey]}
                  onClick={({ key }) => setSelectedKey(key as ManagedConfigKey)}
                  items={managedConfigKeys.map((key) => ({
                    key,
                    label: configMetadata[key].label,
                  }))}
                />
              </Card>
              <Card
                title={configMetadata[selectedKey].label}
                extra={
                  <Space>
                    <Tag>正式版本 {currentConfig?.version ?? 0}</Tag>
                    {latestDraft ? <Tag color="orange">有未发布草稿</Tag> : <Tag>已同步</Tag>}
                    {selectedKey === 'llm_model_catalog' ? (
                      <Tag
                        color={
                          autoSaveStatus === 'error'
                            ? 'red'
                            : autoSaveStatus === 'invalid'
                              ? 'orange'
                              : autoSaveStatus === 'saved'
                                ? 'green'
                                : 'blue'
                        }
                      >
                        {autoSaveStatus === 'pending'
                          ? '等待自动保存'
                          : autoSaveStatus === 'saving'
                            ? '自动保存中'
                            : autoSaveStatus === 'saved'
                              ? '草稿已自动保存'
                              : autoSaveStatus === 'invalid'
                                ? '请完善字段后自动保存'
                                : autoSaveStatus === 'error'
                                  ? '自动保存失败'
                                  : '自动保存已开启'}
                      </Tag>
                    ) : null}
                  </Space>
                }
              >
                <Typography.Paragraph type="secondary">
                  {configMetadata[selectedKey].description}
                </Typography.Paragraph>
                {!canWrite ? (
                  <Alert
                    type="info"
                    showIcon
                    message={
                      props.admin.role === 'viewer'
                        ? '当前账号为 viewer，只能查看，不能保存或发布。'
                        : '当前账号没有此环境的写入权限。'
                    }
                    className="form-alert"
                  />
                ) : null}
                <ConfigValueEditor
                  configKey={selectedKey}
                  value={workingValue}
                  onChange={setWorkingValue}
                  disabled={!canWrite}
                  openRouterDirectory={openRouterDirectory}
                  pricingConfig={pricingConfig}
                  publishedModelIds={publishedModelIds}
                  syncLoading={openRouterLoading}
                  syncError={openRouterError}
                  onRefreshOpenRouter={() => void reloadOpenRouter(true)}
                />
                <Divider />
                <Space wrap>
                  <Button
                    type="primary"
                    loading={saving}
                    disabled={!canWrite}
                    onClick={handleSaveDraft}
                  >
                    保存草稿
                  </Button>
                  <Button
                    danger={props.environment === 'production'}
                    loading={saving}
                    disabled={
                      !canWrite ||
                      !latestDraft ||
                      autoSaveStatus === 'pending' ||
                      autoSaveStatus === 'saving' ||
                      autoSaveStatus === 'invalid'
                    }
                    onClick={handlePublish}
                  >
                    发布当前草稿
                  </Button>
                  <Button
                    onClick={() =>
                      setWorkingValue(
                        structuredClone(
                          latestDraft?.value ??
                            currentConfig?.value ??
                            configMetadata[selectedKey].defaultValue
                        )
                      )
                    }
                  >
                    放弃未保存编辑
                  </Button>
                </Space>
                <Divider>该配置发布历史</Divider>
                {selectedReleases.length === 0 ? (
                  <Empty description="暂无发布记录" />
                ) : (
                  <List
                    dataSource={selectedReleases}
                    renderItem={(release) => (
                      <List.Item
                        actions={[
                          <Button
                            key="rollback"
                            size="small"
                            disabled={!canWrite}
                            onClick={() => void handleRollback(release)}
                          >
                            回滚到此版本
                          </Button>,
                        ]}
                      >
                        <div className="release-list-content">
                          <List.Item.Meta
                            title={`运行时版本 ${release.runtime_version}`}
                            description={`${release.released_by_name ?? '历史记录未标注'} · ${formatDate(
                              release.released_at
                            )}${release.rollback_of_release_id ? ' · 回滚发布' : ''}`}
                          />
                          <ReleaseChangeDetails
                            release={release}
                            allReleases={selectedReleases}
                            compact
                          />
                        </div>
                      </List.Item>
                    )}
                  />
                )}
              </Card>
            </div>
          ) : view === 'releases' ? (
            <Card title="发布历史">
              <Table
                rowKey="id"
                dataSource={releases}
                pagination={{ pageSize: 20 }}
                columns={[
                  {
                    title: '配置',
                    dataIndex: 'config_key',
                    render: (key: ManagedConfigKey) => configMetadata[key]?.label ?? key,
                  },
                  { title: '版本', dataIndex: 'runtime_version' },
                  {
                    title: '类型',
                    render: (_value, release: ConfigRelease) =>
                      release.rollback_of_release_id ? (
                        <Tag color="orange">回滚</Tag>
                      ) : (
                        <Tag>发布</Tag>
                      ),
                  },
                  {
                    title: '操作人',
                    dataIndex: 'released_by_name',
                    render: (name: string | null) => name ?? '历史记录未标注',
                  },
                  {
                    title: '修改内容',
                    render: (_value, release: ConfigRelease) =>
                      getReleaseChangeSummary(releases, release),
                  },
                  {
                    title: '时间',
                    dataIndex: 'released_at',
                    render: formatDate,
                  },
                ]}
                expandable={{
                  expandedRowRender: (release) => (
                    <ReleaseChangeDetails release={release} allReleases={releases} />
                  ),
                  rowExpandable: () => true,
                }}
              />
            </Card>
          ) : (
            <Card title="审计日志">
              <Table
                rowKey="id"
                dataSource={audits}
                pagination={{ pageSize: 20 }}
                columns={[
                  {
                    title: '操作人',
                    render: (_value, audit: AuditLog) => (
                      <Space direction="vertical" size={0}>
                        <Typography.Text>{audit.actor_name ?? '历史记录未标注'}</Typography.Text>
                        <Typography.Text type="secondary">{audit.actor_email}</Typography.Text>
                      </Space>
                    ),
                  },
                  { title: '动作', dataIndex: 'action' },
                  { title: '对象', dataIndex: 'record_id' },
                  { title: '时间', dataIndex: 'created_at', render: formatDate },
                ]}
              />
            </Card>
          )}
        </Layout.Content>
      </Layout>
    </Layout>
  );
}
