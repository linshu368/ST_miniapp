const ST_HANDLE_PREFIX = 'tg-';

/**
 * 从 Telegram 数字 ID 确定性派生 ST 用户 handle。
 * 格式：tg-<tg_id>，如 tg-672913845
 *
 * 规则：
 * - tg_id 必须是非空的纯数字字符串
 * - 使用连字符（-）而非下划线（_），原因：ST 的 slugify 会把下划线转为连字符，
 *   预先使用连字符可确保 deriveStHandle() 的结果 === ST 内部 slugify 后的存储 key，
 *   避免创建账号和登录时 handle 不一致导致 403。
 * - 结果天然 filesystem-safe，无需额外 slugify
 * - 映射不可逆（单向），但可通过 parseTgIdFromHandle 提取原始 ID
 */
export function deriveStHandle(tgId: string): string {
  if (!tgId || typeof tgId !== 'string') {
    throw new Error('tg_id must be a non-empty string');
  }

  const trimmed = tgId.trim();

  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`tg_id must be a numeric string, got: "${trimmed}"`);
  }

  return `${ST_HANDLE_PREFIX}${trimmed}`;
}

/**
 * 从 ST handle 中提取原始 tg_id。
 * 如果 handle 不符合 tg_<digits> 格式，返回 null。
 */
export function parseTgIdFromHandle(handle: string): string | null {
  if (!handle || !handle.startsWith(ST_HANDLE_PREFIX)) {
    return null;
  }

  const tgId = handle.slice(ST_HANDLE_PREFIX.length);
  if (!/^\d+$/.test(tgId)) {
    return null;
  }

  return tgId;
}

/**
 * 判断一个 handle 是否为本系统派生的 ST handle。
 */
export function isStBridgeHandle(handle: string): boolean {
  return parseTgIdFromHandle(handle) !== null;
}
