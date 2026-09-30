export const TEXT_POSTPROCESS_CONFIG_KEY = 'miniapp_text_postprocess_config';

/** Admin 读取当前版本的上限。 */
export const TEXT_POSTPROCESS_CONFIG_TIMEOUT_MS = 1_000;

/** 服务开始接流量前预热当前版本；失败只影响富文本展示，不阻止进程启动。 */
export const TEXT_POSTPROCESS_CONFIG_WARMUP_TIMEOUT_MS = 3_000;

/** 多实例通过短周期刷新收敛；正常开轮只读内存，不等待数据库。 */
export const TEXT_POSTPROCESS_CONFIG_REFRESH_INTERVAL_MS = 5_000;

/** 发布校验在 worker 里的上限。到点 terminate，不回退到主线程执行正则。 */
export const TEXT_POSTPROCESS_VALIDATION_TIMEOUT_MS = 5_000;

export const TEXT_POSTPROCESS_VALIDATION_WORKERS = 2;
export const TEXT_POSTPROCESS_VALIDATION_QUEUE = 64;
