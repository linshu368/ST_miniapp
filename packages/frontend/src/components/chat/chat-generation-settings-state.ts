/**
 * T3/T4 已在服务端把缺失的新增偏好回读为 true；这里仍保留同一默认语义，
 * 以便过渡期间的旧缓存不会把新槽位误显示为关闭。
 */
export function isInstructionSlotEnabled(value: boolean | undefined): boolean {
  return value ?? true;
}
