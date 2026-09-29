import { useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ReplyRenderer } from '@miniapp/reply-renderer';
import { canonicalTextPostprocessJson, type TextPostprocessDiagnostic } from '@miniapp/shared';
import {
  Alert,
  Button,
  Card,
  Drawer,
  Empty,
  Input,
  Modal,
  Segmented,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { AdminEnvironment } from '../lib/environment';
import {
  TextPostprocessClientError,
  createTextPostprocessApi,
  readAdminAccessToken,
  type TextPostprocessApi,
} from '../lib/textPostprocessApi';
import { createPreviewRunner, type PreviewViewState } from '../lib/textPostprocessPreview';
import {
  PREVIEW_SAMPLES,
  RULE_FIELD_HELP,
  STARTER_RULES,
  blankRule,
  type EditableRule,
  type EditableSource,
  type PreviewSampleKey,
} from '../lib/textPostprocessSamples';
import {
  acceptLoadedState,
  applyLocalChoice,
  beginLoad,
  casConflictNotice,
  clearMutation,
  finishRejected,
  commitRuleId,
  createRuleId,
  deleteRule,
  describeRollbackOutcome,
  duplicateRule,
  failLoad,
  filterRules,
  historyCurrentVersion,
  insertRule,
  isDirty,
  markMutationUnknown,
  moveRule,
  nextHistoryCursor,
  persistableSource,
  planDiscard,
  planLogicalMutation,
  planPublish,
  planRollback,
  planSave,
  productionWriteConfirm,
  publishedAvailability,
  putMutation,
  recordLocalRejection,
  reduceStreamSim,
  replaceLocal,
  resetLocalEdits,
  selectRule,
  selectedRule,
  sessionEditSignature,
  setIdDraft,
  setRuleEnabled,
  shouldAcceptAsyncResult,
  summarizeVersionChange,
  updateRuleField,
  validationUnavailableNotice,
  visibleSample,
  type EnvSession,
  type LogicalAction,
  type LocalChoiceSim,
  type StreamSim,
  type WorkbenchNotice,
  type WorkbenchStore,
} from '../lib/textPostprocessWorkbench';

const FIELD_LABEL: Record<string, string> = {
  id: '编号',
  name: '名称',
  description: '描述',
  enabled: '启用',
  pattern: '正则',
  flags: '标志',
  replacement: '模板',
  css: '样式',
  notes: '说明',
  source: '规则集',
  version: '版本',
  request: '请求',
};

export function TextPostprocessView(props: {
  client: SupabaseClient;
  environment: AdminEnvironment;
  role: 'owner' | 'operator' | 'viewer';
  canWrite: boolean;
  store: WorkbenchStore;
  onStoreChange: (updater: (current: WorkbenchStore) => WorkbenchStore) => WorkbenchStore;
  onOpenSystemInstructions: () => void;
}) {
  const session = props.store.sessions[props.environment];
  const allowWrite = props.canWrite && props.role !== 'viewer';
  const dirty = isDirty(session);
  const published = publishedAvailability(session.server);
  const currentVersion = historyCurrentVersion(session.server);
  const lifeRef = useRef(0);
  const environmentRef = useRef(props.environment);
  environmentRef.current = props.environment;
  const api = useMemo(
    () =>
      createTextPostprocessApi({
        environment: props.environment,
        getAccessToken: () => readAdminAccessToken(props.client),
      }),
    [props.client, props.environment]
  );

  useEffect(() => {
    return () => {
      lifeRef.current += 1;
    };
  }, [props.environment]);

  useEffect(() => {
    let mounted = true;
    let generation = 0;
    let signature = '';
    let preferServerLocal = false;
    props.onStoreChange((current) => {
      const started = beginLoad(current, props.environment);
      generation = started.generation;
      const next = started.store.sessions[props.environment];
      signature = sessionEditSignature(next);
      preferServerLocal = !isDirty(next);
      return started.store;
    });
    const canApply = () =>
      shouldAcceptAsyncResult({
        mounted,
        environment: props.environment,
        activeEnvironment: environmentRef.current,
        generation,
        responseGeneration: generation,
      });
    void api.readState().then(
      (server) => {
        if (!canApply()) return;
        props.onStoreChange(
          (current) =>
            acceptLoadedState({
              store: current,
              environment: props.environment,
              generation,
              server,
              mode: 'replace',
              signatureAtStart: signature,
              preferServerLocal,
            }) ?? current
        );
      },
      (error: unknown) => {
        if (!canApply()) return;
        props.onStoreChange(
          (current) =>
            failLoad({
              store: current,
              environment: props.environment,
              generation,
              message: error instanceof Error ? error.message : '读取富文本规则失败',
            }) ?? current
        );
      }
    );
    return () => {
      mounted = false;
    };
  }, [api, props.environment, props.onStoreChange]);

  const readSession = (): EnvSession =>
    props.onStoreChange((current) => current).sessions[props.environment] ?? session;

  const reload = async (preferServerLocal: boolean) => {
    const life = lifeRef.current;
    let generation = 0;
    let signature = '';
    props.onStoreChange((current) => {
      const started = beginLoad(current, props.environment);
      generation = started.generation;
      signature = sessionEditSignature(started.store.sessions[props.environment]);
      return started.store;
    });
    try {
      const server = await api.readState();
      if (lifeRef.current !== life) return;
      props.onStoreChange(
        (current) =>
          acceptLoadedState({
            store: current,
            environment: props.environment,
            generation,
            server,
            mode: 'replace',
            signatureAtStart: signature,
            preferServerLocal,
          }) ?? current
      );
    } catch (error) {
      if (lifeRef.current !== life) return;
      props.onStoreChange(
        (current) =>
          failLoad({
            store: current,
            environment: props.environment,
            generation,
            message: error instanceof Error ? error.message : '读取富文本规则失败',
          }) ?? current
      );
    }
  };

  const handleMutationError = (error: unknown, requestId: string, life: number) => {
    if (lifeRef.current !== life) {
      props.onStoreChange((store) => markMutationUnknown(store, props.environment, requestId));
      return;
    }
    if (!(error instanceof TextPostprocessClientError) || error.kind === 'result_unknown') {
      props.onStoreChange((store) => markMutationUnknown(store, props.environment, requestId));
      return;
    }
    if (error.kind === 'validation_unavailable') {
      props.onStoreChange(
        (store) =>
          finishRejected({
            store,
            environment: props.environment,
            requestId,
            notice: validationUnavailableNotice(),
            diagnostics: [],
          }) ?? store
      );
      return;
    }
    if (error.code === 'cas_conflict') {
      const latest = readSession();
      props.onStoreChange(
        (store) =>
          finishRejected({
            store,
            environment: props.environment,
            requestId,
            notice: casConflictNotice(latest),
            diagnostics: error.diagnostics,
          }) ?? store
      );
      return;
    }
    props.onStoreChange(
      (store) =>
        finishRejected({
          store,
          environment: props.environment,
          requestId,
          notice: {
            tone: error.kind === 'forbidden' ? 'warning' : 'error',
            code: error.code,
            title: '操作没有完成',
            detail: error.message,
          },
          diagnostics: error.diagnostics,
        }) ?? store
    );
  };

  const retrySame = async () => {
    const current = readSession();
    const mutation = current.mutation;
    if (!mutation || mutation.phase !== 'unknown' || !allowWrite) return;
    const life = lifeRef.current;
    const labels: Record<LogicalAction, string> = {
      save: '保存草稿',
      publish: '发布',
      rollback: '回滚',
      discard: '放弃草稿',
    };
    const confirm = productionWriteConfirm(props.environment, labels[mutation.action]);
    if (confirm.required && !(await confirmAction(confirm.title, confirm.content, true))) return;
    const body = JSON.parse(mutation.payloadKey) as Record<string, unknown>;
    props.onStoreChange((store) =>
      putMutation(store, props.environment, { ...mutation, phase: 'inflight' })
    );
    try {
      const outcome = await sendMutation(api, mutation.action, body, mutation.requestId);
      if (lifeRef.current !== life) {
        props.onStoreChange((store) =>
          markMutationUnknown(store, props.environment, mutation.requestId)
        );
        return;
      }
      props.onStoreChange(
        (store) =>
          clearMutation(
            store,
            props.environment,
            mutation.requestId,
            successNotice(mutation.action, outcome)
          ) ?? store
      );
      await reload(true);
    } catch (error) {
      handleMutationError(error, mutation.requestId, life);
    }
  };

  const startWrite = async (action: LogicalAction, targetVersion: number | null = null) => {
    if (!allowWrite) return;
    const life = lifeRef.current;
    const current = readSession();
    const labels: Record<LogicalAction, string> = {
      save: '保存草稿',
      publish: '发布',
      rollback: '回滚',
      discard: '放弃草稿',
    };
    const confirm = productionWriteConfirm(props.environment, labels[action]);
    if (confirm.required && !(await confirmAction(confirm.title, confirm.content, true))) return;
    if (action === 'rollback') {
      const ok = await confirmAction(
        `基于版本 ${targetVersion ?? ''} 创建新发布？`,
        '回滚会创建一条新的发布版本，不会修改被选中的旧快照。',
        true
      );
      if (!ok) return;
    }
    if (action === 'discard') {
      const ok = await confirmAction(
        '放弃已保存草稿？',
        '只放弃服务器上的草稿，不会回滚正式版本。',
        true
      );
      if (!ok) return;
    }

    const planned = buildPlan(current, action, targetVersion);
    if (!planned.ok) {
      props.onStoreChange((store) =>
        recordLocalRejection(store, props.environment, planned.notice, planned.diagnostics)
      );
      return;
    }
    const logical = planLogicalMutation({
      current: current.mutation,
      action,
      payloadKey: canonicalTextPostprocessJson(planned.body),
      createId: () => crypto.randomUUID(),
    });
    if (logical.blocked) {
      const unknown = logical.mutation.phase === 'unknown';
      props.onStoreChange((store) =>
        recordLocalRejection(
          store,
          props.environment,
          {
            tone: 'warning',
            code: unknown ? 'RESULT_UNKNOWN' : 'IN_FLIGHT',
            title: unknown ? '已有一个结果未知的请求' : '请求还在进行',
            detail: unknown ? '请先查询该请求。不要用新的请求编号重发。' : '请等待当前请求结束。',
          },
          []
        )
      );
      return;
    }
    props.onStoreChange((store) => putMutation(store, props.environment, logical.mutation));
    const requestId = logical.mutation.requestId;
    try {
      const outcome = await sendMutation(api, action, planned.body, requestId);
      if (lifeRef.current !== life) {
        props.onStoreChange((store) => markMutationUnknown(store, props.environment, requestId));
        return;
      }
      props.onStoreChange(
        (store) =>
          clearMutation(store, props.environment, requestId, successNotice(action, outcome)) ??
          store
      );
      await reload(true);
    } catch (error) {
      handleMutationError(error, requestId, life);
    }
  };

  const lookup = async () => {
    const requestId = readSession().mutation?.requestId;
    if (!requestId) return;
    const life = lifeRef.current;
    try {
      const data = await api.lookup(requestId);
      if (lifeRef.current !== life) return;
      if (!data.outcome) {
        props.onStoreChange((store) =>
          recordLocalRejection(
            store,
            props.environment,
            {
              tone: 'warning',
              code: 'RESULT_UNKNOWN',
              title: '服务端还没有这个请求的结果',
              detail: '请继续用同一请求编号查询。不要更换编号重新发布。',
            },
            []
          )
        );
        return;
      }
      const detail =
        data.outcome.action === 'rollback'
          ? describeRollbackOutcome(data.outcome)
          : '已查到请求结果。正在读取权威状态，不直接采用本地猜测的版本。';
      props.onStoreChange(
        (store) =>
          clearMutation(store, props.environment, requestId, {
            tone: 'success',
            code: 'lookup',
            title: '已查到请求结果',
            detail,
          }) ?? store
      );
      await reload(true);
    } catch (error) {
      handleMutationError(error, requestId, life);
    }
  };

  const loadMore = async () => {
    const cursor = nextHistoryCursor(session.history);
    if (cursor === null) return;
    const life = lifeRef.current;
    let generation = 0;
    let signature = '';
    let preferServerLocal = false;
    props.onStoreChange((current) => {
      const started = beginLoad(current, props.environment);
      generation = started.generation;
      const next = started.store.sessions[props.environment];
      signature = sessionEditSignature(next);
      preferServerLocal = !isDirty(next);
      return started.store;
    });
    try {
      const server = await api.readState({ beforeVersion: cursor });
      if (lifeRef.current !== life) return;
      props.onStoreChange(
        (current) =>
          acceptLoadedState({
            store: current,
            environment: props.environment,
            generation,
            server,
            mode: 'append',
            signatureAtStart: signature,
            preferServerLocal,
          }) ?? current
      );
    } catch (error) {
      if (lifeRef.current !== life) return;
      props.onStoreChange(
        (current) =>
          failLoad({
            store: current,
            environment: props.environment,
            generation,
            message: error instanceof Error ? error.message : '读取更早版本失败',
          }) ?? current
      );
    }
  };

  const edit = (local: EditableSource, selectedRuleId: string | null) => {
    props.onStoreChange((store) => replaceLocal(store, props.environment, local, selectedRuleId));
  };

  const environmentLabel = props.environment === 'production' ? '生产环境' : '测试环境';
  const rule = selectedRule(session.local, session.selectedRuleId);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [preview, setPreview] = useState<PreviewViewState | null>(null);

  useEffect(() => {
    const save = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
      if (!allowWrite || session.mutation?.phase === 'inflight') return;
      event.preventDefault();
      void startWrite('save');
    };
    window.addEventListener('keydown', save);
    return () => window.removeEventListener('keydown', save);
  }, [allowWrite, session.mutation?.phase, session.local]);

  return (
    <div className="text-postprocess-page">
      <header className="text-postprocess-head">
        <div>
          <Typography.Title level={3}>回复富文本规则</Typography.Title>
          <Typography.Text type="secondary">
            当前{environmentLabel}的回复后处理。保存草稿不会切换正式版本。
          </Typography.Text>
        </div>
        <div className="text-postprocess-head-actions">
          <Space wrap size={6}>
            <Tag color={props.environment === 'production' ? 'red' : 'blue'}>
              {environmentLabel}
            </Tag>
            <Tag color={dirty ? 'gold' : undefined}>{dirty ? '未保存' : '草稿已同步'}</Tag>
            {published.status === 'available' ? (
              <Tag color="green">正式 v{published.version}</Tag>
            ) : null}
            {published.status === 'unavailable' ? <Tag color="orange">正式配置不可用</Tag> : null}
            {published.status === 'none' ? <Tag>尚未发布</Tag> : null}
            {!allowWrite ? <Tag>只读</Tag> : null}
          </Space>
          <Space wrap>
            <Button
              onClick={() => {
                void (async () => {
                  if (dirty) {
                    const ok = await confirmAction(
                      '放弃未保存修改并重新读取？',
                      '重新读取会用当前环境的权威草稿和正式版本替换本地编辑。',
                      true
                    );
                    if (!ok) return;
                    props.onStoreChange((store) => resetLocalEdits(store, props.environment));
                  }
                  await reload(true);
                })();
              }}
            >
              请求恢复
            </Button>
            <Button
              onClick={() =>
                props.onStoreChange((store) => resetLocalEdits(store, props.environment))
              }
              disabled={!dirty}
            >
              放弃修改
            </Button>
            <Button
              onClick={() => {
                void (async () => {
                  if (dirty) {
                    const ok = await confirmAction(
                      '放弃未保存的富文本规则？',
                      '打开平台规则模板前需要先处理当前环境尚未保存的规则编辑。',
                      true
                    );
                    if (!ok) return;
                    props.onStoreChange((store) => resetLocalEdits(store, props.environment));
                  }
                  props.onOpenSystemInstructions();
                })();
              }}
            >
              System Instructions
            </Button>
            <Button onClick={() => setHistoryOpen(true)}>发布历史</Button>
            <Button
              type="primary"
              disabled={!allowWrite || session.mutation?.phase === 'inflight'}
              onClick={() => void startWrite('save')}
            >
              保存草稿
            </Button>
            <Button
              disabled={!allowWrite || session.mutation?.phase === 'inflight' || dirty}
              onClick={() => void startWrite('publish')}
            >
              发布
            </Button>
          </Space>
        </div>
      </header>
      {session.notice ? (
        <Alert
          showIcon
          type={session.notice.tone}
          message={session.notice.title}
          description={session.notice.detail}
        />
      ) : null}
      {session.loadError ? <Alert showIcon type="error" message={session.loadError} /> : null}
      {published.status === 'unavailable' ? (
        <Alert
          showIcon
          type="warning"
          message="当前正式配置不可用"
          description="不会改用历史中版本号最大的一条来充当当前版本。"
        />
      ) : null}
      {!allowWrite ? (
        <Alert showIcon type="info" message="当前身份只能查看这个环境的富文本规则。" />
      ) : null}
      <div className="text-postprocess-layout">
        <RuleList
          session={session}
          disabled={!allowWrite || session.mutation?.phase === 'inflight'}
          preview={preview}
          onSelect={(ruleId) =>
            props.onStoreChange((store) => selectRule(store, props.environment, ruleId))
          }
          onEdit={edit}
        />
        <RuleEditor
          session={session}
          rule={rule}
          disabled={!allowWrite || session.mutation?.phase === 'inflight'}
          preview={preview}
          onEdit={edit}
          onIdDraft={(value) => {
            if (!rule) return;
            props.onStoreChange((store) =>
              setIdDraft(store, props.environment, { ruleId: rule.id, value })
            );
          }}
          onCommitId={() => {
            if (!rule || !session.idDraft || session.idDraft.ruleId !== rule.id) return;
            const committed = commitRuleId(
              session.local,
              rule.id,
              session.idDraft.value,
              session.selectedRuleId
            );
            if (committed.error) {
              props.onStoreChange((store) =>
                recordLocalRejection(
                  store,
                  props.environment,
                  {
                    tone: 'error',
                    code: 'invalid_rule_id',
                    title: '规则编号无效',
                    detail: committed.error ?? '',
                  },
                  []
                )
              );
              return;
            }
            props.onStoreChange((store) =>
              replaceLocal(
                setIdDraft(store, props.environment, null),
                props.environment,
                committed.local,
                committed.selectedRuleId
              )
            );
          }}
        />
        <PreviewColumn source={session.local} onPreviewChange={setPreview} />
      </div>
      <Drawer title="发布历史" open={historyOpen} onClose={() => setHistoryOpen(false)} width={480}>
        <HistoryColumn
          session={session}
          currentVersion={currentVersion}
          allowWrite={allowWrite && session.mutation?.phase !== 'inflight'}
          onRollback={(version) => void startWrite('rollback', version)}
          onLoadMore={() => void loadMore()}
        />
      </Drawer>
      <div className="text-postprocess-footer">
        <Typography.Text type="secondary">
          {session.server?.draft
            ? `已保存草稿修订 ${session.server.draft.draft_revision}`
            : '没有已保存草稿'}
          ；{dirty ? '本地修改尚未保存' : '本地与草稿基线一致'}。
        </Typography.Text>
        <Space wrap>
          <Button
            danger
            disabled={!allowWrite || session.mutation?.phase === 'inflight'}
            onClick={() => void startWrite('discard')}
          >
            放弃已保存草稿
          </Button>
          {session.mutation?.phase === 'unknown' ? (
            <Button type="primary" onClick={() => void lookup()}>
              查询此请求
            </Button>
          ) : null}
          {session.mutation?.phase === 'unknown' ? (
            <Button disabled={!allowWrite} onClick={() => void retrySame()}>
              用同一请求重试
            </Button>
          ) : null}
        </Space>
      </div>
    </div>
  );
}

function RuleList(props: {
  session: EnvSession;
  disabled: boolean;
  preview: PreviewViewState | null;
  onSelect: (ruleId: string) => void;
  onEdit: (local: EditableSource, selectedRuleId: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [newRuleOpen, setNewRuleOpen] = useState(false);
  const [templateId, setTemplateId] = useState('dialogue');
  const [newName, setNewName] = useState('对白');
  const visible = filterRules(props.session.local.rules, query, status);
  const selected = props.session.selectedRuleId;

  const add = (rule: EditableRule) => {
    props.onEdit(insertRule(props.session.local, rule, selected), rule.id);
  };
  const create = () => {
    const template = STARTER_RULES.find((item) => item.id === templateId);
    const id =
      template && !props.session.local.rules.some((item) => item.id === template.id)
        ? template.id
        : createRuleId(props.session.local.rules.map((item) => item.id));
    const base = template ? { ...template } : blankRule(id);
    add({ ...base, id, name: newName.trim() || base.name, enabled: false });
    setNewRuleOpen(false);
  };

  return (
    <section className="text-postprocess-column text-postprocess-rules-column">
      <div className="text-postprocess-column-head">
        <div>
          <strong>规则</strong>
          <Typography.Text type="secondary">
            {props.session.local.rules.length} 条 · 按顺序执行
          </Typography.Text>
        </div>
        <Button
          type="primary"
          size="small"
          disabled={props.disabled}
          onClick={() => setNewRuleOpen(true)}
        >
          + 新建
        </Button>
      </div>
      <Space direction="vertical" className="field-full">
        <Input
          aria-label="搜索规则"
          placeholder="搜索名称、编号或正则"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select
          aria-label="按状态筛选"
          value={status}
          onChange={setStatus}
          options={[
            { value: 'all', label: '全部状态' },
            { value: 'enabled', label: '只看启用' },
            { value: 'disabled', label: '只看停用' },
          ]}
        />
        {visible.length === 0 ? <Empty description="没有匹配的规则" /> : null}
        <div className="text-postprocess-rules">
          {visible.map((rule) => {
            const stat = props.preview?.apply?.rules.find((item) => item.ruleId === rule.id);
            return (
              <div
                key={rule.id}
                className={
                  rule.id === selected
                    ? 'text-postprocess-rule is-selected'
                    : 'text-postprocess-rule'
                }
              >
                <button type="button" onClick={() => props.onSelect(rule.id)}>
                  <span className="text-postprocess-rule-top">
                    <strong>{rule.name || rule.id}</strong>
                    <small>
                      #{String(props.session.local.rules.indexOf(rule) + 1).padStart(2, '0')}
                    </small>
                  </span>
                  <span className="text-postprocess-rule-description">
                    {rule.description || '自定义后处理规则'}
                  </span>
                  <span className="text-postprocess-rule-bottom">
                    <span>{rule.enabled ? '已启用' : '已停用'}</span>
                    <span>
                      {rule.enabled ? (stat ? `${stat.count} 处匹配` : '等待处理') : '不参与处理'}
                    </span>
                  </span>
                </button>
                <Switch
                  className="text-postprocess-rule-switch"
                  size="small"
                  aria-label={`${rule.name || rule.id} 启用`}
                  checked={rule.enabled}
                  disabled={props.disabled}
                  onChange={(enabled) =>
                    props.onEdit(setRuleEnabled(props.session.local, rule.id, enabled), selected)
                  }
                />
              </div>
            );
          })}
        </div>
        {selected && !visible.some((rule) => rule.id === selected) ? (
          <Typography.Text type="secondary">
            当前选中的规则被筛选隐藏，编辑区仍对应该规则编号。
          </Typography.Text>
        ) : null}
      </Space>
      <Modal
        title="新建回复规则"
        open={newRuleOpen}
        onCancel={() => setNewRuleOpen(false)}
        onOk={create}
        okText="创建"
        okButtonProps={{ disabled: props.disabled }}
      >
        <Space direction="vertical" className="field-full">
          <Typography.Text type="secondary">选择起点后创建；新规则默认停用。</Typography.Text>
          <div className="text-postprocess-template-grid">
            {[...STARTER_RULES, null].map((item) => {
              const id = item?.id ?? 'custom';
              return (
                <button
                  key={id}
                  type="button"
                  className={templateId === id ? 'is-selected' : ''}
                  onClick={() => {
                    setTemplateId(id);
                    setNewName(item?.name ?? '自定义规则');
                  }}
                  aria-pressed={templateId === id}
                >
                  <strong>{item?.name ?? '自定义'}</strong>
                  <span>{item?.description ?? '从空白规则开始'}</span>
                </button>
              );
            })}
          </div>
          <Input
            aria-label="新规则名称"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="规则名称"
          />
        </Space>
      </Modal>
    </section>
  );
}

function RuleEditor(props: {
  session: EnvSession;
  rule: EditableRule | null;
  disabled: boolean;
  preview: PreviewViewState | null;
  onEdit: (local: EditableSource, selectedRuleId: string | null) => void;
  onIdDraft: (value: string) => void;
  onCommitId: () => void;
}) {
  if (!props.rule) {
    return (
      <section className="text-postprocess-column text-postprocess-editor">
        <div className="text-postprocess-column-head">
          <strong>编辑规则</strong>
        </div>
        <Empty description="选择或新建一条规则" />
      </section>
    );
  }
  const rule = props.rule;
  const idValue = props.session.idDraft?.ruleId === rule.id ? props.session.idDraft.value : rule.id;
  const diagnostics = props.session.apiDiagnostics.filter(
    (item) => item.rule_id === rule.id || item.rule_id === null
  );
  const change = (
    field: 'name' | 'description' | 'pattern' | 'flags' | 'replacement' | 'css' | 'notes',
    value: string
  ) => {
    props.onEdit(updateRuleField(props.session.local, rule.id, field, value), rule.id);
  };
  const position = props.session.local.rules.findIndex((item) => item.id === rule.id);
  const stat = props.preview?.apply?.rules.find((item) => item.ruleId === rule.id);
  const toggleFlag = (flag: string, enabled: boolean) => {
    const flags = new Set(rule.flags.split(''));
    if (enabled) flags.add(flag);
    else flags.delete(flag);
    change('flags', ['g', 'i', 'm', 's', 'u'].filter((item) => flags.has(item)).join(''));
  };

  return (
    <section className="text-postprocess-column text-postprocess-editor">
      <div className="text-postprocess-column-head">
        <div>
          <strong>编辑规则</strong>
          <Typography.Text type="secondary">
            #{String(position + 1).padStart(2, '0')} · {rule.enabled ? '已启用' : '已停用'}
          </Typography.Text>
        </div>
        <Space size={2}>
          <Button
            aria-label="上移规则"
            size="small"
            disabled={props.disabled || position <= 0}
            onClick={() => props.onEdit(moveRule(props.session.local, rule.id, 'up'), rule.id)}
          >
            ↑
          </Button>
          <Button
            aria-label="下移规则"
            size="small"
            disabled={props.disabled || position === props.session.local.rules.length - 1}
            onClick={() => props.onEdit(moveRule(props.session.local, rule.id, 'down'), rule.id)}
          >
            ↓
          </Button>
          <Button
            aria-label="复制规则"
            size="small"
            disabled={props.disabled}
            onClick={() => {
              const copied = duplicateRule(props.session.local, rule.id);
              if (copied) props.onEdit(copied.local, copied.selectedRuleId);
            }}
          >
            ⧉
          </Button>
          <Button
            aria-label="删除规则"
            size="small"
            danger
            disabled={props.disabled}
            onClick={() => {
              void confirmAction(
                `删除规则 ${rule.name}？`,
                '删除后还需要保存草稿才会写到服务器。',
                true
              ).then((ok) => {
                if (!ok) return;
                const next = deleteRule(props.session.local, rule.id);
                props.onEdit(next.local, next.selectedRuleId);
              });
            }}
          >
            ×
          </Button>
        </Space>
      </div>
      <Space direction="vertical" className="field-full">
        <div className="text-postprocess-name-row">
          <label className="text-postprocess-field">
            <span>名称</span>
            <Input
              aria-label="规则名称"
              value={rule.name}
              disabled={props.disabled}
              onChange={(event) => change('name', event.target.value)}
            />
          </label>
          <Switch
            checked={rule.enabled}
            disabled={props.disabled}
            checkedChildren="启用"
            unCheckedChildren="停用"
            aria-label="启用规则"
            onChange={(enabled) =>
              props.onEdit(setRuleEnabled(props.session.local, rule.id, enabled), rule.id)
            }
          />
        </div>
        <label className="text-postprocess-field">
          <span>稳定规则 ID（次级编辑）</span>
          <Input
            aria-label="规则编号"
            value={idValue}
            disabled={props.disabled}
            onChange={(event) => props.onIdDraft(event.target.value)}
            onBlur={props.onCommitId}
          />
        </label>
        <Tabs
          items={[
            {
              key: 'parse',
              label: '解析',
              children: (
                <Space direction="vertical" className="field-full">
                  <Field
                    label="正则"
                    help={RULE_FIELD_HELP.pattern}
                    value={rule.pattern}
                    disabled={props.disabled}
                    diagnostics={diagnostics}
                    field="pattern"
                    onChange={(value) => change('pattern', value)}
                  />
                  <div className="text-postprocess-flags">
                    <Typography.Text>flags</Typography.Text>
                    {['g', 'i', 'm', 's', 'u'].map((flag) => (
                      <label key={flag}>
                        <input
                          type="checkbox"
                          checked={rule.flags.includes(flag)}
                          disabled={props.disabled}
                          onChange={(event) => toggleFlag(flag, event.target.checked)}
                        />{' '}
                        {flag}
                      </label>
                    ))}
                    <Typography.Text type="secondary">{RULE_FIELD_HELP.flags}</Typography.Text>
                  </div>
                  <Field
                    label="模板"
                    help={RULE_FIELD_HELP.replacement}
                    value={rule.replacement}
                    disabled={props.disabled}
                    diagnostics={diagnostics}
                    field="replacement"
                    onChange={(value) => change('replacement', value)}
                  />
                </Space>
              ),
            },
            {
              key: 'css',
              label: '样式',
              children: (
                <Field
                  label="样式"
                  help={RULE_FIELD_HELP.css}
                  value={rule.css}
                  disabled={props.disabled}
                  diagnostics={diagnostics}
                  field="css"
                  onChange={(value) => change('css', value)}
                />
              ),
            },
            {
              key: 'notes',
              label: '说明',
              children: (
                <Space direction="vertical" className="field-full">
                  <Field
                    label="描述"
                    help="描述只帮助运营识别规则。"
                    value={rule.description}
                    disabled={props.disabled}
                    diagnostics={diagnostics}
                    field="description"
                    onChange={(value) => change('description', value)}
                  />
                  <Field
                    label="说明"
                    help={RULE_FIELD_HELP.notes}
                    value={rule.notes}
                    disabled={props.disabled}
                    diagnostics={diagnostics}
                    field="notes"
                    onChange={(value) => change('notes', value)}
                  />
                </Space>
              ),
            },
          ]}
        />
        <div className="text-postprocess-match-card">
          <strong>
            {rule.enabled ? (stat ? `${stat.count} 处匹配` : '正在处理') : '规则已停用'}
          </strong>
          {stat?.firstMatch ? (
            <>
              <Typography.Text type="secondary">首处匹配</Typography.Text>
              <code>{stat.firstMatch}</code>
              {stat.firstCaptures.map((capture) => (
                <code key={`${capture.index}-${capture.name ?? ''}`}>
                  ${capture.name ?? capture.index} = {capture.text}
                </code>
              ))}
            </>
          ) : (
            <Typography.Text type="secondary">
              {rule.enabled ? '当前原文没有可显示的首处匹配。' : '停用规则不参与预览。'}
            </Typography.Text>
          )}
        </div>
      </Space>
    </section>
  );
}

function Field(props: {
  label: string;
  help: string;
  value: string;
  disabled: boolean;
  diagnostics: TextPostprocessDiagnostic[];
  field: string;
  rows?: number;
  onChange: (value: string) => void;
}) {
  const matched = props.diagnostics.filter((item) => item.field === props.field);
  return (
    <label className="text-postprocess-field">
      <span>{props.label}</span>
      <Input.TextArea
        aria-label={props.label}
        value={props.value}
        disabled={props.disabled}
        rows={props.rows ?? 4}
        onChange={(event) => props.onChange(event.target.value)}
      />
      <Typography.Paragraph type="secondary">{props.help}</Typography.Paragraph>
      {matched.map((item, index) => (
        <Alert
          key={`${item.code}-${index}`}
          type="error"
          showIcon
          message={`${FIELD_LABEL[item.field] ?? item.field}：${item.code}`}
          description={diagnosticText(item)}
        />
      ))}
    </label>
  );
}

function PreviewColumn(props: {
  source: EditableSource;
  onPreviewChange: (state: PreviewViewState | null) => void;
}) {
  const [sampleKey, setSampleKey] = useState<PreviewSampleKey>('full');
  const [custom, setCustom] = useState<string | null>(null);
  const sample = custom ?? PREVIEW_SAMPLES[sampleKey];
  const [displayName, setDisplayName] = useState('预览用户');
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [width, setWidth] = useState<'mobile' | 'full'>('mobile');
  const [stream, setStream] = useState<StreamSim>({ phase: 'idle', visibleUnits: 0 });
  const [choice, setChoice] = useState<LocalChoiceSim>({ text: null, networkCalls: 0 });
  const preview = useRulePreview(props.source, sample);
  const total = [...sample].length;
  const streaming = stream.phase === 'running';
  const content = stream.phase === 'idle' ? sample : visibleSample(sample, stream.visibleUnits);
  // 流式期间安全地显示原文；复位或完整终态需要新的 renderer 生命周期，
  // 使同一 artifact 再次处理完整正文，而非保留流式的原文降级结果。
  const previewRendererKey =
    stream.phase === 'idle' || stream.visibleUnits >= total
      ? 'admin-text-postprocess-preview-final'
      : 'admin-text-postprocess-preview-stream';
  useEffect(() => {
    if (stream.phase !== 'running') return undefined;
    const timer = window.setInterval(() => {
      setStream((current) => reduceStreamSim(current, 'tick', total, 8));
    }, 40);
    return () => window.clearInterval(timer);
  }, [stream.phase, total]);

  useEffect(() => {
    setStream({ phase: 'idle', visibleUnits: 0 });
    setChoice({ text: null, networkCalls: 0 });
  }, [sample, props.source]);

  useEffect(() => {
    props.onPreviewChange(preview);
  }, [preview, props.onPreviewChange]);

  return (
    <section className="text-postprocess-column text-postprocess-preview-column">
      <div className="text-postprocess-column-head">
        <div>
          <strong>实时预览</strong>
          <Typography.Text type="secondary">全部启用规则的效果</Typography.Text>
        </div>
        <Typography.Text type="secondary">{[...sample].length} 字</Typography.Text>
      </div>
      <Space direction="vertical" className="field-full">
        <Space wrap>
          <Select
            aria-label="选择预览示例"
            value={custom === null ? sampleKey : 'custom'}
            onChange={(value: PreviewSampleKey | 'custom') => {
              if (value !== 'custom') {
                setCustom(null);
                setSampleKey(value);
              }
            }}
            options={(Object.keys(PREVIEW_SAMPLES) as PreviewSampleKey[]).map((key) => ({
              value: key,
              label: sampleLabel(key),
            }))}
          />
          <Segmented
            value={width}
            onChange={(value) => setWidth(value as 'mobile' | 'full')}
            options={[
              { label: '自适应', value: 'full' },
              { label: '375px', value: 'mobile' },
            ]}
          />
        </Space>
        <Input.TextArea
          aria-label="预览原文"
          rows={5}
          value={sample}
          onChange={(event) => setCustom(event.target.value)}
        />
        <Space wrap size={4}>
          <Button onClick={() => setStream((current) => reduceStreamSim(current, 'start', total))}>
            开始模拟流式
          </Button>
          <Button
            onClick={() =>
              setStream((current) =>
                reduceStreamSim(current, streaming ? 'pause' : 'resume', total)
              )
            }
          >
            {streaming ? '暂停' : '继续'}
          </Button>
          <Button onClick={() => setStream((current) => reduceStreamSim(current, 'reset', total))}>
            重置
          </Button>
        </Space>
        <div className="text-postprocess-preview-tools">
          <Input
            aria-label="预览用户名"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <Segmented
            value={theme}
            onChange={(value) => setTheme(value as 'light' | 'dark')}
            options={[
              { label: '浅色', value: 'light' },
              { label: '深色', value: 'dark' },
            ]}
          />
        </div>
        <div
          className={
            width === 'mobile' ? 'text-postprocess-stage is-mobile' : 'text-postprocess-stage'
          }
        >
          <div
            className={
              theme === 'dark' ? 'text-postprocess-bubble is-dark' : 'text-postprocess-bubble'
            }
            data-theme={theme}
          >
            <ReplyRenderer
              key={previewRendererKey}
              content={content}
              artifact={preview?.artifact ?? undefined}
              streaming={streaming}
              displayName={displayName}
              theme={theme}
              choiceDisabled={streaming || choice.text !== null}
              messageKey={previewRendererKey}
              onChoice={(next) => setChoice((current) => applyLocalChoice(current, next.text))}
            />
          </div>
        </div>
        <PreviewDiagnostics state={preview} compact />
        <Typography.Text type="secondary">
          {choice.text
            ? `本地模拟发送：${choice.text}；未调用模型或写入会话。`
            : '选项仅本地模拟；不会调用模型或业务写请求。'}
        </Typography.Text>
      </Space>
    </section>
  );
}

function PreviewDiagnostics(props: { state: PreviewViewState | null; compact?: boolean }) {
  if (!props.state) return <Typography.Text type="secondary">正在准备预览。</Typography.Text>;
  const failure = props.state.failure;
  return (
    <Space direction="vertical" className="field-full">
      <Typography.Text>
        耗时 {props.state.elapsedMs} ms
        {props.state.apply ? `，匹配 ${props.state.apply.matches} 处` : ''}
        {props.state.apply?.reason ? `，执行结果 ${props.state.apply.reason}` : ''}
      </Typography.Text>
      {failure ? (
        <Alert
          type="warning"
          showIcon
          message={props.state.diagnostics[0]?.message ?? '预览失败'}
        />
      ) : null}
      {props.state.diagnostics.map((item, index) => (
        <Alert
          key={`${item.code}-${item.rule_id ?? 'source'}-${index}`}
          type="error"
          showIcon
          message={`${item.rule_id ?? '规则集'} / ${FIELD_LABEL[item.field] ?? item.field} / ${item.code}`}
          description={diagnosticText(item)}
        />
      ))}
      {!props.compact &&
        props.state.apply?.rules.map((rule) => (
          <Typography.Paragraph key={rule.ruleId}>
            {rule.ruleId}：{rule.count} 处{rule.firstMatch ? `，首处匹配 ${rule.firstMatch}` : ''}
            {rule.firstCaptures.length
              ? `，捕获 ${rule.firstCaptures.map((capture) => `${capture.name ?? capture.index}=${capture.text}`).join('，')}`
              : ''}
          </Typography.Paragraph>
        ))}
      {props.state.apply?.skipped.map((item) => (
        <Typography.Text key={`${item.ruleId}-${item.code}`}>
          {item.ruleId} 被跳过：{item.code}
        </Typography.Text>
      ))}
    </Space>
  );
}

function HistoryColumn(props: {
  session: EnvSession;
  currentVersion: number | null;
  allowWrite: boolean;
  onRollback: (version: number) => void;
  onLoadMore: () => void;
}) {
  const availability = publishedAvailability(props.session.server);
  return (
    <Card title="发布历史">
      <Space direction="vertical" className="field-full">
        {availability.status === 'available' ? (
          <Typography.Text>
            当前正式版本 {availability.version}，发布时间 {formatDate(availability.publishedAt)}。
          </Typography.Text>
        ) : null}
        {availability.status === 'none' ? (
          <Typography.Text>这个环境还没有正式版本。</Typography.Text>
        ) : null}
        {props.session.server?.draft ? (
          <Typography.Text type="secondary">
            已保存草稿更新于 {formatDate(props.session.server.draft.updated_at)}，基线版本{' '}
            {props.session.server.draft.base_version}。
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">没有已保存草稿。</Typography.Text>
        )}
        {props.session.history.map((item, index) => {
          const previous = props.session.history[index + 1] ?? null;
          const current = item.version === props.currentVersion;
          return (
            <div key={item.version} className="text-postprocess-release">
              <Space wrap>
                <strong>版本 {item.version}</strong>
                {current ? <Tag color="green">当前正式版本</Tag> : null}
                <Typography.Text type="secondary">{formatDate(item.published_at)}</Typography.Text>
              </Space>
              <Typography.Paragraph>{summarizeVersionChange(item, previous)}</Typography.Paragraph>
              <Button
                disabled={!props.allowWrite || props.session.server?.runtime_version === null}
                onClick={() => props.onRollback(item.version)}
              >
                基于版本 {item.version} 创建新发布
              </Button>
            </div>
          );
        })}
        {props.session.hasMore ? <Button onClick={props.onLoadMore}>加载更早版本</Button> : null}
        {!props.session.hasMore && props.session.history.length > 0 ? (
          <Typography.Text type="secondary">这一页之后没有更早的版本。</Typography.Text>
        ) : null}
      </Space>
    </Card>
  );
}

function useRulePreview(source: EditableSource, sample: string): PreviewViewState | null {
  const [state, setState] = useState<PreviewViewState | null>(null);
  const runner = useRef<ReturnType<typeof createPreviewRunner> | null>(null);
  const generation = useRef(0);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const signature = canonicalTextPostprocessJson(persistableSource(source));

  useEffect(
    () => () => {
      runner.current?.dispose();
      runner.current = null;
    },
    []
  );

  useEffect(() => {
    const jobGeneration = ++generation.current;
    let mounted = true;
    const timer = window.setTimeout(() => {
      // dispose() 是终态：被释放的 runner 之后只会返回 ignored。StrictMode 的
      // 挂载-清理-重挂载会经过这条路径，所以按需重建而不是复用同一个实例。
      void (runner.current ??= createPreviewRunner())
        .run({
          source: persistableSource(sourceRef.current),
          sample,
          generation: jobGeneration,
        })
        .then((result) => {
          if (!mounted || result.ignored || generation.current !== jobGeneration) return;
          setState(result.state);
        });
    }, 250);
    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, [sample, signature]);

  return state;
}

function buildPlan(
  session: EnvSession,
  action: LogicalAction,
  targetVersion: number | null
):
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; notice: WorkbenchNotice; diagnostics: TextPostprocessDiagnostic[] } {
  if (action === 'save') {
    const planned = planSave(session);
    if (!planned.ok) {
      return {
        ok: false,
        notice: {
          tone: 'error',
          code: 'invalid_draft',
          title: '草稿还不能保存',
          detail: planned.message,
        },
        diagnostics: planned.diagnostics,
      };
    }
    return { ok: true, body: planned.body };
  }
  if (action === 'publish') {
    const planned = planPublish(session);
    if (!planned.ok) {
      const detail =
        planned.reason === 'dirty'
          ? '还有未保存修改。请先保存草稿，发布不会带上这些本地内容。'
          : '没有可发布的已保存草稿。';
      return {
        ok: false,
        notice: { tone: 'warning', code: planned.reason, title: '现在不能发布', detail },
        diagnostics: [],
      };
    }
    return { ok: true, body: planned.body };
  }
  if (action === 'discard') {
    const planned = planDiscard(session);
    if (!planned.ok) {
      return {
        ok: false,
        notice: {
          tone: 'warning',
          code: planned.reason,
          title: '没有可放弃的草稿',
          detail: '服务器上没有已保存草稿。',
        },
        diagnostics: [],
      };
    }
    return { ok: true, body: planned.body };
  }
  const planned = planRollback(session, targetVersion);
  if (!planned.ok) {
    const detail =
      planned.reason === 'no_runtime'
        ? '当前没有正式版本，不能回滚。'
        : '请先选择一个明确的历史版本。';
    return {
      ok: false,
      notice: { tone: 'warning', code: planned.reason, title: '现在不能回滚', detail },
      diagnostics: [],
    };
  }
  return { ok: true, body: planned.body };
}

async function sendMutation(
  api: TextPostprocessApi,
  action: LogicalAction,
  body: Record<string, unknown>,
  requestId: string
) {
  if (action === 'save') {
    return api.save({ ...body, request_id: requestId } as Parameters<
      TextPostprocessApi['save']
    >[0]);
  }
  if (action === 'publish') {
    return api.publish({ ...body, request_id: requestId } as Parameters<
      TextPostprocessApi['publish']
    >[0]);
  }
  if (action === 'discard') {
    return api.discard({ ...body, request_id: requestId } as Parameters<
      TextPostprocessApi['discard']
    >[0]);
  }
  return api.rollback({ ...body, request_id: requestId } as Parameters<
    TextPostprocessApi['rollback']
  >[0]);
}

function successNotice(
  action: LogicalAction,
  outcome: { replayed: boolean; version?: number; target_version?: number; action: string }
): WorkbenchNotice {
  if (action === 'rollback') {
    return {
      tone: 'success',
      code: 'rollback',
      title: '已创建新发布版本',
      detail: describeRollbackOutcome({ ...outcome, action: 'rollback' }),
    };
  }
  const title =
    action === 'publish' ? '发布请求已确认' : action === 'discard' ? '草稿已放弃' : '草稿已保存';
  return {
    tone: 'success',
    code: action,
    title,
    detail: outcome.replayed
      ? '这是同一请求的重放结果。正在读取权威状态。'
      : '正在读取权威状态。保存草稿不会切换正式版本。',
  };
}

function diagnosticText(item: TextPostprocessDiagnostic): string {
  const location = item.location
    ? `第 ${item.location.line} 行，第 ${item.location.column} 列。`
    : '';
  return `${item.message} ${location}`.trim();
}

function sampleLabel(key: PreviewSampleKey): string {
  switch (key) {
    case 'full':
      return '完整示例';
    case 'plain':
      return '普通示例';
    case 'broken':
      return '残缺示例';
    case 'choice':
      return '选项示例';
  }
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function confirmAction(title: string, content: string, danger = false): Promise<boolean> {
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
