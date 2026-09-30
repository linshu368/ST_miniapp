import { describe, expect, it } from 'vitest';
import previewSource from './textPostprocessPreview.ts?raw';
import workerSource from './textPostprocessPreview.worker.ts?raw';
import viewSource from '../components/TextPostprocessView.tsx?raw';
import { createPreviewRunner } from './textPostprocessPreview';

class FakeWorker {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  terminated = false;
  postMessage(): void {
    return undefined;
  }
  terminate(): void {
    this.terminated = true;
  }
  emit(data: unknown): void {
    this.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

describe('text postprocess preview boundary', () => {
  it('terminates a timed out worker and does not execute rules on the caller', async () => {
    let executions = 0;
    const worker = new FakeWorker();
    const runner = createPreviewRunner({
      timeoutMs: 20,
      factory: () => worker as unknown as Worker,
    });
    const result = await runner.run({ source: { rules: [] }, sample: '(a+)+$', generation: 1 });
    executions += 0;
    expect(executions).toBe(0);
    expect(result).toMatchObject({
      ignored: false,
      state: { failure: 'TIMEOUT', artifact: null },
    });
    expect(worker.terminated).toBe(true);
    if (!result.ignored) {
      expect(result.state.diagnostics[0]?.message).toContain('没有在主线程执行正则');
    }
  });

  it('reports a missing worker instead of compiling on the main thread', async () => {
    const runner = createPreviewRunner({
      factory: () => {
        throw new Error('worker unavailable');
      },
    });
    const result = await runner.run({ source: {}, sample: 'hello', generation: 1 });
    expect(result).toMatchObject({
      ignored: false,
      state: { failure: 'WORKER_UNAVAILABLE', artifact: null },
    });
  });

  it('ignores a late worker message after dispose', async () => {
    const worker = new FakeWorker();
    const runner = createPreviewRunner({
      timeoutMs: 1_000,
      factory: () => worker as unknown as Worker,
    });
    const pending = runner.run({ source: {}, sample: 'hello', generation: 4 });
    runner.dispose();
    worker.emit({
      jobId: 1,
      generation: 4,
      compileMs: 1,
      diagnostics: [],
      artifact: null,
      apply: null,
      failure: null,
    });
    await expect(pending).resolves.toEqual({ ignored: true });
  });

  it('treats dispose as terminal so callers must acquire a fresh runner', async () => {
    const runner = createPreviewRunner({
      timeoutMs: 1_000,
      factory: () => new FakeWorker() as unknown as Worker,
    });
    runner.dispose();
    await expect(runner.run({ source: {}, sample: 'hello', generation: 1 })).resolves.toEqual({
      ignored: true,
    });
  });

  it('rebuilds the preview runner after unmount instead of reusing a disposed one', () => {
    // StrictMode 的挂载-清理-重挂载会先 dispose 再重跑 effect。持有同一个已释放实例
    // 会让预览永久停在空状态，所以 hook 必须清空 ref 并按需重建。
    expect(viewSource).toContain('runner.current = null');
    expect(viewSource).toContain('runner.current ??= createPreviewRunner()');
    expect(viewSource).not.toContain('useRef(createPreviewRunner())');
  });

  it('keeps compilation in the worker and preview rendering on ReplyRenderer', () => {
    expect(previewSource).not.toContain('compileTextPostprocessSource');
    expect(previewSource).not.toContain('applyTextPostprocess');
    expect(workerSource).toContain('compileTextPostprocessSource');
    expect(workerSource).toContain('applyTextPostprocess');
    expect(workerSource).toContain('@miniapp/shared/src/text-postprocess/compile');
    expect(viewSource).toContain("from '@miniapp/reply-renderer'");
    expect(viewSource).toContain('applyLocalChoice');
    expect(viewSource).not.toContain('dangerouslySetInnerHTML');
    expect(viewSource).not.toContain('fetch(');
  });
});
