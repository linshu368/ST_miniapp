/**
 * sync-engine / bridge-api / server.ts
 *
 * 极简 HTTP 服务，专供 Bridge（backend）调用。
 * 只暴露一个端点：POST /provision/:userId
 *
 * 设计原则：
 *   - 仅绑定 127.0.0.1，外部不可直连
 *   - 无鉴权（同机内网调用，Bridge 与 sync-engine 同机部署）
 *   - provision() 异步触发：立即返回 202，后台跑完整流程
 *   - 幂等：重复调用安全（provision 内部判断已初始化则增量补全）
 */

import { createServer, type Server } from 'node:http';
import { provision } from '../provisioner/index.js';
import { loadConfig, config } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('bridge-api');

const BIND_HOST = '127.0.0.1';

export interface BridgeApiOptions {
  port: number;
}

export interface BridgeApiHandle {
  stop: () => Promise<void>;
  port: number;
}

// ─── 请求解析工具 ─────────────────────────────────────────────────────────────

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function jsonResponse(
  res: import('node:http').ServerResponse,
  status: number,
  body: unknown
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// ─── 路由处理 ─────────────────────────────────────────────────────────────────

async function handleRequest(
  req: import('node:http').IncomingMessage,
  res: import('node:http').ServerResponse
): Promise<void> {
  const url = req.url ?? '';
  const method = req.method ?? '';

  // POST /provision/:userId — 异步（立即返回 202，后台跑）
  const provisionMatch = url.match(/^\/provision\/([^/]+)$/);
  if (method === 'POST' && provisionMatch) {
    const userId = provisionMatch[1] ?? '';
    if (!userId) {
      jsonResponse(res, 400, { error: 'missing_user_id' });
      return;
    }

    // 立即返回 202，后台异步跑 provision
    jsonResponse(res, 202, { status: 'accepted', userId });

    // 异步触发，不 await
    provision(userId, {
      force: false,
      log: (msg) => logger.info({ userId }, msg),
    })
      .then((result) => {
        logger.info(
          {
            userId,
            stHandle: result.stHandle,
            charactersWritten: result.charactersWritten,
            presetsWritten: result.presetsWritten,
            hadInvalidRef: result.hadInvalidRef,
          },
          'Provision 完成'
        );
      })
      .catch((err) => {
        logger.error({ userId, err: String(err) }, 'Provision 失败');
      });

    return;
  }

  // POST /provision/:userId/sync — 同步（等待 provision 完成后返回 200）
  // 供 Bridge 新用户首次登录时使用：确保 ST 用户账号创建完毕后再尝试 ST 登录
  // 支持 ?force=true 查询参数：新用户流程第二阶段（ST 初始化后覆盖写平台文件）
  const provisionSyncMatch = url.match(/^\/provision\/([^/]+)\/sync(\?.*)?$/);
  if (method === 'POST' && provisionSyncMatch) {
    const userId = provisionSyncMatch[1] ?? '';
    if (!userId) {
      jsonResponse(res, 400, { error: 'missing_user_id' });
      return;
    }

    // 解析 ?force=true 参数
    const queryStr = provisionSyncMatch[2] ?? '';
    const forceParam = new URLSearchParams(queryStr.replace(/^\?/, '')).get('force');
    const force = forceParam === 'true';

    try {
      const result = await provision(userId, {
        force,
        log: (msg) => logger.info({ userId }, msg),
      });
      logger.info(
        {
          userId,
          stHandle: result.stHandle,
          charactersWritten: result.charactersWritten,
          presetsWritten: result.presetsWritten,
        },
        'Provision (sync) 完成'
      );
      jsonResponse(res, 200, { status: 'ok', userId, stHandle: result.stHandle });
    } catch (err) {
      logger.error({ userId, err: String(err) }, 'Provision (sync) 失败');
      jsonResponse(res, 500, { error: 'provision_failed', message: String(err) });
    }
    return;
  }

  // GET /health（供 Bridge 探活）
  if (method === 'GET' && url === '/health') {
    jsonResponse(res, 200, { status: 'ok', service: 'bridge-api' });
    return;
  }

  // 404
  jsonResponse(res, 404, { error: 'not_found' });
}

// ─── 启动函数 ─────────────────────────────────────────────────────────────────

export async function startBridgeApi(opts: BridgeApiOptions): Promise<BridgeApiHandle> {
  const { port } = opts;

  const server: Server = createServer(async (req, res) => {
    try {
      await handleRequest(req, res);
    } catch (err) {
      logger.error({ err: String(err) }, '未捕获的请求处理错误');
      if (!res.headersSent) {
        jsonResponse(res, 500, { error: 'internal_error' });
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, BIND_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });

  const addr = server.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  logger.info({ host: BIND_HOST, port: actualPort }, 'Bridge API server 已启动');

  return {
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else {
            logger.info('Bridge API server 已停止');
            resolve();
          }
        });
      }),
    port: actualPort,
  };
}
