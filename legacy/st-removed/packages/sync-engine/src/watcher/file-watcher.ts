/**
 * sync-engine / watcher / file-watcher.ts
 *
 * 底层文件监听 + 防抖。
 * 监听每个 handle 目录下的 settings.json，
 * 变更后经过防抖窗口合并高频写入，再发射回调。
 *
 * 防抖策略（决策 6）：
 *   每个 handle 维护独立的防抖定时器。
 *   文件变更 → 重置定时器 → 定时器到期后触发一次回调。
 *   防抖窗口内的多次保存只产生一次同步。
 */

import { watch, type FSWatcher } from 'chokidar';
import { settingsPath } from '../lib/st-fs.js';
import { createLogger } from '../lib/logger.js';

const logger = createLogger('file-watcher');

const DEFAULT_DEBOUNCE_MS = 3000;

export type FileChangeHandler = (handle: string, filePath: string) => Promise<void>;

export interface FileWatcherOptions {
  /** 防抖窗口（毫秒），默认 3000 */
  debounceMs?: number;
}

export interface FileWatcherHandle {
  /** 停止所有监听，返回 promise 等待 chokidar 关闭 */
  stop: () => Promise<void>;
}

/**
 * 启动文件监听。
 *
 * @param handles  - 需要监听的 ST handle 列表
 * @param onChange - 防抖后触发的回调（handle + 变更文件绝对路径）
 * @param options  - 配置项
 * @returns 控制句柄（stop 方法用于优雅退出）
 */
export function startWatching(
  handles: string[],
  onChange: FileChangeHandler,
  options: FileWatcherOptions = {}
): FileWatcherHandle {
  const { debounceMs = DEFAULT_DEBOUNCE_MS } = options;

  if (handles.length === 0) {
    logger.info('无 handle 需要监听，跳过');
    return { stop: async () => {} };
  }

  // 每个 handle 的 settings.json 绝对路径 → handle 的反查映射
  const pathToHandle = new Map<string, string>();
  const watchPaths: string[] = [];

  for (const handle of handles) {
    const sp = settingsPath(handle);
    pathToHandle.set(sp, handle);
    watchPaths.push(sp);
  }

  // 每个 handle 的独立防抖定时器
  const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const watcher: FSWatcher = watch(watchPaths, {
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 500,
      pollInterval: 100,
    },
  });

  watcher.on('change', (filePath: string) => {
    const handle = pathToHandle.get(filePath);
    if (!handle) return;

    // 重置该 handle 的防抖定时器
    const existing = debounceTimers.get(handle);
    if (existing) clearTimeout(existing);

    debounceTimers.set(
      handle,
      setTimeout(() => {
        debounceTimers.delete(handle);
        logger.info({ handle }, 'settings.json 变更（防抖后）');
        onChange(handle, filePath).catch((err) => {
          logger.sys.error(
            { event: 'file_watcher.onchange.failed', handle, err },
            'onChange 回调出错'
          );
        });
      }, debounceMs)
    );
  });

  watcher.on('error', (err) => {
    logger.sys.error({ event: 'file_watcher.error', err }, '监听错误');
  });

  logger.info({ count: handles.length, debounceMs }, '开始监听 settings.json');

  return {
    stop: async () => {
      // 清理所有防抖定时器
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
      await watcher.close();
      logger.info('已停止监听');
    },
  };
}
