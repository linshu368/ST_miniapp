import { describe, expect, it } from 'vitest';
import { batchLabQueryKeys } from './query-keys';

describe('batchLabQueryKeys', () => {
  it('isolates server cache by backend and source environment', () => {
    expect(
      batchLabQueryKeys.environment({
        backend_environment: 'development',
        source_environment: 'test',
        capabilities: { sample_preview: false, experiment_execution: false },
      })
    ).toEqual(['batch-lab', 'development', 'test']);
  });
});
