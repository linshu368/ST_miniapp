import { describe, expect, it } from 'vitest';
import { SimulationChatRequestSchema } from '../api/simulation';

const base = {
  user_message: 'hello',
  metadata: { batch_id: 'batch-1' },
};

describe('SimulationChatRequestSchema', () => {
  it('accepts exactly one character identifier', () => {
    expect(
      SimulationChatRequestSchema.safeParse({
        ...base,
        card_hash: 'a'.repeat(64),
      }).success
    ).toBe(true);
    expect(
      SimulationChatRequestSchema.safeParse({
        ...base,
        name: 'Test Character',
      }).success
    ).toBe(true);
  });

  it('rejects missing or conflicting character identifiers', () => {
    expect(SimulationChatRequestSchema.safeParse(base).success).toBe(false);
    expect(
      SimulationChatRequestSchema.safeParse({
        ...base,
        card_hash: 'a'.repeat(64),
        name: 'Test Character',
      }).success
    ).toBe(false);
  });

  it('preserves opaque metadata', () => {
    const result = SimulationChatRequestSchema.parse({
      ...base,
      card_hash: 'b'.repeat(64),
      metadata: { persona: { id: 42 }, prompt_version: 'v3' },
    });
    expect(result.metadata).toEqual({
      persona: { id: 42 },
      prompt_version: 'v3',
    });
  });
});
