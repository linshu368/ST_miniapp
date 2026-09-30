const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const NONCE_LENGTH = 22;
// 62 * 4 = 248。拒绝更高的字节，避免取模把分布压扁。
const REJECTION_LIMIT = 248;

/**
 * 128-bit 以上的纯字母数字 nonce。下划线会被 Showdown 当成强调，所以不能用 base64。
 * 22 个 62 进制字符约 131 bit。调用方负责碰撞检查；这里不读正文。
 */
export function createAlphanumericNonce(): string {
  let out = '';
  const buffer = new Uint8Array(64);
  let offset = buffer.length;
  while (out.length < NONCE_LENGTH) {
    if (offset >= buffer.length) {
      crypto.getRandomValues(buffer);
      offset = 0;
    }
    const value = buffer[offset];
    offset += 1;
    if (value === undefined || value >= REJECTION_LIMIT) continue;
    const char = ALPHABET[value % ALPHABET.length];
    if (char) out += char;
  }
  return out;
}
