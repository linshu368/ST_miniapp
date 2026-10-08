import { describe, expect, it } from 'vitest';
import {
  TEXT_POSTPROCESS_POLICY_VERSION,
  TEXT_POSTPROCESS_SCHEMA_VERSION,
  validateCompiledArtifact,
  type ChatMessage,
  type CompiledTextPostprocessArtifact,
  type TextPostprocessArtifactSnapshot,
} from '@miniapp/shared';

import {
  planAssistantBody,
  planMessageReply,
  replySourceText,
  resolveReplyArtifact,
  usernameReplacementOwner,
} from './reply-plan';
import type { VersionStateMap } from './versions';

function message(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'a1',
    session_id: 's1',
    turn_index: 1,
    role: 'assistant',
    revision: 0,
    content: 'Hello {{user}}',
    status: 'complete',
    error_code: null,
    finish_reason: 'stop',
    model_id: null,
    created_at: '2026-09-28T00:00:00.000Z',
    ...overrides,
  };
}

function sourceSnapshot(version: number): TextPostprocessArtifactSnapshot {
  return { version, artifact: ARTIFACT, published_at: '2026-09-28T00:00:00.000Z' };
}

const ARTIFACT: CompiledTextPostprocessArtifact = {
  schema_version: 1,
  policy_version: 1,
  rules: [
    {
      id: 'choice',
      enabled: true,
      pattern: 'Yes',
      flags: '',
      groups: { count: 0, names: [], name_by_index: [] },
      placement: 'inline',
      tree: [
        {
          type: 'element',
          tag: 'button',
          attributes: [],
          action: { type: 'send-message' },
          children: [{ type: 'text', text: 'Yes' }],
        },
      ],
      css: [],
    },
  ],
};

describe('assistant reply plan', () => {
  it('does not compile a published source snapshot or replace a missing version', () => {
    expect(validateCompiledArtifact(ARTIFACT).ok).toBe(true);
    expect(
      resolveReplyArtifact({
        version: 4,
        source: {},
        published_at: '2026-09-28T00:00:00.000Z',
      } as unknown as TextPostprocessArtifactSnapshot)
    ).toBeNull();
    const states: VersionStateMap = {
      4: { status: 'ready', snapshot: sourceSnapshot(4) },
      9: { status: 'ready', snapshot: sourceSnapshot(9) },
    };
    const planned = planMessageReply(message({ postprocess_version: 4 }), states);
    expect(planned).toEqual({ kind: 'renderer', artifact: ARTIFACT });
    expect(planMessageReply(message({ postprocess_version: 3 }), states)).toEqual({
      kind: 'original',
    });
  });

  it('fails closed for invalid, missing, unsupported and mismatched artifact snapshots', () => {
    for (const snapshot of [
      { ...sourceSnapshot(4), artifact: null },
      { ...sourceSnapshot(4), artifact: { ...ARTIFACT, policy_version: 2 } },
      { ...sourceSnapshot(4), artifact: { ...ARTIFACT, rules: [{}] } },
      sourceSnapshot(9),
    ]) {
      expect(
        planMessageReply(message({ postprocess_version: 4 }), {
          4: { status: 'ready', snapshot },
        } as unknown as VersionStateMap)
      ).toEqual({ kind: 'original' });
    }
    expect(
      planMessageReply(message({ role: 'user', postprocess_version: 4 }), {
        4: { status: 'ready', snapshot: sourceSnapshot(4) },
      })
    ).toEqual({ kind: 'original' });
  });

  it('keeps null, loading, unavailable, and failed snapshots on the original text', () => {
    const content = message();
    expect(planMessageReply(content, {})).toEqual({ kind: 'original' });
    expect(replySourceText(content)).toBe('Hello {{user}}');
    const versioned = message({ postprocess_version: 4, content: 'full {{user}} reply' });
    for (const states of [
      { 4: { status: 'loading' } },
      { 4: { status: 'unavailable' } },
      { 4: { status: 'error' } },
    ] as VersionStateMap[]) {
      const plan = planMessageReply(versioned, states);
      expect(plan).toEqual({ kind: 'original' });
      expect(replySourceText(versioned)).toBe('full {{user}} reply');
      expect(usernameReplacementOwner(versioned, plan)).toBe('markdown');
    }
  });

  it('uses the renderer only for the validated artifact of that assistant version', () => {
    const validated = validateCompiledArtifact(ARTIFACT);
    if (!validated.ok) throw new Error('fixture artifact was rejected');
    const versioned = message({ postprocess_version: 4 });
    const states: VersionStateMap = {
      4: { status: 'ready', snapshot: sourceSnapshot(4) },
    };
    expect(
      planAssistantBody({
        message: versioned,
        states,
      })
    ).toEqual({ kind: 'renderer', artifact: validated.artifact });
    expect(
      planAssistantBody({
        message: versioned,
        states: { 4: { status: 'loading' } },
      }).kind
    ).toBe('original');
    expect(
      planAssistantBody({
        message: message({ role: 'user', postprocess_version: 4 }),
        states,
      })
    ).toEqual({ kind: 'original' });
  });

  it('never postprocesses the manually authored turn zero', () => {
    expect(
      planMessageReply(message({ turn_index: 0, postprocess_version: 4 }), {
        4: { status: 'ready', snapshot: sourceSnapshot(4) },
      })
    ).toEqual({ kind: 'original' });
  });

  it('does not pre-replace username before the single owner renders', () => {
    const user = message({ role: 'user', content: 'hi {{user}}' });
    const assistant = message({ content: 'hi {{user}}', postprocess_version: 4 });
    const original = planMessageReply(assistant, {
      4: { status: 'error' },
    });
    const rendered = planAssistantBody({
      message: assistant,
      states: { 4: { status: 'ready', snapshot: sourceSnapshot(4) } },
    });
    expect(usernameReplacementOwner(user, original)).toBe('none');
    expect(usernameReplacementOwner(assistant, original)).toBe('markdown');
    expect(usernameReplacementOwner(assistant, rendered)).toBe('renderer');
    expect(replySourceText(user)).toBe('hi {{user}}');
    expect(replySourceText(assistant)).toBe('hi {{user}}');
    expect(original).not.toHaveProperty('segments');
    expect(rendered.kind === 'renderer' ? rendered.artifact : null).not.toHaveProperty('segments');
  });
});
