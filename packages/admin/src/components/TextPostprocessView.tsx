import { useEffect, useMemo, useRef, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { canonicalTextPostprocessJson, type TextPostprocessDiagnostic } from '@miniapp/shared';
import { Alert, Button, Drawer, Modal, Space, Tag, Typography } from 'antd';
import { getAdminApiUrl, type AdminEnvironment } from '../lib/environment';
import {
  TextPostprocessClientError,
  createTextPostprocessApi,
  readAdminAccessToken,
  type TextPostprocessApi,
} from '@miniapp/admin-client';
import type { EditableSource } from '../lib/textPostprocessTemplates';
import { HistoryColumn } from './text-postprocess/HistoryColumn';
import { RecoveryEditor } from './text-postprocess/RecoveryEditor';
import { RuleEditor } from './text-postprocess/RuleEditor';
import { RuleList } from './text-postprocess/RuleList';
import {
  acceptLoadedState,
  beginLoad,
  casConflictNotice,
  clearMutation,
  finishRejected,
  commitRuleId,
  describeRollbackOutcome,
  failLoad,
  historyCurrentVersion,
  isDirty,
  markMutationUnknown,
  nextHistoryCursor,
  planDiscard,
  planLogicalMutation,
  planPublish,
  planRollback,
  planSave,
  productionWriteConfirm,
  publishedAvailability,
  putMutation,
  recordLocalRejection,
  replaceLocal,
  resetLocalEdits,
  selectRule,
  selectedRule,
  sessionEditSignature,
  setIdDraft,
  shouldAcceptAsyncResult,
  validationUnavailableNotice,
  type EnvSession,
  type LogicalAction,
  type WorkbenchNotice,
  type WorkbenchStore,
} from '../lib/textPostprocessWorkbench';

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
        baseUrl: getAdminApiUrl(props.environment),
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
      <RecoveryEditor
        value={session.local.rich_reply}
        disabled={!allowWrite || session.mutation?.phase === 'inflight'}
        onChange={(rich_reply) => edit({ ...session.local, rich_reply }, session.selectedRuleId)}
      />
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
