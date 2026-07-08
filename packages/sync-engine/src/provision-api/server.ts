/**
 * sync-engine / provision-api / server.ts
 *
 * 极简 HTTP 服务，专供 backend 调用。
 * 暴露端点：POST /provision/:userId（异步）、POST /provision/:userId/sync（同步）
 *
 * 设计原则：
 *   - 默认绑定 127.0.0.1，可通过 PROVISION_API_BIND_HOST 环境变量覆盖
 *     （容器化部署须设为 0.0.0.0，否则 backend 跨服务调不到）
 *   - 无鉴权（仅供内网调用：本地同机，或 Railway 内网 backend → st-bundle）
 *   - provision() 异步触发：立即返回 202，后台跑完整流程
 *   - 幂等：重复调用安全（provision 内部判断已初始化则增量补全）
 */

import { createServer, type Server } from 'node:http';
import { provision, ensureCharacterProvisioned } from '../provisioner/index.js';
import { loadConfig, config } from '../lib/config.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('provision-api');

const BIND_HOST = process.env.PROVISION_API_BIND_HOST ?? '127.0.0.1';

export interface ProvisionApiOptions {
  port: number;
}

export interface ProvisionApiHandle {
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
  // 支持 ?force=true：全量覆盖；?cards=none：不下发角色卡（懒下发，卡走 /character 端点）
  // 注意：正则用 [^/?]+ 只吃到 userId，query 单独解析；`/sync`、`/character` 等更深路径
  // 因含 `/` 不会误命中此处，仍落到下方对应 handler（顺序与匹配二者共同保证）。
  const provisionMatch = url.match(/^\/provision\/([^/?]+)(\?.*)?$/);
  if (method === 'POST' && provisionMatch) {
    const userId = provisionMatch[1] ?? '';
    if (!userId) {
      jsonResponse(res, 400, { error: 'missing_user_id' });
      return;
    }

    // 解析查询参数：force / cards（与 /sync 端点语义一致）
    const queryStr = provisionMatch[2] ?? '';
    const query = new URLSearchParams(queryStr.replace(/^\?/, ''));
    const force = query.get('force') === 'true';
    const characterScope = query.get('cards') === 'none' ? 'none' : 'all';

    // 立即返回 202，后台异步跑 provision
    jsonResponse(res, 202, { status: 'accepted', userId });

    // 异步触发，不 await
    provision(userId, {
      force,
      characterScope,
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

  // POST /provision/:userId/character/:characterId/sync — 只确保单张角色卡落盘（懒下发）
  // 供 Bridge 在用户进入 /tavern/<id> 时调用：关键路径只拉「当前打开的这张卡」。
  const provisionCharMatch = url.match(/^\/provision\/([^/]+)\/character\/([^/?]+)\/sync(\?.*)?$/);
  if (method === 'POST' && provisionCharMatch) {
    const userId = provisionCharMatch[1] ?? '';
    const characterId = provisionCharMatch[2] ?? '';
    if (!userId || !characterId) {
      jsonResponse(res, 400, { error: 'missing_param' });
      return;
    }

    try {
      const result = await ensureCharacterProvisioned(userId, characterId, {
        log: (msg) => logger.info({ userId, characterId }, msg),
      });
      logger.info({ userId, characterId, status: result.status }, 'ensure character 完成');
      jsonResponse(res, 200, {
        status: result.status,
        userId,
        characterId,
        stHandle: result.stHandle,
      });
    } catch (err) {
      logger.error({ userId, characterId, err: String(err) }, 'ensure character 失败');
      jsonResponse(res, 500, { error: 'ensure_character_failed', message: String(err) });
    }
    return;
  }

  // POST /provision/:userId/sync — 同步（等待 provision 完成后返回 200）
  // 供 Bridge 新用户首次登录时使用：确保 ST 用户账号创建完毕后再尝试 ST 登录
  // 支持 ?force=true：新用户流程第二阶段（ST 初始化后覆盖写平台文件）
  // 支持 ?cards=none：关键路径不下发角色卡（懒下发，卡走 /character 端点按需拉）
  const provisionSyncMatch = url.match(/^\/provision\/([^/]+)\/sync(\?.*)?$/);
  if (method === 'POST' && provisionSyncMatch) {
    const userId = provisionSyncMatch[1] ?? '';
    if (!userId) {
      jsonResponse(res, 400, { error: 'missing_user_id' });
      return;
    }

    // 解析查询参数：force / cards
    const queryStr = provisionSyncMatch[2] ?? '';
    const query = new URLSearchParams(queryStr.replace(/^\?/, ''));
    const force = query.get('force') === 'true';
    const characterScope = query.get('cards') === 'none' ? 'none' : 'all';

    try {
      const result = await provision(userId, {
        force,
        characterScope,
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

  // GET /health
  if (method === 'GET' && url === '/health') {
    jsonResponse(res, 200, { status: 'ok', service: 'provision-api' });
    return;
  }

  // 404
  jsonResponse(res, 404, { error: 'not_found' });
}

// ─── 启动函数 ─────────────────────────────────────────────────────────────────

export async function startProvisionApi(opts: ProvisionApiOptions): Promise<ProvisionApiHandle> {
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

  logger.info({ host: BIND_HOST, port: actualPort }, 'Provision API server 已启动');

  return {
    stop: () =>
      new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else {
            logger.info('Provision API server 已停止');
            resolve();
          }
        });
      }),
    port: actualPort,
  };
}
