// @vitest-environment jsdom
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Worker as NodeWorker } from 'node:worker_threads';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ChatMessage, type CompiledTextPostprocessArtifact } from '@miniapp/shared';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
let ChatMessageBubble: typeof import('../../components/chat/chat-message-bubble').ChatMessageBubble;
import { assignVersionBatch } from './versions';
import { planMessageReply } from './reply-plan';
import {
  emptyChoiceLock,
  tryAdoptChoice,
  markChoiceAwaitingConfirmation,
  settleChoiceLock,
  type ChoiceLockState,
} from './choice-gate';

const ARTIFACT: CompiledTextPostprocessArtifact = {
  schema_version: 1,
  policy_version: 1,
  rules: [
    {
      id: 'choice',
      enabled: true,
      pattern: String.raw`\[choice\](.*?)\[/choice\]`,
      flags: 'g',
      groups: { count: 1, names: [], name_by_index: [null] },
      placement: 'block',
      css: [],
      tree: [
        {
          type: 'element',
          tag: 'button',
          attributes: [],
          action: { type: 'send-message' },
          children: [{ type: 'capture', ref: { kind: 'number', index: 1 } }],
        },
      ],
    },
  ],
};
const MESSAGE: ChatMessage = {
  id: 'a1',
  session_id: 's1',
  turn_index: 1,
  role: 'assistant',
  revision: 0,
  content: '[choice]Yes {{user}}[/choice]',
  status: 'complete',
  error_code: null,
  finish_reason: 'stop',
  model_id: null,
  created_at: '2026-09-28T00:00:00.000Z',
  postprocess_version: 4,
};
let root: Root | null = null;
let node: HTMLDivElement;
const directory = mkdtempSync(join(tmpdir(), 'artifact-miniapp-dom-'));
const workerBundlePath = join(directory, 'worker.mjs');
beforeAll(async () => {
  const outfile = join(directory, 'bubble.cjs');
  // Node 子进程打包，避免 jsdom 的 Uint8Array realm 与 esbuild 二进制通信冲突。
  execFileSync(
    process.execPath,
    [
      '-e',
      `
    const path=require('node:path');
    const esbuild=require(require.resolve('esbuild',{paths:[path.join(process.cwd(),'../reply-renderer')]}));
    const react=require.resolve('react'); const runtime=require.resolve('react/jsx-runtime');
    esbuild.buildSync({entryPoints:['src/components/chat/chat-message-bubble.tsx'],outfile:${JSON.stringify(outfile)},bundle:true,format:'cjs',platform:'browser',jsx:'automatic',define:{'import.meta.url':JSON.stringify('file:///local-artifact-bubble.mjs')},external:[react,runtime],alias:{react,'react/jsx-runtime':runtime},logLevel:'silent'});
    esbuild.buildSync({entryPoints:['../reply-renderer/src/postprocess.worker.ts'],outfile:${JSON.stringify(workerBundlePath)},bundle:true,format:'esm',platform:'browser',banner:{js:"import {parentPort} from 'node:worker_threads'; globalThis.self=globalThis; globalThis.postMessage=(data)=>parentPort.postMessage(data); parentPort.on('message',(data)=>globalThis.onmessage?.({data}));"},logLevel:'silent'});
  `,
    ],
    { cwd: process.cwd() }
  );
  const bundleModule = { exports: {} as { ChatMessageBubble: typeof ChatMessageBubble } };
  new Function('require', 'module', 'exports', readFileSync(outfile, 'utf8'))(
    createRequire(import.meta.url),
    bundleModule,
    bundleModule.exports
  );
  const loaded = bundleModule.exports;
  ChatMessageBubble = loaded.ChatMessageBubble;
});
afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  node?.remove();
  vi.unstubAllGlobals();
});

async function mount(streaming = false) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('Worker', function () {
    const worker = new NodeWorker(workerBundlePath);
    const adapter = {
      onmessage: null as ((event: MessageEvent) => void) | null,
      onerror: null as ((event: Event) => void) | null,
      postMessage(data: unknown) {
        worker.postMessage(data);
      },
      terminate() {
        void worker.terminate();
      },
    };
    worker.on('message', (data: unknown) => adapter.onmessage?.({ data } as MessageEvent));
    worker.on('error', () => adapter.onerror?.(new Event('error')));
    return adapter as unknown as Worker;
  });
  const states = Object.fromEntries(
    assignVersionBatch([4], {
      found: [{ version: 4, artifact: ARTIFACT, published_at: MESSAGE.created_at }],
      unavailable_versions: [],
    })
  );
  const plan = planMessageReply(MESSAGE, states);
  expect(plan.kind).toBe('renderer');
  let lock: ChoiceLockState = emptyChoiceLock();
  const sent: string[] = [];
  node = document.createElement('div');
  document.body.append(node);
  root = createRoot(node);
  await act(async () => {
    root?.render(
      React.createElement(ChatMessageBubble, {
        message: MESSAGE,
        characterName: 'Test',
        characterAvatarUrl: null,
        userAvatarUrl: null,
        replyPlan: plan,
        displayName: 'Alex {{user}}',
        choiceDisabled: false,
        streaming,
        onChoice: (choice) => {
          const adopted = tryAdoptChoice(lock, {
            message: MESSAGE,
            messages: [MESSAGE],
            text: choice.text,
            gates: { generating: false, serverBusy: false, sessionReady: true },
            baselineUpdatedAt: 10,
          });
          lock = adopted.state;
          if (adopted.text) sent.push(adopted.text);
        },
      })
    );
  });
  const deadline = Date.now() + 3000;
  while (!node.querySelector('button') && Date.now() < deadline)
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  expect(node.querySelector('button')).not.toBeNull();
  return { sent, getLock: () => lock };
}

describe('stored artifact -> MiniApp bubble -> actual ReplyRenderer', () => {
  it('renders a trusted choice from the response artifact and synchronously accepts one click', async () => {
    const view = await mount();
    const button = node.querySelector('button');
    expect(button).not.toBeNull();
    expect(node.querySelector('[data-reply-state="applied"]')).not.toBeNull();
    expect(button?.textContent).toBe('Yes Alex {{user}}');
    await act(async () => {
      button?.click();
      button?.click();
    });
    expect(view.sent).toEqual(['Yes {{user}}']);
    const settled = settleChoiceLock(markChoiceAwaitingConfirmation(view.getLock()), {
      messages: [MESSAGE, { ...MESSAGE, id: 'a2', turn_index: 2 }],
      refreshing: false,
      querySettled: true,
      dataUpdatedAt: 11,
    });
    expect(
      tryAdoptChoice(settled, {
        message: MESSAGE,
        messages: [MESSAGE],
        text: 'Yes',
        gates: { generating: false, serverBusy: false, sessionReady: true },
        baselineUpdatedAt: 11,
      }).text
    ).toBeNull();
  });
  it('keeps the same artifact while streaming and disables its actual button', async () => {
    const view = await mount(true);
    const button = node.querySelector('button') as HTMLButtonElement | null;
    expect(button?.disabled).toBe(true);
    button?.click();
    expect(view.sent).toEqual([]);
  });
});
