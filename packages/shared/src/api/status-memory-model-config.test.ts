import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STATUS_MEMORY_MODEL_CONFIG,
  StatusMemoryModelConfigSchema,
  statusMemoryFallbackProvider,
} from './status-bar';

describe('状态栏/记忆栏模型配置的兜底来源', () => {
  it('老配置（没有 fallback_provider）仍合法，按 OpenRouter', () => {
    const parsed = StatusMemoryModelConfigSchema.parse({
      primary_model: 'gemini-3-flash-preview',
      fallback_model: 'deepseek/deepseek-v4-flash',
    });
    expect(statusMemoryFallbackProvider(parsed)).toBe('openrouter');
  });

  it('可以选 Surplus；未知来源不合法', () => {
    const base = { primary_model: 'a', fallback_model: 'deepseek-v4.1-flash-1017' };
    const parsed = StatusMemoryModelConfigSchema.parse({ ...base, fallback_provider: 'surplus' });
    expect(statusMemoryFallbackProvider(parsed)).toBe('surplus');
    expect(() =>
      StatusMemoryModelConfigSchema.parse({ ...base, fallback_provider: 'packy' })
    ).toThrow();
  });

  it('默认值本身合法，兜底是 Surplus 的 deepseek-v4.1-flash-1017', () => {
    expect(
      StatusMemoryModelConfigSchema.safeParse(DEFAULT_STATUS_MEMORY_MODEL_CONFIG).success
    ).toBe(true);
    expect(DEFAULT_STATUS_MEMORY_MODEL_CONFIG).toMatchObject({
      fallback_provider: 'surplus',
      fallback_model: 'deepseek-v4.1-flash-1017',
    });
  });
});
