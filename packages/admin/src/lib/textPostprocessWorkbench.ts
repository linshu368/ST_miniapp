import {
  TEXT_POSTPROCESS_POLICY_VERSION,
  TEXT_POSTPROCESS_RULE_ID,
  TEXT_POSTPROCESS_SCHEMA_VERSION,
  canonicalTextPostprocessJson,
  parseTextPostprocessDraft,
  type TextPostprocessAdminState,
  type TextPostprocessDiagnostic,
  type TextPostprocessDraftSource,
  type TextPostprocessMutationOutcome,
  type TextPostprocessVersionSnapshot,
} from '@miniapp/shared';
import type { AdminEnvironment } from './environment';
import { blankRule, type EditableRule, type EditableSource } from './textPostprocessSamples';

export type LogicalAction = 'save' | 'publish' | 'rollback' | 'discard';

export interface LogicalMutation {
  action: LogicalAction;
  requestId: string;
  payloadKey: string;
  phase: 'inflight' | 'unknown';
}

export interface WorkbenchNotice {
  tone: 'info' | 'success' | 'warning' | 'error';
  code: string;
  title: string;
  detail: string;
}

export interface IdDraft {
  ruleId: string;
  value: string;
}

export interface EnvSession {
  generation: number;
  server: TextPostprocessAdminState | null;
  history: TextPostprocessVersionSnapshot[];
  hasMore: boolean;
  local: EditableSource;
  selectedRuleId: string | null;
  idDraft: IdDraft | null;
  mutation: LogicalMutation | null;
  loadError: string | null;
  notice: WorkbenchNotice | null;
  apiDiagnostics: TextPostprocessDiagnostic[];
}

export interface WorkbenchStore {
  sessions: Record<AdminEnvironment, EnvSession>;
}

export type PublishedAvailability =
  | { status: 'none' }
  | { status: 'available'; version: number; publishedAt: string }
  | { status: 'unavailable'; runtimeVersion: number | null };

export type RuleTextField =
  | 'name'
  | 'description'
  | 'pattern'
  | 'flags'
  | 'replacement'
  | 'css'
  | 'notes';

export function createWorkbenchStore(): WorkbenchStore {
  return {
    sessions: {
      test: createEnvSession(),
      production: createEnvSession(),
    },
  };
}

export function createEnvSession(): EnvSession {
  return {
    generation: 0,
    server: null,
    history: [],
    hasMore: false,
    local: emptyEditableSource(),
    selectedRuleId: null,
    idDraft: null,
    mutation: null,
    loadError: null,
    notice: null,
    apiDiagnostics: [],
  };
}

export function emptyEditableSource(): EditableSource {
  return {
    schema_version: TEXT_POSTPROCESS_SCHEMA_VERSION,
    policy_version: TEXT_POSTPROCESS_POLICY_VERSION,
    rules: [],
  };
}

export function emptyDraftSource(): TextPostprocessDraftSource {
  return {
    schema_version: TEXT_POSTPROCESS_SCHEMA_VERSION,
    policy_version: TEXT_POSTPROCESS_POLICY_VERSION,
    rules: [],
  };
}

export function persistableSource(local: EditableSource): TextPostprocessDraftSource {
  return {
    schema_version: TEXT_POSTPROCESS_SCHEMA_VERSION,
    policy_version: TEXT_POSTPROCESS_POLICY_VERSION,
    rules: local.rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      description: rule.description,
      enabled: rule.enabled,
      pattern: rule.pattern,
      flags: rule.flags,
      replacement: rule.replacement,
      css: rule.css,
      notes: rule.notes,
    })),
  };
}

export function editableFromSource(source: TextPostprocessDraftSource): EditableSource {
  return {
    schema_version: TEXT_POSTPROCESS_SCHEMA_VERSION,
    policy_version: TEXT_POSTPROCESS_POLICY_VERSION,
    rules: source.rules.map((rule) => ({ ...rule })),
  };
}

export function baselineSource(
  server: TextPostprocessAdminState | null
): TextPostprocessDraftSource {
  if (server?.draft?.source) return server.draft.source;
  if (!server?.draft && server?.published?.source) return server.published.source;
  return emptyDraftSource();
}

export function sessionEditSignature(session: EnvSession): string {
  return `${canonicalTextPostprocessJson(persistableSource(session.local))}\n${session.idDraft?.ruleId ?? ''}\n${session.idDraft?.value ?? ''}`;
}

export function isDirty(session: EnvSession): boolean {
  if (session.server?.draft && session.server.draft.source === null) return true;
  if (session.idDraft && session.idDraft.value !== session.idDraft.ruleId) return true;
  return (
    canonicalTextPostprocessJson(persistableSource(session.local)) !==
    canonicalTextPostprocessJson(baselineSource(session.server))
  );
}

export function textPostprocessCanMutate(input: {
  role: 'owner' | 'operator' | 'viewer';
  environment: AdminEnvironment;
  canAccessTest: boolean;
  canAccessProd: boolean;
}): boolean {
  if (input.role === 'viewer') return false;
  return input.environment === 'production' ? input.canAccessProd : input.canAccessTest;
}

export function productionWriteConfirm(
  environment: AdminEnvironment,
  actionLabel: string
): { required: boolean; title: string; content: string } {
  if (environment !== 'production') return { required: false, title: '', content: '' };
  return {
    required: true,
    title: `在生产环境${actionLabel}？`,
    content: '当前是生产环境，不是测试环境。确认后才会提交这个环境的请求。',
  };
}

export function publishedAvailability(
  server: TextPostprocessAdminState | null
): PublishedAvailability {
  if (!server || (server.runtime_version === null && server.published === null))
    return { status: 'none' };
  if (
    server.published &&
    server.runtime_version !== null &&
    server.published.version === server.runtime_version
  ) {
    return {
      status: 'available',
      version: server.published.version,
      publishedAt: server.published.published_at,
    };
  }
  return { status: 'unavailable', runtimeVersion: server.runtime_version };
}

/** 当前正式版本只来自 Backend 的 runtime/published 对照，不用历史最大版本号代替。 */
export function historyCurrentVersion(server: TextPostprocessAdminState | null): number | null {
  const availability = publishedAvailability(server);
  return availability.status === 'available' ? availability.version : null;
}

export function nextHistoryCursor(
  history: readonly TextPostprocessVersionSnapshot[]
): number | null {
  const first = history[0];
  if (!first) return null;
  return history.reduce((min, item) => Math.min(min, item.version), first.version);
}

export function shouldAcceptAsyncResult(input: {
  mounted: boolean;
  environment: AdminEnvironment;
  activeEnvironment: AdminEnvironment;
  generation: number;
  responseGeneration: number;
}): boolean {
  return (
    input.mounted &&
    input.environment === input.activeEnvironment &&
    input.generation === input.responseGeneration
  );
}

export function beginLoad(
  store: WorkbenchStore,
  environment: AdminEnvironment
): { store: WorkbenchStore; generation: number } {
  const session = store.sessions[environment];
  const generation = session.generation + 1;
  return {
    generation,
    store: replaceSession(store, environment, { ...session, generation, loadError: null }),
  };
}

export function acceptLoadedState(input: {
  store: WorkbenchStore;
  environment: AdminEnvironment;
  generation: number;
  server: TextPostprocessAdminState;
  mode: 'replace' | 'append';
  signatureAtStart: string;
  preferServerLocal: boolean;
}): WorkbenchStore | null {
  const session = input.store.sessions[input.environment];
  if (session.generation !== input.generation) return null;
  const history =
    input.mode === 'append'
      ? mergeHistory(session.history, input.server.history)
      : sortHistory(input.server.history);
  const unchanged = sessionEditSignature(session) === input.signatureAtStart;
  const adopt = unchanged && input.preferServerLocal;
  const local = adopt ? editableFromSource(baselineSource(input.server)) : session.local;
  return replaceSession(input.store, input.environment, {
    ...session,
    server: input.server,
    history,
    hasMore: input.server.has_more,
    local,
    selectedRuleId: adopt ? keepSelection(local, session.selectedRuleId) : session.selectedRuleId,
    idDraft: adopt ? null : session.idDraft,
    loadError: null,
  });
}

export function failLoad(input: {
  store: WorkbenchStore;
  environment: AdminEnvironment;
  generation: number;
  message: string;
}): WorkbenchStore | null {
  const session = input.store.sessions[input.environment];
  if (session.generation !== input.generation) return null;
  return replaceSession(input.store, input.environment, {
    ...session,
    loadError: input.message,
  });
}

export function resetLocalEdits(
  store: WorkbenchStore,
  environment: AdminEnvironment
): WorkbenchStore {
  const session = store.sessions[environment];
  const local = editableFromSource(baselineSource(session.server));
  return replaceSession(store, environment, {
    ...session,
    local,
    selectedRuleId: keepSelection(local, session.selectedRuleId),
    idDraft: null,
    apiDiagnostics: [],
  });
}

export function replaceLocal(
  store: WorkbenchStore,
  environment: AdminEnvironment,
  local: EditableSource,
  selectedRuleId: string | null
): WorkbenchStore {
  const session = store.sessions[environment];
  return replaceSession(store, environment, {
    ...session,
    local,
    selectedRuleId,
    apiDiagnostics: [],
    idDraft: session.idDraft && session.idDraft.ruleId === selectedRuleId ? session.idDraft : null,
  });
}

export function selectRule(
  store: WorkbenchStore,
  environment: AdminEnvironment,
  ruleId: string | null
): WorkbenchStore {
  const session = store.sessions[environment];
  return replaceSession(store, environment, { ...session, selectedRuleId: ruleId });
}

export function setIdDraft(
  store: WorkbenchStore,
  environment: AdminEnvironment,
  draft: IdDraft | null
): WorkbenchStore {
  const session = store.sessions[environment];
  return replaceSession(store, environment, { ...session, idDraft: draft });
}

export function putMutation(
  store: WorkbenchStore,
  environment: AdminEnvironment,
  mutation: LogicalMutation | null
): WorkbenchStore {
  const session = store.sessions[environment];
  return replaceSession(store, environment, { ...session, mutation });
}

export function markMutationUnknown(
  store: WorkbenchStore,
  environment: AdminEnvironment,
  requestId: string
): WorkbenchStore {
  const session = store.sessions[environment];
  if (session.mutation?.requestId !== requestId) return store;
  return replaceSession(store, environment, {
    ...session,
    mutation: { ...session.mutation, phase: 'unknown' },
    notice: {
      tone: 'warning',
      code: 'RESULT_UNKNOWN',
      title: '结果未知',
      detail: '请查询同一请求。不要更换请求编号，也不要立即重新发布。',
    },
  });
}

export function finishRejected(input: {
  store: WorkbenchStore;
  environment: AdminEnvironment;
  requestId: string;
  notice: WorkbenchNotice;
  diagnostics?: TextPostprocessDiagnostic[];
}): WorkbenchStore | null {
  const session = input.store.sessions[input.environment];
  if (session.mutation?.requestId !== input.requestId) return null;
  return replaceSession(input.store, input.environment, {
    ...session,
    mutation: null,
    notice: input.notice,
    apiDiagnostics: input.diagnostics ?? session.apiDiagnostics,
  });
}

export function recordLocalRejection(
  store: WorkbenchStore,
  environment: AdminEnvironment,
  notice: WorkbenchNotice,
  diagnostics: TextPostprocessDiagnostic[]
): WorkbenchStore {
  const session = store.sessions[environment];
  return replaceSession(store, environment, {
    ...session,
    notice,
    apiDiagnostics: diagnostics,
  });
}

export function clearMutation(
  store: WorkbenchStore,
  environment: AdminEnvironment,
  requestId: string,
  notice: WorkbenchNotice | null
): WorkbenchStore | null {
  const session = store.sessions[environment];
  if (session.mutation?.requestId !== requestId) return null;
  return replaceSession(store, environment, { ...session, mutation: null, notice });
}

export function planLogicalMutation(input: {
  current: LogicalMutation | null;
  action: LogicalAction;
  payloadKey: string;
  createId: () => string;
}):
  | { blocked: true; mutation: LogicalMutation }
  | { blocked: false; reused: boolean; mutation: LogicalMutation } {
  const current = input.current;
  if (current?.phase === 'inflight') return { blocked: true, mutation: current };
  if (current?.phase === 'unknown') {
    if (current.action === input.action && current.payloadKey === input.payloadKey) {
      return {
        blocked: false,
        reused: true,
        mutation: { ...current, phase: 'inflight' },
      };
    }
    return { blocked: true, mutation: current };
  }
  return {
    blocked: false,
    reused: false,
    mutation: {
      action: input.action,
      requestId: input.createId(),
      payloadKey: input.payloadKey,
      phase: 'inflight',
    },
  };
}

export function planSave(session: EnvSession):
  | { ok: false; message: string; diagnostics: TextPostprocessDiagnostic[] }
  | {
      ok: true;
      body: {
        expected_runtime_version: number | null;
        expected_draft_updated_at: string | null;
        expected_draft_digest: string | null;
        source: TextPostprocessDraftSource;
      };
    } {
  if (!session.server) {
    return { ok: false, message: '还没有读到当前环境的权威状态', diagnostics: [] };
  }
  const parsed = parseTextPostprocessDraft(persistableSource(session.local));
  if (!parsed.ok) {
    return { ok: false, message: '草稿结构无效，未保存', diagnostics: parsed.diagnostics };
  }
  return {
    ok: true,
    body: {
      expected_runtime_version: session.server.runtime_version,
      expected_draft_updated_at: session.server.draft?.updated_at ?? null,
      expected_draft_digest: session.server.draft?.content_digest ?? null,
      source: parsed.source,
    },
  };
}

export function planPublish(session: EnvSession):
  | { ok: false; reason: 'dirty' | 'no_saved_draft' | 'no_server' }
  | {
      ok: true;
      body: {
        expected_runtime_version: number | null;
        expected_draft_updated_at: string;
        expected_draft_digest: string;
        draft_revision: string;
      };
    } {
  if (!session.server) return { ok: false, reason: 'no_server' };
  if (isDirty(session)) return { ok: false, reason: 'dirty' };
  const draft = session.server.draft;
  if (!draft?.source || !draft.draft_revision || !draft.updated_at || !draft.content_digest) {
    return { ok: false, reason: 'no_saved_draft' };
  }
  return {
    ok: true,
    body: {
      expected_runtime_version: session.server.runtime_version,
      expected_draft_updated_at: draft.updated_at,
      expected_draft_digest: draft.content_digest,
      draft_revision: draft.draft_revision,
    },
  };
}

export function planDiscard(
  session: EnvSession
):
  | { ok: false; reason: 'no_saved_draft' | 'no_server' }
  | { ok: true; body: { expected_draft_updated_at: string; expected_draft_digest: string } } {
  if (!session.server) return { ok: false, reason: 'no_server' };
  const draft = session.server.draft;
  if (!draft?.updated_at || !draft.content_digest) return { ok: false, reason: 'no_saved_draft' };
  return {
    ok: true,
    body: {
      expected_draft_updated_at: draft.updated_at,
      expected_draft_digest: draft.content_digest,
    },
  };
}

export function planRollback(
  session: EnvSession,
  targetVersion: number | null
):
  | { ok: false; reason: 'no_runtime' | 'no_target' | 'no_server' }
  | { ok: true; body: { expected_runtime_version: number; target_version: number } } {
  if (!session.server) return { ok: false, reason: 'no_server' };
  if (session.server.runtime_version === null) return { ok: false, reason: 'no_runtime' };
  if (targetVersion === null || !Number.isInteger(targetVersion) || targetVersion < 1) {
    return { ok: false, reason: 'no_target' };
  }
  return {
    ok: true,
    body: {
      expected_runtime_version: session.server.runtime_version,
      target_version: targetVersion,
    },
  };
}

export function describeRollbackOutcome(outcome: TextPostprocessMutationOutcome): string {
  const replay = outcome.replayed ? '这是同一请求的重放结果。' : '这是新的发布结果。';
  if (outcome.version && outcome.target_version) {
    return `已创建新发布版本 ${outcome.version}，来源是版本 ${outcome.target_version}。旧快照没有被修改。${replay}`;
  }
  return `回滚请求已确认，但响应没有同时给出新版本和来源版本。请以重新读取的正式版本为准。${replay}`;
}

export function validationUnavailableNotice(): WorkbenchNotice {
  return {
    tone: 'warning',
    code: 'VALIDATION_UNAVAILABLE',
    title: '校验服务暂不可用',
    detail:
      '这不是字段格式错误，规则内容没有被判定为写错。请稍后重试；不要把它当成普通校验失败去改字段。',
  };
}

export function casConflictNotice(session: EnvSession): WorkbenchNotice {
  const localIds = session.local.rules.map((rule) => rule.id).join('、') || '（空）';
  const serverRules =
    session.server?.draft?.source?.rules ?? session.server?.published?.source?.rules ?? [];
  const serverIds = serverRules.map((rule) => rule.id).join('、') || '（空）';
  return {
    tone: 'warning',
    code: 'cas_conflict',
    title: '草稿或正式版本已变化',
    detail: `本地编辑已保留。本地规则：${clip(localIds, 180)}。当前服务端规则：${clip(serverIds, 180)}。请重新载入后再决定是否覆盖。`,
  };
}

export function selectedRule(
  local: EditableSource,
  selectedRuleId: string | null
): EditableRule | null {
  if (!selectedRuleId) return null;
  return local.rules.find((rule) => rule.id === selectedRuleId) ?? null;
}

export function filterRules(
  rules: readonly EditableRule[],
  query: string,
  status: 'all' | 'enabled' | 'disabled'
): EditableRule[] {
  const needle = query.trim().toLowerCase();
  return rules.filter((rule) => {
    if (status === 'enabled' && !rule.enabled) return false;
    if (status === 'disabled' && rule.enabled) return false;
    if (!needle) return true;
    return [rule.id, rule.name, rule.pattern, rule.description].some((value) =>
      value.toLowerCase().includes(needle)
    );
  });
}

export function moveRule(
  local: EditableSource,
  ruleId: string,
  direction: 'up' | 'down'
): EditableSource {
  const index = local.rules.findIndex((rule) => rule.id === ruleId);
  const target = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || target < 0 || target >= local.rules.length) return local;
  const rules = local.rules.slice();
  const current = rules[index];
  const other = rules[target];
  if (!current || !other) return local;
  rules[index] = other;
  rules[target] = current;
  return { ...local, rules };
}

export function updateRuleField(
  local: EditableSource,
  ruleId: string,
  field: RuleTextField,
  value: string
): EditableSource {
  return {
    ...local,
    rules: local.rules.map((rule) => (rule.id === ruleId ? { ...rule, [field]: value } : rule)),
  };
}

export function setRuleEnabled(
  local: EditableSource,
  ruleId: string,
  enabled: boolean
): EditableSource {
  return {
    ...local,
    rules: local.rules.map((rule) => (rule.id === ruleId ? { ...rule, enabled } : rule)),
  };
}

export function createRuleId(existing: readonly string[]): string {
  let index = existing.length + 1;
  let id = `rule_${index}`;
  const taken = new Set(existing);
  while (taken.has(id) || !TEXT_POSTPROCESS_RULE_ID.test(id)) {
    index += 1;
    id = `rule_${index}`;
    if (index > existing.length + 10_000) throw new Error('rule id space exhausted');
  }
  return id;
}

export function insertRule(
  local: EditableSource,
  rule: EditableRule,
  afterId: string | null
): EditableSource {
  const rules = local.rules.slice();
  const index = afterId ? rules.findIndex((item) => item.id === afterId) : -1;
  rules.splice(index >= 0 ? index + 1 : rules.length, 0, rule);
  return { ...local, rules };
}

export function duplicateRule(
  local: EditableSource,
  ruleId: string
): { local: EditableSource; selectedRuleId: string } | null {
  const rule = selectedRule(local, ruleId);
  if (!rule) return null;
  const id = createRuleId(local.rules.map((item) => item.id));
  const copy: EditableRule = {
    ...rule,
    id,
    name: `${rule.name} 副本`.slice(0, 80),
    enabled: false,
  };
  return { local: insertRule(local, copy, ruleId), selectedRuleId: id };
}

export function deleteRule(
  local: EditableSource,
  ruleId: string
): { local: EditableSource; selectedRuleId: string | null } {
  const index = local.rules.findIndex((rule) => rule.id === ruleId);
  if (index < 0) return { local, selectedRuleId: ruleId };
  const rules = local.rules.filter((rule) => rule.id !== ruleId);
  const next = rules[index] ?? rules[index - 1] ?? null;
  return { local: { ...local, rules }, selectedRuleId: next?.id ?? null };
}

export function commitRuleId(
  local: EditableSource,
  ruleId: string,
  nextId: string,
  selectedRuleId: string | null
): { local: EditableSource; selectedRuleId: string | null; error: string | null } {
  if (!TEXT_POSTPROCESS_RULE_ID.test(nextId)) {
    return {
      local,
      selectedRuleId,
      error: '规则编号需以小写字母开头，只能包含小写字母、数字、下划线和连字符',
    };
  }
  if (local.rules.some((rule) => rule.id === nextId && rule.id !== ruleId)) {
    return { local, selectedRuleId, error: '规则编号重复' };
  }
  return {
    local: {
      ...local,
      rules: local.rules.map((rule) => (rule.id === ruleId ? { ...rule, id: nextId } : rule)),
    },
    selectedRuleId: selectedRuleId === ruleId ? nextId : selectedRuleId,
    error: null,
  };
}

export function summarizeVersionChange(
  current: TextPostprocessVersionSnapshot,
  previous: TextPostprocessVersionSnapshot | null
): string {
  if (!previous) return '当前页没有更早的可比版本';
  const before = new Map(previous.source.rules.map((rule) => [rule.id, rule]));
  const after = new Map(current.source.rules.map((rule) => [rule.id, rule]));
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];
  for (const [id, rule] of after) {
    const prior = before.get(id);
    if (!prior) {
      added.push(id);
      continue;
    }
    if (canonicalTextPostprocessJson(prior) !== canonicalTextPostprocessJson(rule))
      changed.push(id);
  }
  for (const id of before.keys()) {
    if (!after.has(id)) removed.push(id);
  }
  if (added.length === 0 && removed.length === 0 && changed.length === 0) return '规则内容未变化';
  return clip(
    [
      added.length ? `新增 ${added.join('、')}` : '',
      removed.length ? `删除 ${removed.join('、')}` : '',
      changed.length ? `修改 ${changed.join('、')}` : '',
    ]
      .filter(Boolean)
      .join('；'),
    180
  );
}

export interface StreamSim {
  phase: 'idle' | 'running' | 'paused';
  visibleUnits: number;
}

export function reduceStreamSim(
  state: StreamSim,
  event: 'start' | 'pause' | 'resume' | 'reset' | 'tick',
  total: number,
  step = 1
): StreamSim {
  if (event === 'reset') return { phase: 'idle', visibleUnits: 0 };
  if (event === 'start') return { phase: 'running', visibleUnits: 0 };
  if (event === 'pause')
    return {
      phase: state.phase === 'running' ? 'paused' : state.phase,
      visibleUnits: state.visibleUnits,
    };
  if (event === 'resume') {
    return {
      phase: state.phase === 'paused' ? 'running' : state.phase,
      visibleUnits: state.visibleUnits,
    };
  }
  if (state.phase !== 'running') return state;
  const next = Math.min(total, state.visibleUnits + step);
  return { phase: next >= total ? 'paused' : 'running', visibleUnits: next };
}

export function visibleSample(sample: string, units: number): string {
  return [...sample].slice(0, Math.max(0, units)).join('');
}

export interface LocalChoiceSim {
  text: string | null;
  networkCalls: number;
}

export function applyLocalChoice(state: LocalChoiceSim, text: string): LocalChoiceSim {
  if (state.text !== null) return state;
  return { text, networkCalls: state.networkCalls };
}

function keepSelection(local: EditableSource, selectedRuleId: string | null): string | null {
  if (selectedRuleId && local.rules.some((rule) => rule.id === selectedRuleId))
    return selectedRuleId;
  return local.rules[0]?.id ?? null;
}

function mergeHistory(
  current: readonly TextPostprocessVersionSnapshot[],
  page: readonly TextPostprocessVersionSnapshot[]
): TextPostprocessVersionSnapshot[] {
  const byVersion = new Map<number, TextPostprocessVersionSnapshot>();
  for (const item of [...current, ...page]) byVersion.set(item.version, item);
  return sortHistory([...byVersion.values()]);
}

function sortHistory(
  history: readonly TextPostprocessVersionSnapshot[]
): TextPostprocessVersionSnapshot[] {
  return history.slice().sort((left, right) => right.version - left.version);
}

function replaceSession(
  store: WorkbenchStore,
  environment: AdminEnvironment,
  session: EnvSession
): WorkbenchStore {
  return { sessions: { ...store.sessions, [environment]: session } };
}

function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
