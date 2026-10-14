import { describe, expect, it } from 'vitest';
import { InstructionSlotRulesSchema } from './instruction-slot-rules.js';

describe('InstructionSlotRulesSchema', () => {
  const rules = {
    on_first_two_turns: '完整规则',
    on_later_turns: '简洁规则',
    off: '关闭规则',
  };

  it('accepts and trims each required operator-managed rule', () => {
    expect(
      InstructionSlotRulesSchema.parse({
        on_first_two_turns: ' 完整规则 ',
        on_later_turns: ' 简洁规则 ',
        off: ' 关闭规则 ',
      })
    ).toEqual(rules);
  });

  it('rejects missing, empty, and unknown configuration fields', () => {
    expect(InstructionSlotRulesSchema.safeParse({ on_first_two_turns: '完整规则' }).success).toBe(
      false
    );
    expect(InstructionSlotRulesSchema.safeParse({ ...rules, off: '  ' }).success).toBe(false);
    expect(InstructionSlotRulesSchema.safeParse({ ...rules, extra: 'not allowed' }).success).toBe(
      false
    );
  });
});
