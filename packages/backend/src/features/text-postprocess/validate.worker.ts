import { parentPort } from 'node:worker_threads';
import type { CompiledTextPostprocessArtifact, TextPostprocessDiagnostic } from '@miniapp/shared';

interface ValidateRequest {
  id: number;
  source: unknown;
}

interface CompileResult {
  ok: boolean;
  artifact?: CompiledTextPostprocessArtifact;
  diagnostics: TextPostprocessDiagnostic[];
}

if (!parentPort) {
  throw new Error('text postprocess validator must run as a worker');
}

const port = parentPort;

/**
 * 不从 Backend 的静态依赖图导入编译器，避免把 parse5/css-tree 拉进主线程类型和打包图。
 * 入口脚本先注册 tsx，这里再按文件 URL 加载。
 */
const compiler = import(
  new URL('../../../../shared/src/text-postprocess/compile.ts', import.meta.url).href
) as Promise<{ compileTextPostprocessSource: (input: unknown) => CompileResult }>;

port.on('message', (message: ValidateRequest) => {
  if (!message || typeof message.id !== 'number') return;
  void compile(message);
});

async function compile(message: ValidateRequest): Promise<void> {
  try {
    const { compileTextPostprocessSource } = await compiler;
    const result = compileTextPostprocessSource(message.source);
    port.postMessage({
      id: message.id,
      ok: result.ok,
      diagnostics: result.diagnostics,
      artifact: result.artifact,
    });
  } catch {
    port.postMessage({ id: message.id, ok: false, crashed: true });
  }
}
