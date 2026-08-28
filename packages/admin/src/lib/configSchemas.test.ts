import { describe, expect, it } from 'vitest';
import {
  configMetadata,
  configSchemas,
  LlmPricingConfigSchema,
  managedConfigKeys,
} from './configSchemas';

const validConfig = {
  fixedDeduction: {
    freeQuotaExhausted: 10,
    light: 15,
    standard: 30,
    premium: 50,
  },
};

describe('LlmPricingConfigSchema', () => {
  it('accepts fixed per-round deduction amounts', () => {
    expect(LlmPricingConfigSchema.parse(validConfig).fixedDeduction).toEqual({
      freeQuotaExhausted: 10,
      light: 15,
      standard: 30,
      premium: 50,
    });
  });

  it('rejects missing or negative fixed deductions', () => {
    expect(
      LlmPricingConfigSchema.safeParse({ ...validConfig, fixedDeduction: undefined }).success
    ).toBe(false);
    expect(
      LlmPricingConfigSchema.safeParse({
        ...validConfig,
        fixedDeduction: { ...validConfig.fixedDeduction, premium: -1 },
      }).success
    ).toBe(false);
    expect(
      LlmPricingConfigSchema.safeParse({
        ...validConfig,
        fixedDeduction: {
          freeQuotaExhausted: 10,
          standard: 30,
          premium: 50,
        },
      }).success
    ).toBe(false);
  });
});

describe('recharge page config registration', () => {
  it('exposes the recharge page in the managed config directory with a valid default', () => {
    const key = 'miniapp_recharge_page_config';

    expect(managedConfigKeys).toContain(key);
    expect(configMetadata[key].label).toBe('充值页面配置');
    expect(configSchemas[key].safeParse(configMetadata[key].defaultValue).success).toBe(true);
    expect(configMetadata[key].defaultValue).toMatchObject({
      pending_arrival_hint: '完成付款后积分将自动到账，通常不超过 3 分钟',
    });
  });
});

describe('payment prompt dialog config registration', () => {
  it('exposes the dialog in the managed config directory with a valid default', () => {
    const key = 'miniapp_payment_prompt_dialog_config';

    expect(managedConfigKeys).toContain(key);
    expect(configMetadata[key].label).toBe('支付提示弹窗');
    expect(configSchemas[key].safeParse(configMetadata[key].defaultValue).success).toBe(true);
  });
});
