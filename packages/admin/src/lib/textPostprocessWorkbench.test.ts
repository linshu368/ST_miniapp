import { describe, expect, it } from 'vitest';
import {
  TEXT_POSTPROCESS_POLICY_VERSION,
  TEXT_POSTPROCESS_SCHEMA_VERSION,
  type TextPostprocessAdminState,
  type TextPostprocessDraftSource,
  type TextPostprocessRule,
} from '@miniapp/shared';
import { compileTextPostprocessSource } from '@miniapp/shared/src/text-postprocess/compile';
import { STARTER_RULES } from './textPostprocessSamples';
import {
  acceptLoadedState,
  applyLocalChoice,
  beginLoad,
  casConflictNotice,
  createRuleId,
  createWorkbenchStore,
  deleteRule,
  describeRollbackOutcome,
  duplicateRule,
  editableFromSource,
  filterRules,
  finishRejected,
  historyCurrentVersion,
  isDirty,
  markMutationUnknown,
  moveRule,
  planLogicalMutation,
  planPublish,
  planRollback,
  planSave,
  productionWriteConfirm,
  publishedAvailability,
  putMutation,
  reduceStreamSim,
  replaceLocal,
  selectedRule,
  sessionEditSignature,
  shouldAcceptAsyncResult,
  textPostprocessCanMutate,
  type WorkbenchStore,
} from './textPostprocessWorkbench';

const DIGEST = 'b'.repeat(64);

function rule(id: string, pattern = id): TextPostprocessRule {
  return {
    id,
    name: id,
    description: '',
    enabled: false,
    pattern,
    flags: 'g',
    replacement: '<span>$&</span>',
    css: '',
    notes: '',
  };
}

function source(rules: TextPostprocessRule[]): TextPostprocessDraftSource {
  return {
    schema_version: TEXT_POSTPROCESS_SCHEMA_VERSION,
    policy_version: TEXT_POSTPROCESS_POLICY_VERSION,
    rules,
  };
}

function serverState(input?: {
  runtime?: number | null;
  publishedPattern?: string | null;
  draftPattern?: string | null;
  historyVersions?: number[];
  hasMore?: boolean;
}): TextPostprocessAdminState {
  const runtime = input?.runtime === undefined ? 2 : input.runtime;
  const publishedPattern =
    input?.publishedPattern === undefined ? 'published' : input.publishedPattern;
  const draftPattern = input?.draftPattern === undefined ? 'draft' : input.draftPattern;
  return {
    runtime_version: runtime,
    published:
      publishedPattern === null || runtime === null
        ? null
        : {
            version: runtime,
            schema_version: TEXT_POSTPROCESS_SCHEMA_VERSION,
            policy_version: TEXT_POSTPROCESS_POLICY_VERSION,
            source: source([rule('highlight', publishedPattern)]),
            published_at: '2026-09-28T00:00:00.000Z',
          },
    draft:
      draftPattern === null
        ? null
        : {
            draft_revision: 'draft-1',
            updated_at: '2026-09-28T01:00:00.000Z',
            content_digest: DIGEST,
            base_version: runtime ?? 0,
            source: source([rule('highlight', draftPattern)]),
          },
    history: (input?.historyVersions ?? [5, 2]).map((version) => ({
      version,
      schema_version: TEXT_POSTPROCESS_SCHEMA_VERSION,
      policy_version: TEXT_POSTPROCESS_POLICY_VERSION,
      source: source([rule('highlight', `v${version}`)]),
      published_at: '2026-09-28T00:00:00.000Z',
    })),
    has_more: input?.hasMore ?? false,
  };
}

function load(
  environment: 'test' | 'production',
  state: TextPostprocessAdminState,
  store = createWorkbenchStore()
): WorkbenchStore {
  const started = beginLoad(store, environment);
  const signature = sessionEditSignature(started.store.sessions[environment]);
  const next = acceptLoadedState({
    store: started.store,
    environment,
    generation: started.generation,
    server: state,
    mode: 'replace',
    signatureAtStart: signature,
    preferServerLocal: true,
  });
  if (!next) throw new Error('load was ignored');
  return next;
}

describe('text postprocess workbench', () => {
  it('keeps viewer read only and separates environment access', () => {
    expect(
      textPostprocessCanMutate({
        role: 'viewer',
        environment: 'test',
        canAccessTest: true,
        canAccessProd: true,
      })
    ).toBe(false);
    expect(
      textPostprocessCanMutate({
        role: 'operator',
        environment: 'production',
        canAccessTest: true,
        canAccessProd: false,
      })
    ).toBe(false);
    expect(
      textPostprocessCanMutate({
        role: 'owner',
        environment: 'production',
        canAccessTest: false,
        canAccessProd: true,
      })
    ).toBe(true);
  });

  it('distinguishes published, saved draft, and unsaved local edits', () => {
    const loaded = load('test', serverState());
    const session = loaded.sessions.test;
    expect(isDirty(session)).toBe(false);
    expect(session.local.rules[0]?.pattern).toBe('draft');
    expect(session.server?.published?.source.rules[0]?.pattern).toBe('published');
    const edited = replaceLocal(
      loaded,
      'test',
      editableFromSource(source([rule('highlight', 'local')])),
      'highlight'
    );
    expect(isDirty(edited.sessions.test)).toBe(true);
    expect(edited.sessions.test.server?.draft?.source?.rules[0]?.pattern).toBe('draft');
  });

  it('does not let a stale environment response replace the active session', () => {
    let store = createWorkbenchStore();
    const testLoad = beginLoad(store, 'test');
    store = testLoad.store;
    const ignored = acceptLoadedState({
      store,
      environment: 'test',
      generation: testLoad.generation - 1,
      server: serverState({ draftPattern: 'late' }),
      mode: 'replace',
      signatureAtStart: sessionEditSignature(store.sessions.test),
      preferServerLocal: true,
    });
    expect(ignored).toBeNull();
    const prodLoad = beginLoad(store, 'production');
    const prodSession = prodLoad.store.sessions.production;
    const accepted = acceptLoadedState({
      store: prodLoad.store,
      environment: 'test',
      generation: testLoad.generation,
      server: serverState({ draftPattern: 'from-test' }),
      mode: 'replace',
      signatureAtStart: sessionEditSignature(prodLoad.store.sessions.test),
      preferServerLocal: true,
    });
    if (!accepted) throw new Error('fresh test response was ignored');
    expect(accepted.sessions.production).toBe(prodSession);
    expect(accepted.sessions.test.local.rules[0]?.pattern).toBe('from-test');
    expect(accepted.sessions.production.local.rules).toEqual([]);
  });

  it('keeps editing the same rule id after the list is reordered', () => {
    const loaded = load('test', serverState({ draftPattern: 'middle' }));
    const local = editableFromSource(
      source([rule('alpha', 'A'), rule('beta', 'B'), rule('gamma', 'C')])
    );
    const moved = moveRule(local, 'beta', 'down');
    expect(moved.rules.map((item) => item.id)).toEqual(['alpha', 'gamma', 'beta']);
    expect(selectedRule(moved, 'beta')?.pattern).toBe('B');
    const hidden = filterRules(moved.rules, 'alpha', 'all');
    expect(hidden.map((item) => item.id)).toEqual(['alpha']);
    expect(selectedRule(moved, 'beta')?.pattern).toBe('B');
    const removed = deleteRule(moved, 'gamma');
    expect(removed.selectedRuleId).toBe('beta');
  });

  it('publishes only the saved draft revision and refuses unsaved local edits', () => {
    const loaded = load('test', serverState());
    const clean = planPublish(loaded.sessions.test);
    expect(clean.ok).toBe(true);
    if (!clean.ok) return;
    expect(clean.body.draft_revision).toBe('draft-1');
    expect(clean.body.expected_draft_digest).toBe(DIGEST);
    expect(clean.body).not.toHaveProperty('source');
    const edited = replaceLocal(
      loaded,
      'test',
      editableFromSource(source([rule('highlight', 'local-only')])),
      'highlight'
    );
    expect(planPublish(edited.sessions.test)).toEqual({ ok: false, reason: 'dirty' });
    const saved = planSave(edited.sessions.test);
    expect(saved.ok).toBe(true);
    if (!saved.ok) return;
    expect(saved.body.source.rules[0]?.pattern).toBe('local-only');
    expect(saved.body.expected_draft_digest).toBe(DIGEST);
  });

  it('keeps the local draft when the server reports a CAS conflict', () => {
    const loaded = load('test', serverState());
    const edited = replaceLocal(
      loaded,
      'test',
      editableFromSource(source([rule('highlight', 'keep-me')])),
      'highlight'
    );
    const withMutation = putMutation(edited, 'test', {
      action: 'save',
      requestId: '00000000-0000-4000-8000-000000000009',
      payloadKey: 'same',
      phase: 'inflight',
    });
    const rejected = finishRejected({
      store: withMutation,
      environment: 'test',
      requestId: '00000000-0000-4000-8000-000000000009',
      notice: casConflictNotice(withMutation.sessions.test),
      diagnostics: [],
    });
    if (!rejected) throw new Error('conflict was ignored');
    expect(rejected.sessions.test.local.rules[0]?.pattern).toBe('keep-me');
    expect(rejected.sessions.test.mutation).toBeNull();
    expect(rejected.sessions.test.notice?.code).toBe('cas_conflict');
  });

  it('reuses one request id for the same logical operation and blocks a different payload while unknown', () => {
    const first = planLogicalMutation({
      current: null,
      action: 'publish',
      payloadKey: 'saved-revision',
      createId: () => '00000000-0000-4000-8000-000000000010',
    });
    expect(first.blocked).toBe(false);
    if (first.blocked) return;
    const unknown = { ...first.mutation, phase: 'unknown' as const };
    const retried = planLogicalMutation({
      current: unknown,
      action: 'publish',
      payloadKey: 'saved-revision',
      createId: () => {
        throw new Error('new id');
      },
    });
    expect(retried.blocked).toBe(false);
    if (retried.blocked) return;
    expect(retried.reused).toBe(true);
    expect(retried.mutation.requestId).toBe(first.mutation.requestId);
    const changed = planLogicalMutation({
      current: unknown,
      action: 'publish',
      payloadKey: 'different-revision',
      createId: () => {
        throw new Error('new id');
      },
    });
    expect(changed.blocked).toBe(true);
    if (!changed.blocked) return;
    expect(changed.mutation.requestId).toBe(first.mutation.requestId);
  });

  it('marks an unknown result without replacing local content', () => {
    const loaded = replaceLocal(
      load('test', serverState()),
      'test',
      editableFromSource(source([rule('highlight', 'still-local')])),
      'highlight'
    );
    const pending = putMutation(loaded, 'test', {
      action: 'publish',
      requestId: '00000000-0000-4000-8000-000000000011',
      payloadKey: 'publish',
      phase: 'inflight',
    });
    const unknown = markMutationUnknown(pending, 'test', '00000000-0000-4000-8000-000000000011');
    expect(unknown.sessions.test.local.rules[0]?.pattern).toBe('still-local');
    expect(unknown.sessions.test.mutation).toMatchObject({
      phase: 'unknown',
      requestId: '00000000-0000-4000-8000-000000000011',
    });
    expect(unknown.sessions.test.notice?.code).toBe('RESULT_UNKNOWN');
  });

  it('describes rollback as a new release and does not treat the highest history version as current', () => {
    const text = describeRollbackOutcome({
      action: 'rollback',
      replayed: false,
      version: 6,
      target_version: 2,
    });
    expect(text).toContain('新发布版本 6');
    expect(text).toContain('来源是版本 2');
    expect(text).toContain('旧快照没有被修改');
    const loaded = load('test', serverState({ historyVersions: [9, 2], runtime: 2 }));
    expect(historyCurrentVersion(loaded.sessions.test.server)).toBe(2);
    expect(Math.max(...loaded.sessions.test.history.map((item) => item.version))).toBe(9);
    const unavailable = load(
      'production',
      serverState({ runtime: 4, publishedPattern: null, draftPattern: null, historyVersions: [9] })
    );
    expect(publishedAvailability(unavailable.sessions.production.server)).toEqual({
      status: 'unavailable',
      runtimeVersion: 4,
    });
    expect(historyCurrentVersion(unavailable.sessions.production.server)).toBeNull();
    expect(planRollback(unavailable.sessions.production, 9).ok).toBe(true);
  });

  it('drops async results after unmount or an environment switch', () => {
    expect(
      shouldAcceptAsyncResult({
        mounted: false,
        environment: 'test',
        activeEnvironment: 'test',
        generation: 2,
        responseGeneration: 2,
      })
    ).toBe(false);
    expect(
      shouldAcceptAsyncResult({
        mounted: true,
        environment: 'test',
        activeEnvironment: 'production',
        generation: 2,
        responseGeneration: 2,
      })
    ).toBe(false);
    expect(
      shouldAcceptAsyncResult({
        mounted: true,
        environment: 'production',
        activeEnvironment: 'production',
        generation: 3,
        responseGeneration: 2,
      })
    ).toBe(false);
  });

  it('requires an explicit production confirmation and keeps choice simulation local', () => {
    const confirm = productionWriteConfirm('production', '发布');
    expect(confirm.required).toBe(true);
    expect(confirm.content).toContain('生产环境');
    expect(confirm.content).toContain('不是测试环境');
    expect(productionWriteConfirm('test', '发布').required).toBe(false);
    const choice = applyLocalChoice({ text: null, networkCalls: 0 }, '留下');
    expect(choice).toEqual({ text: '留下', networkCalls: 0 });
    expect(applyLocalChoice(choice, '离开')).toBe(choice);
  });

  it('pauses and resets mock streaming without reading a model', () => {
    const started = reduceStreamSim({ phase: 'idle', visibleUnits: 0 }, 'start', 10);
    const ticked = reduceStreamSim(started, 'tick', 10, 4);
    const paused = reduceStreamSim(ticked, 'pause', 10);
    expect(paused).toEqual({ phase: 'paused', visibleUnits: 4 });
    expect(reduceStreamSim(paused, 'reset', 10)).toEqual({ phase: 'idle', visibleUnits: 0 });
  });

  it('copies a rule into a disabled rule with a new id', () => {
    const local = editableFromSource(source([rule('alpha', 'A')]));
    const copied = duplicateRule(local, 'alpha');
    expect(copied?.selectedRuleId).toBe(createRuleId(['alpha']));
    expect(copied?.local.rules[1]?.enabled).toBe(false);
    expect(copied?.local.rules[0]?.id).toBe('alpha');
  });

  it('compiles the starter templates with the shared compiler', () => {
    const result = compileTextPostprocessSource({
      schema_version: TEXT_POSTPROCESS_SCHEMA_VERSION,
      policy_version: TEXT_POSTPROCESS_POLICY_VERSION,
      rules: STARTER_RULES.map((item) => ({ ...item, enabled: true })),
    });
    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  });
});
