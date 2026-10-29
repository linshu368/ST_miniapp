import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Stable ports let MCP, manual preview and the saved tests share documented entry points.
const testMode = process.argv.includes('--test');
const appPort = testMode ? 3130 : 3120;
const apiPort = appPort + 1;
const root = fileURLToPath(new URL('../..', import.meta.url));
const children = [];
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (child.pid && child.exitCode === null) {
      try {
        if (process.platform === 'win32') {
          spawnSync('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
        } else {
          process.kill(-child.pid, 'SIGTERM');
        }
      } catch {
        child.kill('SIGTERM');
      }
    }
  }
  setTimeout(() => {
    for (const child of children) {
      if (child.pid && child.exitCode === null) {
        try {
          if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already stopped. */
        }
      }
    }
    process.exit(code);
  }, 1500).unref();
  process.exitCode = code;
}

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => stop());
process.on('uncaughtException', (error) => {
  console.error(error.message);
  stop(1);
});

async function requireFreePort(port) {
  const probe = createServer();
  await new Promise((accept, reject) => {
    probe.once('error', () =>
      reject(new Error(`端口 ${port} 已被占用。请先检查现有服务；本工具不会终止其他进程。`))
    );
    probe.listen(port, '127.0.0.1', accept);
  });
  await new Promise((accept, reject) => probe.close((error) => (error ? reject(error) : accept())));
}

try {
  await requireFreePort(appPort);
  await requireFreePort(apiPort);
  const env = {
    ...process.env,
    NODE_ENV: 'development',
    ST_UI_PREVIEW_MODE: testMode ? 'test' : 'preview',
    ST_UI_APP_PORT: String(appPort),
    ST_UI_API_PORT: String(apiPort),
    NEXT_PUBLIC_API_URL: `http://127.0.0.1:${apiPort}`,
    NEXT_PUBLIC_DEFAULT_USER_AVATAR_URL: `http://127.0.0.1:${apiPort}/assets/scene.svg`,
    NEXT_PUBLIC_SENTRY_DSN: '',
    NEXT_PUBLIC_POSTHOG_KEY: '',
    NEXT_PUBLIC_POSTHOG_HOST: '',
    SENTRY_AUTH_TOKEN: '',
    SENTRY_DSN: '',
    NEXT_TELEMETRY_DISABLED: '1',
    VERCEL_ENV: '',
    VERCEL_TARGET_ENV: '',
    VERCEL_GIT_COMMIT_REF: '',
    VERCEL_GIT_PULL_REQUEST_ID: '',
  };
  function start(args, cwd) {
    const child = spawn('pnpm', args, {
      cwd,
      env,
      stdio: 'inherit',
      detached: true,
      shell: process.platform === 'win32',
    });
    children.push(child);
    child.on('error', (error) => {
      console.error(error.message);
      stop(1);
    });
    child.on('exit', (code) => {
      if (!stopping) stop(code || 1);
    });
  }
  start(['exec', 'tsx', 'fixtures/server.ts'], resolve(root, 'packages/ui-tests'));
  start(
    ['exec', 'next', 'dev', '--port', String(appPort), '--hostname', '127.0.0.1'],
    resolve(root, 'packages/frontend')
  );
  console.log(
    `\n场景入口：http://127.0.0.1:${apiPort}\n实际页面：http://127.0.0.1:${appPort}\n模式：${testMode ? '自动验收' : '手动预览'}，全部使用本地虚构数据。Ctrl+C 停止。\n`
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : '预览启动失败');
  stop(1);
}
