import { describe, expect, it } from 'vitest';

import { resolveLogPretty } from './log-pretty.js';

describe('resolveLogPretty', () => {
  it('uses JSON in production even when pino-pretty is installed', () => {
    expect(
      resolveLogPretty({
        nodeEnv: 'production',
        logPrettyEnv: undefined,
        prettyAvailable: true,
      })
    ).toBe(false);
  });

  it('falls back to JSON in development when pino-pretty is missing', () => {
    expect(
      resolveLogPretty({
        nodeEnv: 'development',
        logPrettyEnv: undefined,
        prettyAvailable: false,
      })
    ).toBe(false);
  });

  it('enables pretty in development when pino-pretty is available', () => {
    expect(
      resolveLogPretty({
        nodeEnv: 'development',
        logPrettyEnv: undefined,
        prettyAvailable: true,
      })
    ).toBe(true);
  });

  it('honors LOG_PRETTY=0 / 1', () => {
    expect(
      resolveLogPretty({
        nodeEnv: 'development',
        logPrettyEnv: '0',
        prettyAvailable: true,
      })
    ).toBe(false);
    expect(
      resolveLogPretty({
        nodeEnv: 'production',
        logPrettyEnv: '1',
        prettyAvailable: true,
      })
    ).toBe(true);
    expect(
      resolveLogPretty({
        nodeEnv: 'production',
        logPrettyEnv: '1',
        prettyAvailable: false,
      })
    ).toBe(false);
  });
});
