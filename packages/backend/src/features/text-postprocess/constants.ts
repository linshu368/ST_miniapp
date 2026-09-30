export const TEXT_POSTPROCESS_CONFIG_KEY = 'miniapp_text_postprocess_config';

/** Admin 读取当前版本的上限。 */
export const TEXT_POSTPROCESS_CONFIG_TIMEOUT_MS = 1_000;

/** 发布校验在 worker 里的上限。到点 terminate，不回退到主线程执行正则。 */
export const TEXT_POSTPROCESS_VALIDATION_TIMEOUT_MS = 5_000;

export const TEXT_POSTPROCESS_VALIDATION_WORKERS = 2;
export const TEXT_POSTPROCESS_VALIDATION_QUEUE = 64;
