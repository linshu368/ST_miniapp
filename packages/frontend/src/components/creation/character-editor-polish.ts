export type CharacterPolishTarget = 'opening' | 'background';

export type CharacterPolishSession = {
  target: CharacterPolishTarget;
  original: string;
  result: string;
  state: 'loading' | 'ready' | 'error';
  error: string;
};

export type CharacterPolishCandidates = Partial<
  Record<CharacterPolishTarget, CharacterPolishSession>
>;

/** Restoring text never restarts a provider request or treats an interrupted stream as complete. */
export function parseCharacterPolishCandidates(value: unknown): CharacterPolishCandidates {
  const candidates: CharacterPolishCandidates = {};
  if (!value || typeof value !== 'object') return candidates;
  const source = value as Record<string, unknown>;
  for (const target of ['opening', 'background'] as const) {
    const candidate = source[target];
    if (!candidate || typeof candidate !== 'object') continue;
    const record = candidate as Record<string, unknown>;
    if (
      record.target !== target ||
      typeof record.original !== 'string' ||
      typeof record.result !== 'string' ||
      !record.result.trim() ||
      (record.state !== 'loading' && record.state !== 'ready' && record.state !== 'error')
    )
      continue;
    candidates[target] = {
      target,
      original: record.original,
      result: record.result,
      state: record.state === 'loading' ? 'error' : record.state,
      error:
        record.state === 'loading'
          ? '上次润色已中断，已有内容已保留，可以采用或重新尝试。'
          : typeof record.error === 'string'
            ? record.error
            : '',
    };
  }
  return candidates;
}
