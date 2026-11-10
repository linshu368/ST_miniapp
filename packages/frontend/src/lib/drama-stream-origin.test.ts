import { afterEach, expect, it, vi } from 'vitest';
import { parseDramaStreamOrigin } from './drama-stream-origin';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('accepts only an https Stream customer host and keeps the origin alone', () => {
  expect(parseDramaStreamOrigin('https://customer-abc123.cloudflarestream.com/x/y')).toBe(
    'https://customer-abc123.cloudflarestream.com'
  );
  for (const value of [
    undefined,
    '',
    'not a url',
    'http://customer-abc123.cloudflarestream.com',
    'https://customer-abc123.cloudflarestream.com.evil.invalid',
    'https://videodelivery.net',
  ])
    expect(parseDramaStreamOrigin(value)).toBeUndefined();
});

it('re-inserts one CORS and one native preconnect per playback intent', async () => {
  vi.stubEnv('NEXT_PUBLIC_DRAMA_STREAM_ORIGIN', 'https://customer-abc123.cloudflarestream.com');
  const links: Array<Record<string, unknown>> = [];
  const head = {
    appendChild: (link: Record<string, unknown>) => links.push(link),
    querySelectorAll: () => links.splice(0).map((link) => ({ remove: () => link })),
  };
  vi.stubGlobal('document', { head, createElement: () => ({ dataset: {} }) });
  const { warmDramaStreamOrigin } = await import('./drama-stream-origin');
  warmDramaStreamOrigin();
  warmDramaStreamOrigin();
  expect(links).toHaveLength(2);
  expect(links.map((link) => link.crossOrigin)).toEqual(['anonymous', undefined]);
  expect(links.every((link) => link.rel === 'preconnect')).toBe(true);
});

it('does nothing without a configured origin', async () => {
  const createElement = vi.fn();
  vi.stubGlobal('document', { head: {}, createElement });
  const { warmDramaStreamOrigin } = await import('./drama-stream-origin');
  warmDramaStreamOrigin();
  expect(createElement).not.toHaveBeenCalled();
});
