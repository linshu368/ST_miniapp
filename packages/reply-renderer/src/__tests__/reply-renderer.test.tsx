import type { ReactElement } from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { Worker as NodeWorker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  validateCompiledArtifact,
  type CompiledTextPostprocessArtifact,
  type CompiledTextPostprocessRule,
} from '@miniapp/shared';

import { composeAppliedView } from '../compose';
import { createAlphanumericNonce } from '../nonce';
import { isSafeCss } from '../css-safety';
import { ReplyRenderer } from '../ReplyRenderer';
import { mainBundlePath, workerBundlePath } from '../test-bundle-paths';
import { TrustedTree } from '../trusted-tree';
import {
  POSTPROCESS_TIMEOUT_MS,
  resetReplyWorkerForTests,
  runReplyPostprocess,
  setWorkerFactoryForTests,
  WORKER_START_TIMEOUT_MS,
} from '../worker-scheduler';
import type { WorkerMessage, WorkerRequest } from '../worker-protocol';

const sourceRoot = path.join(process.cwd(), 'src');

const NO_GROUPS = { count: 0, names: [] as string[], name_by_index: [] as Array<string | null> };
const ONE_GROUP = { count: 1, names: [] as string[], name_by_index: [null] };

class BundleWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private node: NodeWorker;

  constructor() {
    this.node = new NodeWorker(workerBundlePath);
    this.node.on('message', (data: unknown) => {
      this.onmessage?.({ data } as MessageEvent);
    });
    this.node.on('error', () => {
      this.onerror?.(new Event('error'));
    });
  }

  postMessage(data: unknown): void {
    this.node.postMessage(data);
  }

  terminate(): void {
    void this.node.terminate();
  }
}

beforeEach(() => {
  setWorkerFactoryForTests(() => new BundleWorker() as unknown as Worker);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  resetReplyWorkerForTests();
  vi.unstubAllGlobals();
});

describe('reply renderer boundaries', () => {
  it('keeps the main bundle off the compiler and runs apply inside the worker bundle', () => {
    const workerSource = readFileSync(workerBundlePath, 'utf8');
    const mainSource = readFileSync(mainBundlePath, 'utf8');
    expect(workerSource).toContain('applyTextPostprocess');
    expect(workerSource).not.toContain('parseFragment');
    expect(workerSource).not.toContain('css-tree');
    expect(workerSource).not.toContain('compileTextPostprocessSource');
    expect(mainSource).not.toContain('applyTextPostprocess');
    expect(mainSource).not.toContain('parseFragment');
    expect(mainSource).not.toContain('css-tree');
    expect(mainSource).not.toContain('compileTextPostprocessSource');
    expect(POSTPROCESS_TIMEOUT_MS).toBe(1000);
    expect(WORKER_START_TIMEOUT_MS).toBe(5000);
  });

  it('does not import app packages, parsers, or dangerouslySetInnerHTML', () => {
    const files = sourceFiles(sourceRoot).filter(
      (file) => !file.includes(`${path.sep}__tests__${path.sep}`)
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      expect(source).not.toMatch(
        /from ['"](?:parse5|css-tree|@miniapp\/(?:frontend|admin|backend|cs-platform))/
      );
      expect(source).not.toMatch(/text-postprocess\/compile/);
      expect(source).not.toContain('dangerouslySetInnerHTML');
    }
    const job = readFileSync(path.join(sourceRoot, 'postprocess-job.ts'), 'utf8');
    expect(job).toContain('applyTextPostprocess');
    const others = files.filter((file) => !file.endsWith(`${path.sep}postprocess-job.ts`));
    for (const file of others) {
      expect(readFileSync(file, 'utf8')).not.toContain('applyTextPostprocess');
    }
  });

  it('creates a 128-bit alphanumeric nonce and rejects unsafe css text', () => {
    const nonce = createAlphanumericNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9]{22}$/);
    expect(nonce).not.toContain('_');
    expect(isSafeCss('.scope span { color: red; }')).toBe(true);
    for (const sample of [
      'div { background: url(http://evil.test/a.png); }',
      '@import "http://evil.test/a.css";',
      '@font-face { src: url(data:font/woff;base64,aa); }',
      'div { color: red }</style><script>',
    ]) {
      expect(isSafeCss(sample)).toBe(false);
    }
  });
});

describe('markdown and trusted slots', () => {
  it('renders emphasis, lists, paragraphs, inline code, and fenced code in one pass', async () => {
    const content = [
      'Hello **strong** and *quiet*.',
      '',
      '- alpha',
      '- beta',
      '',
      'Use `inline` code.',
      '',
      '```',
      'const value = 1;',
      '```',
      '',
      '### Heading',
    ].join('\n');
    const view = render(element(content));
    await waitForState(view.container, 'original');
    expect(view.container.querySelector('strong')?.textContent).toBe('strong');
    expect(view.container.querySelector('em')?.textContent).toBe('quiet');
    expect(view.container.querySelectorAll('li')).toHaveLength(2);
    expect(view.container.querySelector('p')).not.toBeNull();
    expect(view.container.querySelector('code')?.textContent).toContain('inline');
    expect(view.container.querySelector('pre code')?.textContent).toContain('const value = 1;');
    expect(view.container.querySelector('h3')?.textContent).toBe('Heading');
    expect(view.container.querySelector('script, img, iframe, link')).toBeNull();
  });

  it('mounts inline and block slots without splitting markdown or leaving tokens', async () => {
    const content =
      '**hello alphaInline world**\n\n- betaBlock\n- kept\n\n```\nalphaInline\n```\n\nsee alphaInline beside betaBlock tail';
    const artifact = mustValidate({
      schema_version: 1,
      policy_version: 1,
      rules: [inlineRule(), blockRule()],
    });
    const view = render(element(content, artifact));
    await waitForState(view.container, 'applied');
    const strong = view.container.querySelector('strong');
    expect(strong?.textContent).toContain('hello');
    expect(strong?.textContent).toContain('world');
    expect(strong?.querySelector('mark.card')?.textContent).toBe('alphaInline');
    expect(view.container.querySelector('pre')?.textContent).toContain('alphaInline');
    expect(view.container.querySelector('pre mark')).toBeNull();
    expect(view.container.querySelectorAll('li')).toHaveLength(2);
    expect(view.container.querySelector('li div')?.textContent).toContain('betaBlock');
    expect(view.container.textContent).toContain('beside betaBlock tail');
    expect(view.container.querySelector('[data-reply-state="applied"]')).not.toBeNull();
    expect(view.container.textContent ?? '').not.toMatch(/[A-Za-z0-9]{22,}/);
    const style = view.container.querySelector('style')?.textContent ?? '';
    expect(style).toContain('color: red');
    expect(style).not.toMatch(/url\s*\(|@import|http:|data:/i);
    const scope = view.container.querySelector('mark.card')?.parentElement?.className ?? '';
    expect(scope.length).toBeGreaterThan(1);
    expect(style).toContain(`.${scope}`);
  });

  it('retries a colliding nonce and drops the token', () => {
    const content = 'see alphaInline';
    const colliding = 'a'.repeat(22);
    const nonces = [`${colliding}`, 'bbbbbbbbbbbbbbbbbbbbbb'];
    const transportContent = `${colliding}s0 see alphaInline`;
    const view = composeAppliedView({
      content: transportContent,
      displayName: null,
      segments: appliedSegments(transportContent),
      css: '',
      messageKey: 'nonce',
      interactive: false,
      openStore: new Map(),
      createNonce: () => nonces.shift() ?? 'cccccccccccccccccccccc',
    });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    const { container } = render(<div>{view.body}</div>);
    expect(container.querySelector('mark')?.textContent).toBe('alphaInline');
    expect(container.textContent).not.toContain('bbbbbbbbbbbbbbbbbbbbbb');
  });

  it('falls back to the full original text when every nonce collides', () => {
    const content = `${'d'.repeat(22)}s0 see alphaInline`;
    const view = composeAppliedView({
      content,
      displayName: null,
      segments: appliedSegments(content),
      css: '',
      messageKey: 'nonce-fail',
      interactive: false,
      openStore: new Map(),
      createNonce: () => 'd'.repeat(22),
    });
    expect(view.ok).toBe(false);
  });
});

describe('trust boundaries', () => {
  it('strips malicious model html and does not request network resources', async () => {
    const requests: string[] = [];
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      requests.push(String(input));
      return Promise.reject(new Error('blocked'));
    });
    vi.stubGlobal(
      'XMLHttpRequest',
      class {
        open(_method: string, url: string): void {
          requests.push(url);
        }
        send(): void {}
      }
    );
    const content = [
      'before <script>alert(1)</script> after',
      '<button data-action="send-message">Pwn</button>',
      '<img src="http://evil.test/a.png" />',
      '[link](http://evil.test/page)',
      '![pic](http://evil.test/b.png)',
    ].join('\n');
    const view = render(element(content));
    await waitForState(view.container, 'original');
    expect(view.container.querySelector('script, img, iframe, link, button, a')).toBeNull();
    expect(view.container.textContent).toContain('before');
    expect(view.container.textContent).toContain('after');
    expect(view.container.textContent).toContain('Pwn');
    expect(requests).toEqual([]);
  });

  it('renders capture text without parsing it and ignores forged actions', async () => {
    const artifact = mustValidate({
      schema_version: 1,
      policy_version: 1,
      rules: [
        {
          id: 'capture',
          enabled: true,
          pattern: 'cap (\\S+)',
          flags: '',
          groups: ONE_GROUP,
          placement: 'inline',
          tree: [
            {
              type: 'element',
              tag: 'span',
              attributes: [],
              action: null,
              children: [{ type: 'capture', ref: { kind: 'number', index: 1 } }],
            },
          ],
          css: [],
        },
      ],
    });
    const content = 'Hello {{user}} cap <img src="http://evil.test/a.png" onerror="alert(1)">';
    const view = render(element(content, artifact, { displayName: '**Ada**' }));
    await waitForState(view.container, 'applied');
    expect(view.container.querySelector('img, script')).toBeNull();
    expect(view.container.querySelector('strong')?.textContent).toBe('Ada');
    expect(view.container.textContent).toContain('<img src="http://evil.test/a.png"');
    expect(view.container.textContent).not.toContain('**Ada**');
    const forged = render(
      <TrustedTree
        nodes={[
          {
            type: 'element',
            tag: 'div',
            attributes: [],
            action: { type: 'send-message' },
            children: [{ type: 'text', text: 'nope' }],
          },
        ]}
        messageKey="forged-message"
        ruleId="forged"
        start={0}
        end={4}
        choices={[{ text: 'nope', sendable: true }]}
        interactive
        onChoice={() => undefined}
        openStore={new Map()}
      />
    );
    expect(forged.container.querySelector('button')).toBeNull();
    expect(forged.container.textContent).toContain('nope');
  });

  it('shows the full original text for unknown schema, policy, and invalid artifacts', async () => {
    const content = 'SENTINEL keep the whole reply';
    for (const artifact of [
      { schema_version: 2, policy_version: 1, rules: [] },
      { schema_version: 1, policy_version: 9, rules: [] },
      {
        schema_version: 1,
        policy_version: 1,
        rules: [{ id: 'bad', tree: [{ type: 'element', tag: 'script' }] }],
      },
    ]) {
      const view = render(element(content, artifact));
      await waitForState(view.container, 'original');
      expect(view.container.textContent).toContain(content);
      expect(view.container.querySelector('script, button, mark')).toBeNull();
      expect(view.container.querySelector('[data-reply-state="applied"]')).toBeNull();
      cleanup();
    }
  });

  it('sends only the structured choice text from a real button', async () => {
    const user = userEvent.setup();
    const onChoice = vi.fn();
    const content = 'pick [Yes] please <button data-action="send-message">Pwn</button>';
    const view = render(element(content, choiceArtifact(), { onChoice }));
    await waitForState(view.container, 'applied');
    const buttons = view.container.querySelectorAll('button');
    expect(buttons).toHaveLength(1);
    const button = buttons[0];
    if (!button) throw new Error('missing choice');
    button.textContent = 'hacked';
    await user.click(button);
    expect(onChoice).toHaveBeenCalledTimes(1);
    expect(onChoice).toHaveBeenCalledWith({
      text: 'Yes',
      ruleId: 'choice',
      start: content.indexOf('[Yes]'),
      end: content.indexOf('[Yes]') + '[Yes]'.length,
    });
    expect(onChoice.mock.calls[0]?.[0]).not.toHaveProperty('target');
  });
});

describe('choice and details interaction', () => {
  it('activates a choice from the keyboard and disables it when requested', async () => {
    const user = userEvent.setup();
    const onChoice = vi.fn();
    const content = 'pick [Yes]';
    const view = render(element(content, choiceArtifact(), { onChoice, messageKey: 'choice' }));
    await waitForState(view.container, 'applied');
    const button = view.getByRole('button', { name: 'Yes' });
    expect(button.getAttribute('type')).toBe('button');
    expect((button as HTMLButtonElement).style.minHeight).toBe('44px');
    expect((button as HTMLButtonElement).style.minWidth).toBe('44px');
    button.focus();
    await user.keyboard('{Enter}');
    expect(onChoice).toHaveBeenCalledTimes(1);
    await user.keyboard(' ');
    expect(onChoice).toHaveBeenCalledTimes(2);

    cleanup();
    onChoice.mockClear();
    const disabled = render(
      element(content, choiceArtifact(), {
        onChoice,
        choiceDisabled: true,
        messageKey: 'choice-off',
      })
    );
    await waitForState(disabled.container, 'applied');
    const off = disabled.getByRole('button', { name: 'Yes' });
    expect((off as HTMLButtonElement).disabled).toBe(true);
    await user.click(off);
    off.focus();
    await user.keyboard('{Enter}');
    expect(onChoice).not.toHaveBeenCalled();

    cleanup();
    const streaming = render(
      element(content, choiceArtifact(), { onChoice, streaming: true, messageKey: 'choice-stream' })
    );
    await waitForState(streaming.container, 'applied');
    expect((streaming.getByRole('button', { name: 'Yes' }) as HTMLButtonElement).disabled).toBe(
      true
    );
  });

  it('toggles details from pointer and keyboard without resetting on content updates', async () => {
    const user = userEvent.setup();
    const artifact = mustValidate({
      schema_version: 1,
      policy_version: 1,
      rules: [detailsRule()],
    });
    const view = render(element('StatusCard', artifact, { messageKey: 'status' }));
    await waitForState(view.container, 'applied');
    const summary = view.getByText('Status');
    expect(summary.closest('details')?.hasAttribute('open')).toBe(false);
    expect((summary as HTMLElement).style.minHeight).toBe('44px');
    await user.click(summary);
    expect(summary.closest('details')?.hasAttribute('open')).toBe(true);
    summary.focus();
    await user.keyboard(' ');
    expect(summary.closest('details')?.hasAttribute('open')).toBe(false);
    await user.keyboard('{Enter}');
    expect(summary.closest('details')?.hasAttribute('open')).toBe(true);

    view.rerender(element('StatusCard\n\nstill here', artifact, { messageKey: 'status' }));
    await waitFor(() => {
      expect(view.container.textContent).toContain('still here');
      expect(view.container.querySelector('details')?.hasAttribute('open')).toBe(true);
    });

    view.rerender(element('StatusCard', artifact, { messageKey: 'another-message' }));
    await waitFor(() => {
      expect(view.container.querySelector('details')?.hasAttribute('open')).toBe(false);
    });
  });
});

describe('worker lifecycle', () => {
  it('starts the message budget only after a slow worker becomes ready', async () => {
    setWorkerFactoryForTests(
      () => new SlowStartingWorker(80, 'see alphaInline') as unknown as Worker
    );
    const started = Date.now();
    const result = await runReplyPostprocess({
      content: 'see alphaInline',
      artifact: mustValidate({ schema_version: 1, policy_version: 1, rules: [inlineRule()] }),
      messageKey: 'cold-start',
      timeoutMs: 40,
    }).promise;
    expect(result.result.status).toBe('applied');
    expect(Date.now() - started).toBeGreaterThanOrEqual(70);
  });

  it('fails open when a worker never becomes ready', async () => {
    vi.useFakeTimers();
    setWorkerFactoryForTests(() => new NeverReadyWorker() as unknown as Worker);
    const pending = runReplyPostprocess({
      content: 'see alphaInline',
      artifact: mustValidate({ schema_version: 1, policy_version: 1, rules: [inlineRule()] }),
      messageKey: 'startup-timeout',
    }).promise;
    await vi.advanceTimersByTimeAsync(WORKER_START_TIMEOUT_MS);
    await expect(pending).resolves.toMatchObject({
      result: { status: 'original', reason: 'WORKER_START_TIMEOUT' },
    });
    vi.useRealTimers();
  });

  it('terminates a slow task, ignores its late result, and runs the next task on a new worker', async () => {
    const events: string[] = [];
    let created = 0;
    setWorkerFactoryForTests(() => {
      created += 1;
      if (created === 1) return new LateWorker(events) as unknown as Worker;
      return new BundleWorker() as unknown as Worker;
    });
    const slowText = `${'a'.repeat(28)}!`;
    const slow = runReplyPostprocess({
      content: slowText,
      artifact: catastrophicArtifact(),
      messageKey: 'slow',
      timeoutMs: 40,
    });
    await expect(slow.promise).resolves.toMatchObject({
      result: { status: 'original', reason: 'TIMEOUT' },
    });
    const fast = runReplyPostprocess({
      content: 'see alphaInline',
      artifact: mustValidate({ schema_version: 1, policy_version: 1, rules: [inlineRule()] }),
      messageKey: 'fast',
    });
    await expect(fast.promise).resolves.toMatchObject({ result: { status: 'applied' } });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const fastResult = await fast.promise;
    expect(fastResult.result.status).toBe('applied');
    if (fastResult.result.status === 'applied') {
      expect(fastResult.result.segments.some((segment) => segment.type === 'slot')).toBe(true);
      expect(JSON.stringify(fastResult.result)).not.toContain('LATE');
    }
    expect(created).toBe(2);
    expect(events).toContain('terminated');
  });

  it('uses the real message budget, then shows the complete original text', async () => {
    const content = `SENTINEL ${'a'.repeat(28)}!`;
    const started = Date.now();
    const view = render(element(content, multiSlowArtifact()));
    await waitForState(view.container, 'original', 4_000);
    expect(
      view.container
        .querySelector('[data-reply-state="original"]')
        ?.getAttribute('data-fallback-reason')
    ).toBe('TIMEOUT');
    expect(view.container.textContent).toContain(content);
    expect(view.container.querySelector('mark')).toBeNull();
    expect(Date.now() - started).toBeGreaterThan(900);
    expect(Date.now() - started).toBeLessThan(4_000);
  });

  it('drops a superseded request and releases the worker on unmount', async () => {
    const artifact = mustValidate({
      schema_version: 1,
      policy_version: 1,
      rules: [inlineRule()],
    });
    const first = render(element('former alphaInline', artifact, { messageKey: 'stream' }));
    first.rerender(element('latter alphaInline', artifact, { messageKey: 'stream' }));
    await waitForState(first.container, 'applied');
    expect(first.container.textContent).toContain('latter');
    expect(visibleText(first.container)).not.toContain('former');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(visibleText(first.container)).not.toContain('former');

    const slow = render(
      element(`${'a'.repeat(28)}!`, catastrophicArtifact(), { messageKey: 'gone' })
    );
    const started = Date.now();
    slow.unmount();
    const next = render(element('see alphaInline', artifact, { messageKey: 'next' }));
    await waitForState(next.container, 'applied');
    expect(next.container.querySelector('mark')?.textContent).toBe('alphaInline');
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('falls back to the original text when no worker can start', async () => {
    setWorkerFactoryForTests(() => {
      throw new Error('worker unavailable');
    });
    const content = 'see alphaInline intact';
    const view = render(
      element(
        content,
        mustValidate({ schema_version: 1, policy_version: 1, rules: [inlineRule()] })
      )
    );
    await waitForState(view.container, 'original');
    expect(
      view.container
        .querySelector('[data-reply-state="original"]')
        ?.getAttribute('data-fallback-reason')
    ).toBe('WORKER_UNAVAILABLE');
    expect(view.container.textContent).toContain(content);
    expect(view.container.querySelector('mark')).toBeNull();
  });
});

function element(
  content: string,
  artifact?: unknown,
  extra: {
    displayName?: string;
    onChoice?: (choice: { text: string; ruleId: string; start: number; end: number }) => void;
    choiceDisabled?: boolean;
    streaming?: boolean;
    messageKey?: string;
  } = {}
): ReactElement {
  return (
    <ReplyRenderer
      content={content}
      artifact={artifact}
      displayName={extra.displayName}
      onChoice={extra.onChoice}
      choiceDisabled={extra.choiceDisabled}
      streaming={extra.streaming}
      messageKey={extra.messageKey ?? 'message'}
    />
  );
}

async function waitForState(
  container: HTMLElement,
  state: string,
  timeout?: number
): Promise<void> {
  await waitFor(
    () => {
      expect(container.querySelector(`[data-reply-state="${state}"]`)).not.toBeNull();
    },
    { timeout }
  );
}

function inlineRule(): CompiledTextPostprocessRule {
  return {
    id: 'highlight',
    enabled: true,
    pattern: 'alphaInline',
    flags: 'g',
    groups: NO_GROUPS,
    placement: 'inline',
    tree: [
      {
        type: 'element',
        tag: 'mark',
        attributes: [{ name: 'class', tokens: ['card'] }],
        action: null,
        children: [{ type: 'capture', ref: { kind: 'match' } }],
      },
    ],
    css: [
      {
        type: 'style',
        selectors: [
          {
            compounds: [{ combinator: null, tag: 'mark', classes: ['card'], pseudos: [] }],
          },
        ],
        declarations: [{ property: 'color', tokens: [{ t: 'ident', v: 'red' }] }],
      },
    ],
  };
}

function blockRule(): CompiledTextPostprocessRule {
  return {
    id: 'block',
    enabled: true,
    pattern: 'betaBlock',
    flags: 'g',
    groups: NO_GROUPS,
    placement: 'block',
    tree: [
      {
        type: 'element',
        tag: 'div',
        attributes: [],
        action: null,
        children: [{ type: 'text', text: 'betaBlock' }],
      },
    ],
    css: [],
  };
}

function detailsRule(): CompiledTextPostprocessRule {
  return {
    id: 'status',
    enabled: true,
    pattern: 'StatusCard',
    flags: '',
    groups: NO_GROUPS,
    placement: 'block',
    tree: [
      {
        type: 'element',
        tag: 'details',
        attributes: [],
        action: null,
        children: [
          {
            type: 'element',
            tag: 'summary',
            attributes: [],
            action: null,
            children: [{ type: 'text', text: 'Status' }],
          },
          {
            type: 'element',
            tag: 'p',
            attributes: [],
            action: null,
            children: [{ type: 'text', text: 'Hidden body' }],
          },
        ],
      },
    ],
    css: [],
  };
}

function choiceArtifact(): CompiledTextPostprocessArtifact {
  return mustValidate({
    schema_version: 1,
    policy_version: 1,
    rules: [
      {
        id: 'choice',
        enabled: true,
        pattern: '\\[([A-Za-z]+)\\]',
        flags: '',
        groups: ONE_GROUP,
        placement: 'inline',
        tree: [
          {
            type: 'element',
            tag: 'button',
            attributes: [],
            action: { type: 'send-message' },
            children: [{ type: 'capture', ref: { kind: 'number', index: 1 } }],
          },
        ],
        css: [],
      },
    ],
  });
}

function catastrophicArtifact(): CompiledTextPostprocessArtifact {
  return mustValidate({
    schema_version: 1,
    policy_version: 1,
    rules: [
      {
        id: 'slow',
        enabled: true,
        pattern: '(a+)+$',
        flags: '',
        groups: ONE_GROUP,
        placement: 'inline',
        tree: [
          {
            type: 'element',
            tag: 'mark',
            attributes: [],
            action: null,
            children: [{ type: 'capture', ref: { kind: 'match' } }],
          },
        ],
        css: [],
      },
    ],
  });
}

function multiSlowArtifact(): CompiledTextPostprocessArtifact {
  return mustValidate({
    schema_version: 1,
    policy_version: 1,
    rules: [
      {
        id: 'keep',
        enabled: true,
        pattern: 'SENTINEL',
        flags: '',
        groups: NO_GROUPS,
        placement: 'inline',
        tree: [
          {
            type: 'element',
            tag: 'mark',
            attributes: [],
            action: null,
            children: [{ type: 'text', text: 'partial' }],
          },
        ],
        css: [],
      },
      catastrophicArtifact().rules[0] as CompiledTextPostprocessRule,
    ],
  });
}

function mustValidate(artifact: CompiledTextPostprocessArtifact): CompiledTextPostprocessArtifact {
  const result = validateCompiledArtifact(artifact);
  if (!result.ok) throw new Error(result.reason);
  return artifact;
}

function appliedSegments(content: string): ReturnType<typeof importSegments> {
  return importSegments(content);
}

function importSegments(content: string) {
  const start = content.indexOf('alphaInline');
  return [
    {
      type: 'slot' as const,
      rule_id: 'highlight',
      start,
      end: start + 'alphaInline'.length,
      placement: 'inline' as const,
      match_text: 'alphaInline',
      captures: [],
      tree: inlineRule().tree,
      choices: [],
    },
  ];
}

class LateWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(private events: string[]) {
    queueMicrotask(() => {
      this.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
    });
  }

  postMessage(data: WorkerRequest): void {
    setTimeout(() => {
      this.onmessage?.({
        data: {
          type: 'result',
          jobId: data.jobId,
          generation: data.generation,
          css: '',
          result: {
            status: 'applied',
            segments: [{ type: 'text', text: 'LATE', start: 0, end: 4 }],
            skipped_rules: [],
            stats: { matches: 0, slots: 0, nodes: 0, text_units: 4 },
          },
        },
      } as MessageEvent);
    }, 80);
  }

  terminate(): void {
    this.events.push('terminated');
  }
}

class SlowStartingWorker {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private terminated = false;

  constructor(
    delayMs: number,
    private readonly content: string
  ) {
    setTimeout(() => {
      if (!this.terminated) this.onmessage?.({ data: { type: 'ready' } } as MessageEvent);
    }, delayMs);
  }

  postMessage(data: WorkerRequest): void {
    queueMicrotask(() => {
      if (this.terminated) return;
      this.onmessage?.({
        data: {
          type: 'result',
          jobId: data.jobId,
          generation: data.generation,
          css: '',
          result: {
            status: 'applied',
            segments: [{ type: 'text', text: this.content, start: 0, end: this.content.length }],
            skipped_rules: [],
            stats: { matches: 0, slots: 0, nodes: 0, text_units: this.content.length },
          },
        },
      } as unknown as MessageEvent<WorkerMessage>);
    });
  }

  terminate(): void {
    this.terminated = true;
  }
}

class NeverReadyWorker {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  postMessage(): void {}
  terminate(): void {}
}

function visibleText(container: HTMLElement): string {
  const clone = container.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('style').forEach((style) => style.remove());
  return clone.textContent ?? '';
}

function sourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory)) {
    const full = path.join(directory, entry);
    if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
    else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
  }
  return files;
}
