import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Drawer,
  Empty,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from 'antd';
import type { AdminEnvironment } from '../lib/environment';
import {
  createPlatformPreset,
  listPlatformPresets,
  listPlatformPresetModelAssignments,
  listPlatformPresetVersions,
  publishPlatformPreset,
  setPlatformPresetEnabled,
  updatePlatformPresetMetadata,
  updatePlatformPresetModelAssignments,
  type PlatformPreset,
  type PlatformPresetModelAssignment,
  type PlatformPresetVersion,
} from '../lib/platformPresetsApi';
import {
  analyzePresetPayload,
  parsePresetJson,
  type PresetAnalysis,
} from '../lib/presetValidation';

interface PlatformPresetsViewProps {
  client: SupabaseClient;
  environment: AdminEnvironment;
  canWrite: boolean;
}

interface EditorState {
  open: boolean;
  displayName: string;
  source: string;
  sourcePresetId: string | null;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function confirmMutation(
  environment: AdminEnvironment,
  title: string,
  content: string
): Promise<boolean> {
  return new Promise((resolve) => {
    Modal.confirm({
      title: environment === 'production' ? `生产环境：${title}` : title,
      content,
      okText: '确认',
      cancelText: '取消',
      okButtonProps: environment === 'production' ? { danger: true } : undefined,
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}

function PresetAnalysisPanel({ analysis }: { analysis: PresetAnalysis }) {
  return (
    <Space direction="vertical" className="field-full" size="small">
      {analysis.errors.map((error) => (
        <Alert key={error} type="error" showIcon message={error} />
      ))}
      {analysis.warnings.map((warning) => (
        <Alert key={warning} type="warning" showIcon message={warning} />
      ))}
      <Descriptions bordered size="small" column={{ xs: 1, sm: 2, md: 3 }}>
        <Descriptions.Item label="文件大小">
          {(analysis.summary.bytes / 1024).toFixed(1)} KB
        </Descriptions.Item>
        <Descriptions.Item label="顶层字段">{analysis.summary.keyCount}</Descriptions.Item>
        <Descriptions.Item label="有效字段">
          {analysis.summary.effectiveKeys.length}
        </Descriptions.Item>
        <Descriptions.Item label="Prompt">{analysis.summary.promptCount}</Descriptions.Item>
        <Descriptions.Item label="启用顺序">
          {analysis.summary.orderedPromptCount}
        </Descriptions.Item>
        <Descriptions.Item label="扩展分组">{analysis.summary.extensionCount}</Descriptions.Item>
        <Descriptions.Item label="采样参数" span={3}>
          {Object.keys(analysis.summary.sampling).length > 0
            ? Object.entries(analysis.summary.sampling)
                .map(([key, value]) => `${key}=${value}`)
                .join('，')
            : '未设置'}
        </Descriptions.Item>
        <Descriptions.Item label="Prompt 标识" span={3}>
          {analysis.summary.promptIdentifiers.join('、') || '未设置'}
        </Descriptions.Item>
      </Descriptions>
    </Space>
  );
}

export function PlatformPresetsView(props: PlatformPresetsViewProps) {
  const [presets, setPresets] = useState<PlatformPreset[]>([]);
  const [versions, setVersions] = useState<PlatformPresetVersion[]>([]);
  const [modelAssignments, setModelAssignments] = useState<PlatformPresetModelAssignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [mutationLoading, setMutationLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPreset, setSelectedPreset] = useState<PlatformPreset | null>(null);
  const [editor, setEditor] = useState<EditorState>({
    open: false,
    displayName: '',
    source: '{}',
    sourcePresetId: null,
  });
  const [metadataPreset, setMetadataPreset] = useState<PlatformPreset | null>(null);
  const [metadataName, setMetadataName] = useState('');
  const [metadataOrder, setMetadataOrder] = useState(0);
  const [assignmentPreset, setAssignmentPreset] = useState<PlatformPreset | null>(null);
  const [assignmentModelIds, setAssignmentModelIds] = useState<string[]>([]);

  const parsedEditor = useMemo(() => parsePresetJson(editor.source), [editor.source]);
  const currentDefault = useMemo(
    () => presets.find((preset) => preset.is_default) ?? null,
    [presets]
  );

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextPresets, nextVersions, nextAssignments] = await Promise.all([
        listPlatformPresets(props.client),
        listPlatformPresetVersions(props.client),
        listPlatformPresetModelAssignments(props.client),
      ]);
      setPresets(nextPresets);
      setVersions(nextVersions);
      setModelAssignments(nextAssignments);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : '平台预设加载失败');
    } finally {
      setLoading(false);
    }
  }, [props.client]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const openEditor = (preset?: PlatformPreset) => {
    setEditor({
      open: true,
      displayName: preset ? `${preset.display_name} 副本` : '',
      source: JSON.stringify(preset?.preset_payload ?? {}, null, 2),
      sourcePresetId: preset?.id ?? null,
    });
  };

  const saveToPool = async () => {
    if (!props.canWrite || !parsedEditor.value || !parsedEditor.analysis.valid) return;
    if (!editor.displayName.trim()) {
      message.error('请填写预设名称');
      return;
    }
    if (
      !(await confirmMutation(
        props.environment,
        '保存到预设池？',
        '该操作会创建新的不可变预设快照，但不会切换当前默认预设。'
      ))
    ) {
      return;
    }
    setMutationLoading(true);
    try {
      await createPlatformPreset({
        client: props.client,
        displayName: editor.displayName,
        presetPayload: parsedEditor.value,
        enabled: true,
      });
      message.success('新预设已保存到预设池');
      setEditor((current) => ({ ...current, open: false }));
      await reload();
    } catch (mutationError) {
      message.error(mutationError instanceof Error ? mutationError.message : '预设保存失败');
    } finally {
      setMutationLoading(false);
    }
  };

  const publishEditor = async () => {
    if (!props.canWrite || !parsedEditor.value || !parsedEditor.analysis.valid) return;
    if (!editor.displayName.trim()) {
      message.error('请填写预设名称');
      return;
    }
    if (
      !(await confirmMutation(
        props.environment,
        '发布为平台默认预设？',
        `将创建新 UUID 并替换“${currentDefault?.display_name ?? '当前默认'}”。旧默认会停用并保留，所有后续同步用户将使用新预设。`
      ))
    ) {
      return;
    }
    setMutationLoading(true);
    try {
      await publishPlatformPreset({
        client: props.client,
        displayName: editor.displayName,
        presetPayload: parsedEditor.value,
      });
      message.success('平台默认预设已发布，平台配置版本已递增');
      setEditor((current) => ({ ...current, open: false }));
      await reload();
    } catch (mutationError) {
      message.error(mutationError instanceof Error ? mutationError.message : '默认预设发布失败');
    } finally {
      setMutationLoading(false);
    }
  };

  const publishExisting = async (preset: PlatformPreset) => {
    if (!props.canWrite || preset.is_default) return;
    if (
      !(await confirmMutation(
        props.environment,
        '将此内容发布为新默认？',
        `系统会复制“${preset.display_name}”的 JSON 并创建一个新 UUID，不会修改历史记录。`
      ))
    ) {
      return;
    }
    setMutationLoading(true);
    try {
      await publishPlatformPreset({
        client: props.client,
        displayName: preset.display_name,
        presetPayload: preset.preset_payload,
      });
      message.success('已复制并发布为新默认预设');
      await reload();
    } catch (mutationError) {
      message.error(mutationError instanceof Error ? mutationError.message : '默认预设发布失败');
    } finally {
      setMutationLoading(false);
    }
  };

  const toggleEnabled = async (preset: PlatformPreset) => {
    if (!props.canWrite || preset.is_default) return;
    setMutationLoading(true);
    try {
      await setPlatformPresetEnabled(props.client, preset.id, !preset.enabled);
      message.success(preset.enabled ? '预设已停用并保留' : '预设已重新启用');
      await reload();
    } catch (mutationError) {
      message.error(mutationError instanceof Error ? mutationError.message : '预设状态更新失败');
    } finally {
      setMutationLoading(false);
    }
  };

  const openMetadata = (preset: PlatformPreset) => {
    setMetadataPreset(preset);
    setMetadataName(preset.display_name);
    setMetadataOrder(preset.sort_order);
  };

  const saveMetadata = async () => {
    if (!props.canWrite || !metadataPreset || !metadataName.trim()) return;
    setMutationLoading(true);
    try {
      await updatePlatformPresetMetadata({
        client: props.client,
        presetId: metadataPreset.id,
        displayName: metadataName,
        sortOrder: metadataOrder,
      });
      message.success('预设名称和排序已更新');
      setMetadataPreset(null);
      await reload();
    } catch (mutationError) {
      message.error(mutationError instanceof Error ? mutationError.message : '元数据更新失败');
    } finally {
      setMutationLoading(false);
    }
  };

  const openAssignments = (preset: PlatformPreset) => {
    setAssignmentPreset(preset);
    setAssignmentModelIds(
      modelAssignments
        .filter((assignment) => assignment.preset_id === preset.id)
        .map((assignment) => assignment.model_id)
    );
  };

  const saveAssignments = async () => {
    if (!props.canWrite || !assignmentPreset) return;
    if (!assignmentPreset.enabled && assignmentModelIds.length > 0) {
      message.error('已停用的预设不能分配给模型，请先重新启用');
      return;
    }
    setMutationLoading(true);
    try {
      const version = await updatePlatformPresetModelAssignments({
        client: props.client,
        presetId: assignmentPreset.id,
        modelIds: assignmentModelIds,
        expectedVersion: modelAssignments[0]?.assignment_version ?? 0,
      });
      message.success(`适用模型已更新，分配版本 ${version}`);
      setAssignmentPreset(null);
      await reload();
    } catch (mutationError) {
      message.error(mutationError instanceof Error ? mutationError.message : '适用模型更新失败');
    } finally {
      setMutationLoading(false);
    }
  };

  const clearDisabledPresetAssignments = async (preset: PlatformPreset) => {
    setMutationLoading(true);
    try {
      await updatePlatformPresetModelAssignments({
        client: props.client,
        presetId: preset.id,
        modelIds: [],
        expectedVersion: modelAssignments[0]?.assignment_version ?? 0,
      });
      message.success('已清除停用预设的模型分配');
      await reload();
    } catch (mutationError) {
      message.error(mutationError instanceof Error ? mutationError.message : '模型分配清除失败');
    } finally {
      setMutationLoading(false);
    }
  };

  if (loading && presets.length === 0) {
    return (
      <div className="content-loading">
        <Spin />
      </div>
    );
  }

  return (
    <>
      <Card
        title="平台统一预设"
        extra={
          <Space wrap>
            {currentDefault ? (
              <Tag color="green">当前默认：{currentDefault.display_name}</Tag>
            ) : null}
            <Button onClick={() => void reload()} loading={loading}>
              刷新
            </Button>
            <Button type="primary" disabled={!props.canWrite} onClick={() => openEditor()}>
              新建预设
            </Button>
          </Space>
        }
      >
        <Typography.Paragraph type="secondary">
          管理统一下发到 SillyTavern 的 OpenAI 预设。编辑或恢复均发布为新快照，不覆盖历史 JSON。
        </Typography.Paragraph>
        {!props.canWrite ? (
          <Alert
            className="form-alert"
            type="info"
            showIcon
            message="当前账号仅可查看此环境的平台预设。"
          />
        ) : null}
        {error ? <Alert className="form-alert" type="error" showIcon message={error} /> : null}
        <Tabs
          items={[
            {
              key: 'presets',
              label: `预设池（${presets.length}）`,
              children:
                presets.length === 0 ? (
                  <Empty description="当前环境暂无平台预设" />
                ) : (
                  <Table
                    rowKey="id"
                    dataSource={presets}
                    loading={loading}
                    scroll={{ x: 960 }}
                    pagination={{ pageSize: 20 }}
                    columns={[
                      {
                        title: '名称',
                        dataIndex: 'display_name',
                        render: (name: string, preset) => (
                          <Space>
                            <Typography.Text strong={preset.is_default}>{name}</Typography.Text>
                            {preset.is_default ? <Tag color="green">默认</Tag> : null}
                          </Space>
                        ),
                      },
                      {
                        title: '状态',
                        dataIndex: 'enabled',
                        render: (enabled: boolean) => (
                          <Tag color={enabled ? 'blue' : 'default'}>
                            {enabled ? '已启用' : '已停用'}
                          </Tag>
                        ),
                      },
                      {
                        title: '适用模型',
                        key: 'assigned_models',
                        render: (_value, preset) => {
                          const assigned = modelAssignments.filter(
                            (assignment) => assignment.preset_id === preset.id
                          );
                          if (assigned.length === 0) {
                            return <Typography.Text type="secondary">未专属分配</Typography.Text>;
                          }
                          return (
                            <Space size={[0, 4]} wrap>
                              {assigned.slice(0, 3).map((assignment) => (
                                <Tag key={assignment.model_id}>{assignment.display_name}</Tag>
                              ))}
                              {assigned.length > 3 ? <Tag>+{assigned.length - 3}</Tag> : null}
                            </Space>
                          );
                        },
                      },
                      { title: '排序', dataIndex: 'sort_order', width: 80 },
                      {
                        title: '创建时间',
                        dataIndex: 'created_at',
                        render: formatDate,
                      },
                      {
                        title: '操作',
                        fixed: 'right',
                        width: 420,
                        render: (_value, preset) => (
                          <Space wrap>
                            <Button size="small" onClick={() => setSelectedPreset(preset)}>
                              详情
                            </Button>
                            <Button
                              size="small"
                              disabled={!props.canWrite}
                              onClick={() => openEditor(preset)}
                            >
                              复制编辑
                            </Button>
                            <Button
                              size="small"
                              disabled={!props.canWrite}
                              onClick={() => openMetadata(preset)}
                            >
                              名称/排序
                            </Button>
                            {preset.enabled ? (
                              <Button
                                size="small"
                                disabled={!props.canWrite}
                                onClick={() => openAssignments(preset)}
                              >
                                调整适用模型
                              </Button>
                            ) : modelAssignments.some(
                                (assignment) => assignment.preset_id === preset.id
                              ) ? (
                              <Popconfirm
                                title="清除该停用预设的模型分配？"
                                description="清除后相关模型继续使用全局默认预设。"
                                okText="确认清除"
                                cancelText="取消"
                                onConfirm={() => void clearDisabledPresetAssignments(preset)}
                              >
                                <Button
                                  size="small"
                                  danger
                                  disabled={!props.canWrite || mutationLoading}
                                >
                                  清除模型分配
                                </Button>
                              </Popconfirm>
                            ) : null}
                            {!preset.is_default ? (
                              <>
                                <Popconfirm
                                  title={preset.enabled ? '停用此预设？' : '重新启用此预设？'}
                                  description="记录会保留，不会删除历史文件。"
                                  okText="确认"
                                  cancelText="取消"
                                  onConfirm={() => void toggleEnabled(preset)}
                                >
                                  <Button
                                    size="small"
                                    disabled={!props.canWrite || mutationLoading}
                                  >
                                    {preset.enabled ? '停用' : '启用'}
                                  </Button>
                                </Popconfirm>
                                <Button
                                  size="small"
                                  type="primary"
                                  disabled={!props.canWrite || mutationLoading}
                                  onClick={() => void publishExisting(preset)}
                                >
                                  设为默认
                                </Button>
                              </>
                            ) : null}
                          </Space>
                        ),
                      },
                    ]}
                  />
                ),
            },
            {
              key: 'versions',
              label: `版本历史（${versions.length}）`,
              children: (
                <Table
                  rowKey="platform_version"
                  dataSource={versions}
                  pagination={{ pageSize: 20 }}
                  columns={[
                    { title: '平台版本', dataIndex: 'platform_version' },
                    {
                      title: '预设',
                      dataIndex: 'preset_display_name',
                      render: (name: string | null, version) =>
                        name ?? version.preset_pointer ?? '未知预设',
                    },
                    { title: '说明', dataIndex: 'note' },
                    { title: '来源', dataIndex: 'created_by' },
                    { title: '发布时间', dataIndex: 'created_at', render: formatDate },
                  ]}
                />
              ),
            },
          ]}
        />
      </Card>

      <Drawer
        width={720}
        title={selectedPreset?.display_name ?? '预设详情'}
        open={selectedPreset !== null}
        onClose={() => setSelectedPreset(null)}
      >
        {selectedPreset ? (
          <Space direction="vertical" size="large" className="field-full">
            <Descriptions bordered column={1} size="small">
              <Descriptions.Item label="预设 ID">{selectedPreset.id}</Descriptions.Item>
              <Descriptions.Item label="落盘文件">
                platform_{selectedPreset.id}.json
              </Descriptions.Item>
              <Descriptions.Item label="状态">
                {selectedPreset.is_default ? '当前默认' : selectedPreset.enabled ? '启用' : '停用'}
              </Descriptions.Item>
              <Descriptions.Item label="更新时间">
                {formatDate(selectedPreset.updated_at)}
              </Descriptions.Item>
            </Descriptions>
            <PresetAnalysisPanel analysis={analyzePresetPayload(selectedPreset.preset_payload)} />
            <pre className="preset-json-preview">
              {JSON.stringify(selectedPreset.preset_payload, null, 2)}
            </pre>
          </Space>
        ) : null}
      </Drawer>

      <Modal
        width={920}
        open={editor.open}
        title={editor.sourcePresetId ? '复制并编辑预设快照' : '新建平台预设'}
        onCancel={() => setEditor((current) => ({ ...current, open: false }))}
        footer={[
          <Button
            key="pool"
            disabled={!props.canWrite || !parsedEditor.analysis.valid}
            loading={mutationLoading}
            onClick={() => void saveToPool()}
          >
            保存到预设池
          </Button>,
          <Button
            key="publish"
            type="primary"
            danger={props.environment === 'production'}
            disabled={!props.canWrite || !parsedEditor.analysis.valid}
            loading={mutationLoading}
            onClick={() => void publishEditor()}
          >
            发布为平台默认
          </Button>,
        ]}
      >
        <Space direction="vertical" size="middle" className="field-full">
          <label className="preset-editor-field">
            <span>预设名称</span>
            <Input
              maxLength={80}
              value={editor.displayName}
              onChange={(event) =>
                setEditor((current) => ({ ...current, displayName: event.target.value }))
              }
            />
          </label>
          <label className="preset-editor-field">
            <span>完整 SillyTavern OpenAI 预设 JSON</span>
            <Input.TextArea
              className="preset-json-editor"
              value={editor.source}
              onChange={(event) =>
                setEditor((current) => ({ ...current, source: event.target.value }))
              }
              autoSize={{ minRows: 16, maxRows: 28 }}
              spellCheck={false}
            />
          </label>
          <PresetAnalysisPanel analysis={parsedEditor.analysis} />
        </Space>
      </Modal>

      <Modal
        open={metadataPreset !== null}
        title="修改预设名称和排序"
        okText="保存"
        cancelText="取消"
        confirmLoading={mutationLoading}
        onCancel={() => setMetadataPreset(null)}
        onOk={() => void saveMetadata()}
      >
        <Space direction="vertical" className="field-full" size="middle">
          <label className="preset-editor-field">
            <span>预设名称</span>
            <Input
              maxLength={80}
              value={metadataName}
              onChange={(event) => setMetadataName(event.target.value)}
            />
          </label>
          <label className="preset-editor-field">
            <span>排序值</span>
            <InputNumber
              min={0}
              precision={0}
              value={metadataOrder}
              onChange={(value) => setMetadataOrder(value ?? 0)}
            />
          </label>
        </Space>
      </Modal>

      <Modal
        width={640}
        open={assignmentPreset !== null}
        title={`调整适用模型：${assignmentPreset?.display_name ?? ''}`}
        okText="保存分配"
        cancelText="取消"
        confirmLoading={mutationLoading}
        onCancel={() => setAssignmentPreset(null)}
        onOk={() => void saveAssignments()}
      >
        <Space direction="vertical" className="field-full" size="middle">
          <Alert
            type="info"
            showIcon
            message="每个模型最多使用一个专属预设"
            description="选择已分配给其他预设的模型时，保存后会自动移动到当前预设。未选择的模型使用全局默认预设。"
          />
          <Select
            mode="multiple"
            className="field-full"
            allowClear
            showSearch
            optionFilterProp="label"
            placeholder="选择当前预设适用的模型"
            value={assignmentModelIds}
            onChange={setAssignmentModelIds}
            options={modelAssignments.map((assignment) => {
              const assignedPreset = presets.find((preset) => preset.id === assignment.preset_id);
              return {
                value: assignment.model_id,
                label: assignedPreset
                  ? `${assignment.display_name}（当前：${assignedPreset.display_name}）`
                  : assignment.display_name,
              };
            })}
          />
          <Typography.Text type="secondary">
            当前已选择 {assignmentModelIds.length} 个模型
          </Typography.Text>
        </Space>
      </Modal>
    </>
  );
}
