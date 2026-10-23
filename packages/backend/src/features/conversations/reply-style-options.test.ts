import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchPublicReplyStyleOptions } from './reply-style-options.js';

const runtime = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../platform/runtime-config.js', () => ({ fetchRuntimeConfigEntry: runtime.fetch }));

beforeEach(() => runtime.fetch.mockReset());
afterEach(() => vi.restoreAllMocks());

const option = {
  id: 'style-first',
  name: '表达方式',
  description: '选项说明',
  marker: 'PRIVATE_MARKER',
  rules: 'PRIVATE_RULE_CONTENT',
  enabled: true,
};

describe('published reply-style UI metadata', () => {
  it('projects only enabled metadata in published array order', async () => {
    runtime.fetch.mockResolvedValue({
      value: {
        options: [
          { ...option, id: 'style-second', marker: 'SECOND_MARKER', name: '排在前面' },
          { ...option, id: 'style-hidden', marker: 'HIDDEN_MARKER', enabled: false },
          option,
        ],
      },
      textValue: null,
      version: 2,
    });

    const options = await fetchPublicReplyStyleOptions();
    expect(options).toEqual([
      { id: 'style-second', name: '排在前面', description: '选项说明' },
      { id: 'style-first', name: '表达方式', description: '选项说明' },
    ]);
    expect(JSON.stringify(options)).not.toContain('PRIVATE_');
    expect(runtime.fetch).toHaveBeenCalledWith('reply_style_options', expect.any(AbortSignal));
  });

  it('reads only the formal runtime key and reflects a later publication or clear', async () => {
    runtime.fetch
      .mockResolvedValueOnce({ value: { options: [option] }, textValue: null, version: 2 })
      .mockResolvedValueOnce({ value: { options: [] }, textValue: null, version: 3 });
    expect(await fetchPublicReplyStyleOptions()).toHaveLength(1);
    expect(await fetchPublicReplyStyleOptions()).toEqual([]);
    expect(runtime.fetch).toHaveBeenCalledTimes(2);
  });

  it('missing and empty published catalogs are valid empty UI', async () => {
    runtime.fetch.mockResolvedValueOnce(null).mockResolvedValueOnce({
      value: { options: [] },
      textValue: null,
      version: 1,
    });
    expect(await fetchPublicReplyStyleOptions()).toEqual([]);
    expect(await fetchPublicReplyStyleOptions()).toEqual([]);
  });

  it('invalid catalogs are omitted without logging private config or validation issues', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runtime.fetch.mockResolvedValue({
      value: { options: [{ ...option, name: '', description: 'PRIVATE_DESCRIPTION' }] },
      textValue: null,
      version: 9,
    });
    expect(await fetchPublicReplyStyleOptions()).toEqual([]);
    const log = warn.mock.calls.flat().join(' ');
    expect(log).toContain('version 9');
    expect(log).not.toContain('PRIVATE_');
  });
});
