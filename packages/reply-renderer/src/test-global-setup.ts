import * as esbuild from 'esbuild';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { mainBundlePath, workerBundlePath, bundleDirectory } from './test-bundle-paths';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));

export async function setup(): Promise<void> {
  mkdirSync(bundleDirectory, { recursive: true });
  const banner = [
    "import { parentPort } from 'node:worker_threads';",
    'const __replyScope = globalThis;',
    '__replyScope.self = __replyScope;',
    '__replyScope.postMessage = (data) => parentPort.postMessage(data);',
    "parentPort.on('message', (data) => {",
    "  if (typeof __replyScope.onmessage === 'function') __replyScope.onmessage({ data });",
    '});',
  ].join('\n');
  await esbuild.build({
    absWorkingDir: packageRoot,
    entryPoints: ['src/postprocess.worker.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: workerBundlePath,
    banner: { js: banner },
    logLevel: 'silent',
  });
  await esbuild.build({
    absWorkingDir: packageRoot,
    entryPoints: ['src/index.ts'],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    outfile: mainBundlePath,
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
}
