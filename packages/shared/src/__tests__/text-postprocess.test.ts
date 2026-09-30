import { describe, expect, it } from 'vitest';

import type { ChatMessage, ConversationStreamStartEvent } from '../api/conversations';
import {
  DiscardTextPostprocessDraftRequestSchema,
  PublishTextPostprocessRequestSchema,
  ReadTextPostprocessVersionsDataSchema,
  ReadTextPostprocessVersionsRequestSchema,
  RollbackTextPostprocessRequestSchema,
  SaveTextPostprocessDraftRequestSchema,
  TEXT_POSTPROCESS_POLICY_VERSION,
  TEXT_POSTPROCESS_SCHEMA_VERSION,
  TextPostprocessMutationErrorSchema,
  TextPostprocessVersionSnapshotSchema,
  TextPostprocessArtifactSnapshotSchema,
  assessRequestReplay,
  canonicalTextPostprocessJson,
  outputTextLimit,
  parseTextPostprocessDraft,
  parseTextPostprocessSource,
  readPostprocessVersion,
  type TextPostprocessRule,
  type TextPostprocessSource,
} from '../api/text-postprocess';
import { applyTextPostprocess } from '../text-postprocess/apply';
import { compileTextPostprocessSource } from '../text-postprocess/compile';
import { resolveTrustedTree } from '../text-postprocess/resolve-tree';
import {
  prepareSlotTransport,
  resolveTransportedTextNodes,
} from '../text-postprocess/slot-transport';
import * as textPostprocessRuntime from '../text-postprocess/runtime';

const REQUEST_ID = '00000000-0000-4000-8000-000000000001';
const DIGEST = 'a'.repeat(64);

function rule(overrides: Partial<TextPostprocessRule> = {}): TextPostprocessRule {
  return {
    id: 'highlight',
    name: 'Highlight',
    description: '',
    enabled: true,
    pattern: 'foo',
    flags: 'g',
    replacement: '<span>$&</span>',
    css: '',
    notes: '',
    ...overrides,
  };
}

function source(rules: TextPostprocessRule[]): TextPostprocessSource {
  return {
    schema_version: TEXT_POSTPROCESS_SCHEMA_VERSION,
    policy_version: TEXT_POSTPROCESS_POLICY_VERSION,
    rules,
  };
}

function compileOk(rules: TextPostprocessRule[]) {
  const result = compileTextPostprocessSource(source(rules));
  expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
  if (!result.artifact) throw new Error('missing artifact');
  return result.artifact;
}

describe('text postprocess source schema', () => {
  it('accepts a bounded source and rejects unknown fields, duplicate ids, flags, and capacity', () => {
    expect(parseTextPostprocessSource(source([rule()])).ok).toBe(true);

    const unknown = parseTextPostprocessSource({ ...source([rule()]), extra: true });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.diagnostics[0]?.code).toBe('UNKNOWN_FIELD');

    const duplicate = parseTextPostprocessSource(source([rule(), rule({ name: 'Copy' })]));
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) {
      expect(duplicate.diagnostics.some((item) => item.code === 'DUPLICATE_RULE_ID')).toBe(true);
      expect(duplicate.diagnostics.some((item) => item.field === 'id')).toBe(true);
    }

    for (const flags of ['y', 'gg', 'v', 'G']) {
      const parsed = parseTextPostprocessSource(source([rule({ flags })]));
      expect(parsed.ok, flags).toBe(false);
      if (!parsed.ok)
        expect(parsed.diagnostics.some((item) => item.code === 'INVALID_FLAGS')).toBe(true);
    }

    const longPattern = parseTextPostprocessSource(source([rule({ pattern: 'a'.repeat(2001) })]));
    expect(longPattern.ok).toBe(false);
    if (!longPattern.ok) {
      expect(longPattern.diagnostics.some((item) => item.code === 'CAPACITY_EXCEEDED')).toBe(true);
    }

    const draft = parseTextPostprocessDraft(source([rule({ flags: 'y', pattern: '(' })]));
    expect(draft.ok).toBe(true);
    const draftUnknown = parseTextPostprocessDraft({ ...source([rule()]), extra: 1 });
    expect(draftUnknown.ok).toBe(false);
  });

  it('keeps diagnostic text free of the submitted template', () => {
    const secret = 'super-secret-template-value';
    const parsed = parseTextPostprocessSource({
      ...source([rule({ replacement: `<script>${secret}</script>` })]),
      leaked: secret,
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(JSON.stringify(parsed.diagnostics)).not.toContain(secret);
    }
  });
});

describe('capture compilation', () => {
  it('compiles numbered, named, full-match, and escaped dollar tokens as text refs', () => {
    const artifact = compileOk([
      rule({
        id: 'named',
        pattern: String.raw`(?<user>[A-Za-z]+)-(\d+)`,
        flags: '',
        replacement: '<span>$<user> $$ $& $2 $12</span>',
      }),
    ]);
    const span = artifact.rules[0]?.tree[0];
    expect(span?.type).toBe('element');
    if (span?.type !== 'element') return;
    expect(
      span.children.map((node) => {
        if (node.type === 'capture') return node.ref;
        if (node.type === 'text') return node.text;
        return node.tag;
      })
    ).toEqual([
      { kind: 'name', name: 'user' },
      ' $ ',
      { kind: 'match' },
      ' ',
      { kind: 'number', index: 2 },
      ' ',
      { kind: 'number', index: 1 },
      '2',
    ]);
    expect(span.children.some((node) => node.type === 'element')).toBe(false);
  });

  it('rejects missing groups and capture tokens inside attributes', () => {
    const missing = compileTextPostprocessSource(
      source([rule({ pattern: '(a)', replacement: '<span>$2</span>' })])
    );
    expect(missing.ok).toBe(false);
    expect(missing.artifact).toBeNull();
    expect(missing.diagnostics.some((item) => item.code === 'UNKNOWN_CAPTURE')).toBe(true);

    const attribute = compileTextPostprocessSource(
      source([rule({ pattern: '(a)', replacement: '<span title="$1">x</span>' })])
    );
    expect(attribute.diagnostics.some((item) => item.code === 'CAPTURE_IN_ATTRIBUTE')).toBe(true);
    expect(JSON.stringify(attribute.diagnostics)).not.toContain('title="$1"');
  });
});

describe('segment application', () => {
  it('applies order, overlap, non-global, multiline, misses, and empty-match rejection', () => {
    const artifact = compileOk([
      rule({ id: 'first', pattern: 'ab', replacement: '<mark>$&</mark>' }),
      rule({ id: 'second', pattern: 'b', replacement: '<span>$&</span>' }),
      rule({ id: 'later', pattern: 'z', flags: '', replacement: '<em>$&</em>' }),
    ]);
    const applied = applyTextPostprocess({ text: 'ab z z', artifact });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') return;
    expect(applied.segments.map((segment) => segment.type)).toEqual([
      'slot',
      'text',
      'slot',
      'text',
    ]);
    expect(
      applied.segments
        .filter((segment) => segment.type === 'slot')
        .map((segment) => segment.rule_id)
    ).toEqual(['first', 'later']);
    expect(
      applied.segments.some((segment) => segment.type === 'slot' && segment.rule_id === 'second')
    ).toBe(false);

    const multiline = compileOk([
      rule({ id: 'cross', pattern: 'a.b', flags: 's', replacement: '<span>$&</span>' }),
    ]);
    const crossed = applyTextPostprocess({ text: 'a\nb', artifact: multiline });
    expect(crossed.status).toBe('applied');
    if (crossed.status === 'applied') {
      expect(crossed.segments).toEqual([
        expect.objectContaining({ type: 'slot', start: 0, end: 3, match_text: 'a\nb' }),
      ]);
    }

    const missed = applyTextPostprocess({ text: 'nothing', artifact });
    expect(missed.status).toBe('applied');
    if (missed.status === 'applied') {
      expect(missed.segments).toEqual([{ type: 'text', text: 'nothing', start: 0, end: 7 }]);
    }

    const empty = compileTextPostprocessSource(source([rule({ pattern: 'a*', flags: 'g' })]));
    expect(empty.diagnostics.some((item) => item.code === 'EMPTY_MATCH')).toBe(true);
  });

  it('does not let a later rule read text already consumed by an earlier component', () => {
    const artifact = compileOk([
      rule({ id: 'consume', pattern: 'x', flags: '', replacement: '<mark>$&</mark>' }),
      rule({ id: 'rest', pattern: 'a', flags: '', replacement: '<span>$&</span>' }),
    ]);
    const applied = applyTextPostprocess({ text: 'a x a', artifact });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') return;
    const slots = applied.segments.filter((segment) => segment.type === 'slot');
    expect(slots.map((slot) => [slot.rule_id, slot.match_text])).toEqual([
      ['rest', 'a'],
      ['consume', 'x'],
    ]);
    expect(
      applied.segments.some((segment) => segment.type === 'text' && segment.text.includes('a'))
    ).toBe(true);
  });
});

describe('html and css policy', () => {
  it('rejects tag, attribute, namespace, and forged action escapes with locations', () => {
    const script = compileTextPostprocessSource(
      source([rule({ replacement: '<script>alert(1)</script>' })])
    );
    const scriptDiagnostic = script.diagnostics.find((item) => item.code === 'FORBIDDEN_TAG');
    expect(scriptDiagnostic?.location).toMatchObject({ line: 1, column: 1, offset: 0 });
    expect(JSON.stringify(script.diagnostics)).not.toContain('alert(1)');

    const handler = compileTextPostprocessSource(
      source([rule({ replacement: '<span onclick="alert(1)">x</span>' })])
    );
    expect(handler.diagnostics.some((item) => item.code === 'FORBIDDEN_ATTRIBUTE')).toBe(true);

    const forged = compileTextPostprocessSource(
      source([rule({ pattern: '(a)', replacement: '<button data-action="launch">$1</button>' })])
    );
    expect(forged.diagnostics.some((item) => item.code === 'FORBIDDEN_ATTRIBUTE')).toBe(true);

    const svg = compileTextPostprocessSource(source([rule({ replacement: '<svg><g></g></svg>' })]));
    expect(svg.diagnostics.some((item) => item.code === 'FORBIDDEN_TAG')).toBe(true);

    const comment = compileTextPostprocessSource(
      source([rule({ replacement: '<p>ok</p><!--hide-->' })])
    );
    expect(comment.diagnostics.some((item) => item.code === 'HTML_COMMENT')).toBe(true);

    const implicit = compileTextPostprocessSource(
      source([rule({ replacement: '<table><tr><td>a</td></tr></table>' })])
    );
    expect(implicit.diagnostics.some((item) => item.code === 'HTML_IMPLICIT_NODE')).toBe(true);
  });

  it('keeps model-authored actions as text and only trusts compiler-built buttons', () => {
    const artifact = compileOk([
      rule({
        id: 'choice',
        pattern: String.raw`\[choice\](<script>alert\(1\)</script>)`,
        flags: '',
        replacement: '<button>$1</button>',
      }),
    ]);
    const model = '<button data-action="send-message">hi</button>';
    const untouched = applyTextPostprocess({ text: model, artifact });
    expect(untouched.status).toBe('applied');
    if (untouched.status === 'applied') {
      expect(untouched.segments).toEqual([
        { type: 'text', text: model, start: 0, end: model.length },
      ]);
    }

    const applied = applyTextPostprocess({
      text: 'before [choice]<script>alert(1)</script> after',
      artifact,
    });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') return;
    const slot = applied.segments.find((segment) => segment.type === 'slot');
    expect(slot?.type).toBe('slot');
    if (slot?.type !== 'slot') return;
    expect(slot.tree[0]).toMatchObject({
      type: 'element',
      tag: 'button',
      action: { type: 'send-message' },
    });
    const resolved = resolveTrustedTree(slot.tree, slot.match_text, slot.captures);
    expect(resolved[0]).toMatchObject({
      type: 'element',
      children: [{ type: 'text', text: '<script>alert(1)</script>' }],
    });
    expect(slot.choices).toEqual([{ text: '<script>alert(1)</script>', sendable: true }]);
  });

  it('rejects selector, property, resource, and layout escapes and accepts a safe rule', () => {
    const cases: Array<[string, string]> = [
      ['body { color: red }', 'FORBIDDEN_SELECTOR'],
      ['.card { position: fixed }', 'FORBIDDEN_PROPERTY'],
      ['.card { z-index: 3 }', 'FORBIDDEN_PROPERTY'],
      ['.card { margin: -4px }', 'FORBIDDEN_VALUE'],
      ['.card { background: url(https://evil.example/a.png) }', 'EXTERNAL_RESOURCE'],
      ['@import "https://evil.example/a.css";', 'EXTERNAL_RESOURCE'],
      ['.card { color: red !important }', 'CSS_IMPORTANT'],
    ];
    for (const [css, code] of cases) {
      const result = compileTextPostprocessSource(source([rule({ css })]));
      expect(
        result.diagnostics.some((item) => item.code === code),
        css
      ).toBe(true);
      expect(JSON.stringify(result.diagnostics)).not.toContain('evil.example');
      const located = result.diagnostics.find((item) => item.code === code);
      expect(located?.location?.line, css).toBe(1);
    }

    const safe = compileOk([
      rule({
        css: '@media (max-width: 480px) { .card { color: hsl(var(--foreground)); font-size: 14px; padding: 8px; } }',
      }),
    ]);
    expect(safe.rules[0]?.css[0]).toMatchObject({ type: 'media' });
  });
});

describe('budgets and degradation', () => {
  it('rejects deep templates and aborts expanded output back to the original text', () => {
    const deep = `<div>`.repeat(33) + 'x' + `</div>`.repeat(33);
    const depth = compileTextPostprocessSource(source([rule({ replacement: deep })]));
    expect(depth.diagnostics.some((item) => item.code === 'DEPTH_LIMIT')).toBe(true);

    const wide = '<span></span>'.repeat(1001);
    const nodes = compileTextPostprocessSource(source([rule({ replacement: wide })]));
    expect(nodes.diagnostics.some((item) => item.code === 'NODE_LIMIT')).toBe(true);

    const artifact = compileOk([
      rule({
        pattern: 'a',
        replacement: `<span>${'x'.repeat(400)}$&</span>`,
      }),
    ]);
    const input = 'a'.repeat(200);
    const applied = applyTextPostprocess({ text: input, artifact });
    expect(applied).toEqual({
      status: 'original',
      reason: 'OUTPUT_LIMIT',
      segments: [{ type: 'text', text: input, start: 0, end: input.length }],
    });
    expect(outputTextLimit(input.length)).toBeLessThan(500 * 200);
  });

  it('skips one rule at its match cap and fail-opens unknown versions', () => {
    const artifact = compileOk([rule({ pattern: 'a', replacement: '<span>$&</span>' })]);
    const input = 'a'.repeat(1501);
    const capped = applyTextPostprocess({ text: input, artifact });
    expect(capped.status).toBe('applied');
    if (capped.status === 'applied') {
      expect(capped.skipped_rules).toEqual([{ rule_id: 'highlight', code: 'RULE_MATCH_LIMIT' }]);
      expect(capped.segments).toEqual([{ type: 'text', text: input, start: 0, end: input.length }]);
    }

    const unknown = applyTextPostprocess({
      text: 'abc',
      artifact: { ...artifact, schema_version: 9 },
    });
    expect(unknown).toMatchObject({ status: 'original', reason: 'UNKNOWN_SCHEMA' });
    const policy = applyTextPostprocess({
      text: 'abc',
      artifact: { ...artifact, policy_version: 9 },
    });
    expect(policy).toMatchObject({
      status: 'original',
      reason: 'UNKNOWN_POLICY',
      segments: [{ type: 'text', text: 'abc', start: 0, end: 3 }],
    });
  });

  it('uses the injected clock and does not continue a rule after its budget', () => {
    const artifact = compileOk([rule()]);
    let tick = 0;
    const applied = applyTextPostprocess({
      text: 'foo foo',
      artifact,
      clock: () => {
        tick += 200;
        return tick;
      },
    });
    expect(applied.status).toBe('applied');
    if (applied.status === 'applied') {
      expect(applied.skipped_rules).toEqual([{ rule_id: 'highlight', code: 'RULE_BUDGET' }]);
      expect(applied.segments[0]).toMatchObject({ type: 'text', text: 'foo foo' });
    }
  });
});

describe('version contracts and slot transport', () => {
  it('treats missing and null postprocess versions as no version', () => {
    expect(readPostprocessVersion(undefined)).toBeNull();
    expect(readPostprocessVersion(null)).toBeNull();
    expect(readPostprocessVersion(0)).toBeNull();
    expect(readPostprocessVersion(1.5)).toBeNull();
    expect(readPostprocessVersion(4)).toBe(4);

    const message: ChatMessage = {
      id: 'm',
      session_id: 's',
      turn_index: 1,
      role: 'assistant',
      revision: 1,
      content: 'hi',
      status: 'complete',
      error_code: null,
      finish_reason: null,
      model_id: null,
      created_at: '2026-09-28T00:00:00.000Z',
    };
    expect(readPostprocessVersion(message.postprocess_version)).toBeNull();
    const start: ConversationStreamStartEvent = {
      type: 'start',
      turn_index: 1,
      user_message_id: 'u',
      assistant_message_id: 'a',
      revision: 1,
    };
    expect(readPostprocessVersion(start.postprocess_version)).toBeNull();
  });

  it('validates version batches and admin mutation DTOs', () => {
    expect(ReadTextPostprocessVersionsRequestSchema.safeParse({ versions: [2, 1] }).success).toBe(
      true
    );
    expect(ReadTextPostprocessVersionsRequestSchema.safeParse({ versions: [1, 1] }).success).toBe(
      false
    );
    expect(
      ReadTextPostprocessVersionsRequestSchema.safeParse({
        versions: Array.from({ length: 21 }, (_, index) => index + 1),
      }).success
    ).toBe(false);

    const snapshot = {
      version: 3,
      schema_version: 1,
      policy_version: 1,
      source: source([rule()]),
      published_at: '2026-09-28T00:00:00.000Z',
    };
    expect(TextPostprocessVersionSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      ReadTextPostprocessVersionsDataSchema.safeParse({
        found: [{ ...snapshot, schema_version: 2 }],
        unavailable_versions: [],
      }).success
    ).toBe(false);
    expect(
      ReadTextPostprocessVersionsDataSchema.safeParse({
        found: [
          {
            version: snapshot.version,
            artifact: compileTextPostprocessSource(snapshot.source).artifact,
            published_at: snapshot.published_at,
          },
        ],
        unavailable_versions: [9],
      }).success
    ).toBe(true);

    const compiled = compileTextPostprocessSource(snapshot.source);
    if (!compiled.ok) throw new Error('fixture failed');
    const mini = { version: 3, artifact: compiled.artifact, published_at: snapshot.published_at };
    expect(TextPostprocessArtifactSnapshotSchema.safeParse(mini).success).toBe(true);
    for (const invalid of [
      snapshot,
      { ...mini, source: snapshot.source },
      { ...mini, version: 0 },
      { ...mini, artifact: null },
      { ...mini, artifact: { ...compiled.artifact, policy_version: 2 } },
      { ...mini, artifact: snapshot.source },
    ]) {
      expect(TextPostprocessArtifactSnapshotSchema.safeParse(invalid).success).toBe(false);
    }

    const save = {
      request_id: REQUEST_ID,
      expected_runtime_version: null,
      expected_draft_updated_at: null,
      expected_draft_digest: null,
      source: source([rule({ flags: 'y' })]),
    };
    expect(SaveTextPostprocessDraftRequestSchema.safeParse(save).success).toBe(true);
    expect(SaveTextPostprocessDraftRequestSchema.safeParse({ ...save, extra: true }).success).toBe(
      false
    );
    expect(
      PublishTextPostprocessRequestSchema.safeParse({
        request_id: REQUEST_ID,
        expected_runtime_version: 1,
        expected_draft_updated_at: '2026-09-28T00:00:00.000Z',
        expected_draft_digest: DIGEST,
        draft_revision: 'draft-1',
      }).success
    ).toBe(true);
    expect(
      RollbackTextPostprocessRequestSchema.safeParse({
        request_id: REQUEST_ID,
        expected_runtime_version: 4,
        target_version: 2,
      }).success
    ).toBe(true);
    expect(
      DiscardTextPostprocessDraftRequestSchema.safeParse({
        request_id: REQUEST_ID,
        expected_draft_updated_at: '2026-09-28T00:00:00.000Z',
        expected_draft_digest: DIGEST,
      }).success
    ).toBe(true);
    expect(
      TextPostprocessMutationErrorSchema.safeParse({
        code: 'cas_conflict',
        message: 'Reload the draft.',
        diagnostics: [],
      }).success
    ).toBe(true);
    expect(assessRequestReplay({ existingDigest: DIGEST, nextDigest: DIGEST })).toBe('same');
    expect(assessRequestReplay({ existingDigest: DIGEST, nextDigest: 'b'.repeat(64) })).toBe(
      'conflict'
    );
    expect(canonicalTextPostprocessJson({ b: 1, a: 1 })).toBe(
      canonicalTextPostprocessJson({ a: 1, b: 1 })
    );
  });

  it('rejects underscore tokens and restores code or unsafe block slots', () => {
    const artifact = compileOk([
      rule({ id: 'inline', pattern: 'in', flags: '', replacement: '<span>$&</span>' }),
      rule({ id: 'block', pattern: 'block', flags: '', replacement: '<div>$&</div>' }),
    ]);
    const applied = applyTextPostprocess({ text: 'see in and block', artifact });
    expect(applied.status).toBe('applied');
    if (applied.status !== 'applied') return;
    const nonce = 'a'.repeat(32);
    expect(
      prepareSlotTransport({
        text: 'see in and block',
        segments: applied.segments,
        nonce: 'bad_token_with_underscore_xx',
      }).ok
    ).toBe(false);
    const transport = prepareSlotTransport({
      text: 'see in and block',
      segments: applied.segments,
      nonce,
    });
    expect(transport.ok).toBe(true);
    if (!transport.ok) return;
    expect(transport.markdown.includes('_')).toBe(false);
    const [inline, block] = transport.slots;
    if (!inline || !block) throw new Error('missing slots');
    const decisions = resolveTransportedTextNodes({
      nodes: [
        { text: inline.token, ancestors: ['p'], exclusiveBlock: null },
        { text: inline.token, ancestors: ['pre', 'code'], exclusiveBlock: null },
        { text: `kept ${block.token}`, ancestors: ['p'], exclusiveBlock: 'p' },
        { text: block.token, ancestors: ['li'], exclusiveBlock: 'li' },
      ],
      slots: transport.slots,
    });
    expect(decisions[0]?.[0]).toMatchObject({ type: 'mount', placement: 'inline' });
    expect(decisions[1]?.[0]).toMatchObject({ type: 'restore', text: 'in' });
    expect(decisions[2]?.some((decision) => decision.type === 'unsafe-block')).toBe(true);
    expect(decisions[3]?.[0]).toMatchObject({ type: 'mount', placement: 'block' });
  });
});

describe('parser boundary', () => {
  it('does not export the compiler from the runtime entry', () => {
    expect(Object.keys(textPostprocessRuntime)).not.toContain('compileTextPostprocessSource');
    expect(textPostprocessRuntime.validateCompiledArtifact).toEqual(expect.any(Function));
    expect(textPostprocessRuntime.applyTextPostprocess).toEqual(expect.any(Function));
  });

  it('compiles the same artifact twice', () => {
    const input = source([
      rule({ css: '.card { color: #abc; padding: 8px; }', replacement: '<p class="card">$&</p>' }),
    ]);
    expect(compileTextPostprocessSource(input)).toEqual(compileTextPostprocessSource(input));
  });
});
