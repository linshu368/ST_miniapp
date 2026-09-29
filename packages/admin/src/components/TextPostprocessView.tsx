import { useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ReplyRenderer } from '@miniapp/reply-renderer';
import { canonicalTextPostprocessJson, type TextPostprocessDiagnostic } from '@miniapp/shared';
import {
  Alert,
  Button,
  Card,
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

  return (
    <Space direction="vertical" size="middle" className="text-postprocess-page">
      <Card>
        <Space direction="vertical" size="small" className="field-full">
          <Space wrap>
            <Tag color={props.environment === 'production' ? 'red' : 'blue'}>
              {environmentLabel}
            </Tag>
            <Tag>{dirty ? '本地未保存' : '本地与已保存基线一致'}</Tag>
            <Tag>{session.server?.draft ? '有已保存草稿' : '没有已保存草稿'}</Tag>
            {published.status === 'available' ? (
              <Tag color="green">正式版本 {published.version}</Tag>
            ) : null}
            {published.status === 'unavailable' ? (
              <Tag color="orange">当前正式配置不可用</Tag>
            ) : null}
            {published.status === 'none' ? <Tag>尚未发布</Tag> : null}
            {!allowWrite ? <Tag>只读</Tag> : null}
          </Space>
          <Typography.Paragraph type="secondary">
            这里管理当前{environmentLabel}
            的回复富文本规则。保存草稿不会切换线上版本。规则和平台规则模板分开发布。
          </Typography.Paragraph>
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
              重新读取
            </Button>
            <Button
              onClick={() =>
                props.onStoreChange((store) => resetLocalEdits(store, props.environment))
              }
              disabled={!dirty}
            >
              放弃未保存修改
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
              打开平台规则模板
            </Button>
          </Space>
          {dirty ? (
            <Typography.Text type="secondary">
              有未保存修改时，重新读取会先要求放弃这些修改。
            </Typography.Text>
          ) : null}
        </Space>
      </Card>
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
          onSelect={(ruleId) =>
            props.onStoreChange((store) => selectRule(store, props.environment, ruleId))
          }
          onEdit={edit}
        />
        <RuleEditor
          session={session}
          rule={rule}
          disabled={!allowWrite || session.mutation?.phase === 'inflight'}
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
        <PreviewColumn source={session.local} />
      </div>
      <HistoryColumn
        session={session}
        currentVersion={currentVersion}
        allowWrite={allowWrite && session.mutation?.phase !== 'inflight'}
        onRollback={(version) => void startWrite('rollback', version)}
        onLoadMore={() => void loadMore()}
      />
      <Card title="草稿与发布">
        <Space wrap>
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
            发布已保存草稿
          </Button>
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
        <Typography.Paragraph type="secondary">
          发布只提交已经保存的草稿修订。本地还没保存的修改不会一起发布。
          {session.server?.draft
            ? ` 已保存修订 ${session.server.draft.draft_revision}。`
            : ' 当前没有可发布的已保存草稿。'}
        </Typography.Paragraph>
      </Card>
    </Space>
  );
}

function RuleList(props: {
  session: EnvSession;
  disabled: boolean;
  onSelect: (ruleId: string) => void;
  onEdit: (local: EditableSource, selectedRuleId: string | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<'all' | 'enabled' | 'disabled'>('all');
  const visible = filterRules(props.session.local.rules, query, status);
  const selected = props.session.selectedRuleId;

  const add = (rule: EditableRule) => {
    props.onEdit(insertRule(props.session.local, rule, selected), rule.id);
  };

  return (
    <Card title="规则" className="text-postprocess-column">
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
        <Space wrap>
          <Button
            disabled={props.disabled}
            onClick={() =>
              add(blankRule(createRuleId(props.session.local.rules.map((rule) => rule.id))))
            }
          >
            新建
          </Button>
          <Button
            disabled={props.disabled || !selected}
            onClick={() => {
              if (!selected) return;
              const copied = duplicateRule(props.session.local, selected);
              if (copied) props.onEdit(copied.local, copied.selectedRuleId);
            }}
          >
            复制
          </Button>
          <Select
            aria-label="从模板新建"
            placeholder="从模板新建"
            disabled={props.disabled}
            onChange={(id: string) => {
              const template = STARTER_RULES.find((rule) => rule.id === id);
              if (!template) return;
              const nextId = props.session.local.rules.some((rule) => rule.id === template.id)
                ? createRuleId(props.session.local.rules.map((rule) => rule.id))
                : template.id;
              add({ ...template, id: nextId, enabled: false });
            }}
            options={STARTER_RULES.map((rule) => ({ value: rule.id, label: rule.name }))}
          />
        </Space>
        {visible.length === 0 ? <Empty description="没有匹配的规则" /> : null}
        <div className="text-postprocess-rules">
          {visible.map((rule) => (
            <div
              key={rule.id}
              className={
                rule.id === selected ? 'text-postprocess-rule is-selected' : 'text-postprocess-rule'
              }
            >
              <button type="button" onClick={() => props.onSelect(rule.id)}>
                <strong>{rule.name || rule.id}</strong>
                <small>{rule.id}</small>
              </button>
              <Space>
                <Switch
                  aria-label={`${rule.name} 启用`}
                  checked={rule.enabled}
                  disabled={props.disabled}
                  onChange={(enabled) =>
                    props.onEdit(setRuleEnabled(props.session.local, rule.id, enabled), selected)
                  }
                />
                <Button
                  size="small"
                  disabled={props.disabled}
                  onClick={() =>
                    props.onEdit(moveRule(props.session.local, rule.id, 'up'), selected)
                  }
                >
                  上移
                </Button>
                <Button
                  size="small"
                  disabled={props.disabled}
                  onClick={() =>
                    props.onEdit(moveRule(props.session.local, rule.id, 'down'), selected)
                  }
                >
                  下移
                </Button>
                <Button
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
                  删除
                </Button>
              </Space>
            </div>
          ))}
        </div>
        {selected && !visible.some((rule) => rule.id === selected) ? (
          <Typography.Text type="secondary">
            当前选中的规则被筛选隐藏，编辑区仍对应该规则编号。
          </Typography.Text>
        ) : null}
      </Space>
    </Card>
  );
}

function RuleEditor(props: {
  session: EnvSession;
  rule: EditableRule | null;
  disabled: boolean;
  onEdit: (local: EditableSource, selectedRuleId: string | null) => void;
  onIdDraft: (value: string) => void;
  onCommitId: () => void;
}) {
  if (!props.rule) {
    return (
      <Card title="编辑" className="text-postprocess-column">
        <Empty description="选择或新建一条规则" />
      </Card>
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

  return (
    <Card title="编辑" className="text-postprocess-column" extra={rule.enabled ? '启用' : '停用'}>
      <Space direction="vertical" className="field-full">
        <label className="text-postprocess-field">
          <span>编号</span>
          <Input
            aria-label="规则编号"
            value={idValue}
            disabled={props.disabled}
            onChange={(event) => props.onIdDraft(event.target.value)}
            onBlur={props.onCommitId}
          />
        </label>
        <label className="text-postprocess-field">
          <span>名称</span>
          <Input
            aria-label="规则名称"
            value={rule.name}
            disabled={props.disabled}
            onChange={(event) => change('name', event.target.value)}
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
                  <Field
                    label="标志"
                    help={RULE_FIELD_HELP.flags}
                    value={rule.flags}
                    disabled={props.disabled}
                    diagnostics={diagnostics}
                    field="flags"
                    rows={1}
                    onChange={(value) => change('flags', value)}
                  />
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
      </Space>
    </Card>
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

function PreviewColumn(props: { source: EditableSource }) {
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

  return (
    <Card title="诊断与预览" className="text-postprocess-column">
      <Space direction="vertical" className="field-full">
        <Alert
          type="info"
          showIcon
          message="选项是本地模拟"
          description={
            choice.text
              ? `模拟发送：${choice.text}。没有调用模型，也没有写入会话。`
              : '点击选项只会显示将要发送的文本，不会调用模型或写入会话。'
          }
        />
        <Space wrap>
          {(Object.keys(PREVIEW_SAMPLES) as PreviewSampleKey[]).map((key) => (
            <Button
              key={key}
              type={custom === null && sampleKey === key ? 'primary' : 'default'}
              onClick={() => {
                setCustom(null);
                setSampleKey(key);
              }}
            >
              {sampleLabel(key)}
            </Button>
          ))}
        </Space>
        <Input.TextArea
          aria-label="预览原文"
          rows={5}
          value={sample}
          onChange={(event) => setCustom(event.target.value)}
        />
        <Space wrap>
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
        <Segmented
          value={width}
          onChange={(value) => setWidth(value as 'mobile' | 'full')}
          options={[
            { label: '移动宽度', value: 'mobile' },
            { label: '全宽', value: 'full' },
          ]}
        />
        <PreviewDiagnostics state={preview} />
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
              content={content}
              artifact={preview?.artifact ?? undefined}
              streaming={streaming}
              displayName={displayName}
              theme={theme}
              choiceDisabled={streaming || choice.text !== null}
              messageKey="admin-text-postprocess-preview"
              onChoice={(next) => setChoice((current) => applyLocalChoice(current, next.text))}
            />
          </div>
        </div>
      </Space>
    </Card>
  );
}

function PreviewDiagnostics(props: { state: PreviewViewState | null }) {
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
      {props.state.apply?.rules.map((rule) => (
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
