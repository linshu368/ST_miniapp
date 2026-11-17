import { describe, expect, it } from 'vitest';
import {
  SurplusResponseCapture,
  sanitizeSurplusRequestParameters,
} from './surplus-response-capture.js';
import { surplusRecord, surplusJsonbBytes } from './surplus-response-schema.js';

const snapshot = (capture: SurplusResponseCapture) => capture.snapshot();

describe('SurplusResponseCapture', () => {
  it('retains sparse first-frame and terminal metadata without persisting conversation content', () => {
    const capture = new SurplusResponseCapture();
    capture.observe({
      id: 'gen-1',
      model: 'vendor/model',
      created: 5,
      system_fingerprint: 'fp-1',
      choices: [
        { index: 0, delta: { role: 'assistant', content: 'PRIVATE_REPLY' }, finish_reason: null },
      ],
    });
    capture.observe({
      choices: [
        { index: 0, delta: { reasoning_content: 'PRIVATE_THINKING' }, finish_reason: 'stop' },
      ],
      usage: {
        prompt_tokens: 12,
        completion_tokens: 4,
        total_tokens: 16,
        buyer_cost_micro: '1500001',
        prompt_tokens_details: { cached_tokens: 0, audio_tokens: 2 },
        completion_tokens_details: { reasoning_tokens: 1, accepted_prediction_tokens: 2 },
      },
    });
    capture.comment('data: [DONE]');
    expect(snapshot(capture)).toMatchObject({
      stream: {
        id: 'gen-1',
        system_fingerprint: 'fp-1',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: 'stop' }],
      },
    });
    expect(capture.projection()).toMatchObject({
      generationId: 'gen-1',
      model: 'vendor/model',
      promptTokens: 12,
      completionTokens: 4,
      totalTokens: 16,
      cachedTokens: 0,
      reasoningTokens: 1,
      buyerCostMicro: '1500001',
      usageUsd: '1.500001',
      streamCompleted: true,
      finishReason: 'stop',
    });
    expect(JSON.stringify(snapshot(capture))).not.toMatch(/PRIVATE_REPLY|PRIVATE_THINKING/);
  });

  it('merges choices by their explicit index and never sums repeated cumulative usage', () => {
    const capture = new SurplusResponseCapture();
    capture.observe({
      choices: [
        { index: 1, delta: { role: 'assistant' } },
        { index: 0, finish_reason: null },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    capture.observe({
      choices: [{ index: 0, finish_reason: 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    capture.observe({ choices: [], usage: null, model: null });
    expect(snapshot(capture)).toMatchObject({
      stream: {
        choices: [
          { index: 1, delta: { role: 'assistant' } },
          { index: 0, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 2 },
        model: null,
      },
    });
    expect(capture.projection().promptTokens).toBe(10);
  });

  it('preserves all allowlisted headers with original safe values and separate identities', () => {
    const capture = new SurplusResponseCapture();
    capture.headers(
      new Headers({
        'X-Request-Id': 'req-1',
        'x-generation-id': 'gen-header',
        'x-si-served-by': 'marketplace',
        'x-si-marketplace-attempts': '2',
        'x-si-attempts': 'openai:offer-1:timeout,venice:-:unavailable',
        'x-si-adapted-params': 'reasoning_effort, temperature',
        'x-si-buyer-cost-micro': '0',
        'x-si-truncated': '1',
        'x-si-secret-masking': 'applied',
        'x-si-secrets-masked': '2',
        'x-si-secrets-withheld': '1',
        'x-ratelimit-limit': '1200',
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': '1700000000',
        'retry-after': 'Wed, 21 Oct 2015 07:28:00 GMT',
        Authorization: 'Bearer PRIVATE_KEY',
        'set-cookie': 'PRIVATE_COOKIE',
        'x-si-new-metric': 'PRIVATE_EXTENSION',
      })
    );
    const saved = snapshot(capture);
    expect(saved.headers).toMatchObject({
      'x-request-id': 'req-1',
      'x-si-marketplace-attempts': '2',
      'x-ratelimit-remaining': '0',
      'x-si-buyer-cost-micro': '0',
    });
    expect(capture.projection()).toMatchObject({
      generationId: 'gen-header',
      requestId: 'req-1',
      buyerCostMicro: '0',
      usageUsd: '0.000000',
      truncated: true,
    });
    expect(JSON.stringify(saved)).not.toMatch(/PRIVATE_/);
    expect(saved.capture).toMatchObject({ status: 'partial', counts: { unknown: 1 } });
  });

  it('retains nonstream and authoritative record costs independently without mixing request and generation IDs', () => {
    const capture = new SurplusResponseCapture();
    capture.observe({ id: 'completion-1', usage: { buyer_cost_micro: '12' } }, 'body');
    capture.observe(
      {
        data: {
          id: 'request-1',
          model: 'vendor/final',
          provider_name: 'openai',
          usage: { buyer_cost_micro: '15' },
          route_overhead_ms: 1,
          first_token_ms: 7,
          upstream_total_ms: 20,
          status: 'settled',
        },
      },
      'request_record'
    );
    expect(capture.projection()).toMatchObject({
      generationId: 'completion-1',
      requestId: 'request-1',
      buyerCostMicro: '15',
      usageUsd: '0.000015',
      providerName: 'openai',
      routeOverheadMs: 1,
    });
    expect(snapshot(capture)).toMatchObject({
      body: { usage: { buyer_cost_micro: '12' } },
      request_record: { data: { usage: { buyer_cost_micro: '15' } } },
    });
  });

  it('does not treat a request-record-only id as a generation id', () => {
    const capture = new SurplusResponseCapture();
    capture.observe({ id: 'request-only' }, 'request_record');
    expect(capture.projection()).toMatchObject({ requestId: 'request-only', generationId: null });
  });

  it('uses the database identity grammar while retaining slash-separated model identifiers', () => {
    const capture = new SurplusResponseCapture();
    capture.headers(
      new Headers({ 'x-request-id': 'invalid/request', 'x-generation-id': 'also+invalid' })
    );
    capture.observe({ id: 'invalid@identity', model: 'vendor/model' });
    expect(capture.projection()).toMatchObject({
      generationId: null,
      requestId: null,
      model: 'vendor/model',
    });
    expect(capture.identityConflict).toBe(true);
    expect(snapshot(capture).capture).toMatchObject({ counts: { invalid: 3 }, status: 'partial' });
  });

  it('keeps exact 30-digit microdollars and rejects unsafe numeric money', () => {
    const capture = new SurplusResponseCapture();
    capture.observe({ usage: { buyer_cost_micro: '999999999999999999999999999999' } });
    expect(capture.projection()).toMatchObject({
      buyerCostMicro: '999999999999999999999999999999',
      usageUsd: '999999999999999999999999.999999',
    });
    capture.observe({ usage: { buyer_cost_micro: Number.MAX_SAFE_INTEGER + 1 } });
    expect(capture.projection().buyerCostMicro).toBe('999999999999999999999999999999');
    expect(snapshot(capture).capture).toMatchObject({ status: 'partial', counts: { invalid: 1 } });
  });

  it('does not fill absent optional fields with zero', () => {
    const capture = new SurplusResponseCapture();
    capture.observe({ id: 'gen-1', usage: null });
    expect(capture.projection()).toMatchObject({
      buyerCostMicro: null,
      usageUsd: null,
      promptTokens: null,
      completionTokens: null,
      cachedTokens: null,
    });
  });

  it('keeps diagnostic error codes and excludes raw errors, tool arguments and token text', () => {
    const capture = new SurplusResponseCapture();
    capture.observe(
      {
        error: { code: 429, type: 'rate_limit_error', param: 'model', message: 'PRIVATE_ERROR' },
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: { name: 'PRIVATE_TOOL', arguments: 'PRIVATE_ARGS' },
                },
              ],
              refusal: 'PRIVATE_REFUSAL',
            },
            logprobs: { content: [{ token: 'PRIVATE_TOKEN' }] },
          },
        ],
      },
      'body'
    );
    expect(snapshot(capture)).toMatchObject({
      body: {
        error: { code: 429, type: 'rate_limit_error' },
        choices: [{ message: { tool_calls: [{ id: 'call-1', type: 'function' }] } }],
      },
    });
    expect(capture.projection().errorCode).toBe('429');
    expect(JSON.stringify(snapshot(capture))).not.toMatch(/PRIVATE_/);
  });

  it('records the controlled withheld comment without persisting arbitrary SSE comments', () => {
    const capture = new SurplusResponseCapture();
    capture.comment(': ping PRIVATE_COMMENT');
    capture.comment(': si-secrets-withheld 3');
    capture.finish(false);
    capture.finish(true);
    expect(snapshot(capture)).toMatchObject({
      stream: { si_secrets_withheld: '3' },
      capture: {
        stream_completed: true,
        status: 'partial',
        unavailable_sources: [{ source: 'stream', reason: 'interrupted' }],
      },
    });
    expect(JSON.stringify(snapshot(capture))).not.toContain('PRIVATE_COMMENT');
  });

  it('records bounded conflicts but retains the first observed immutable identity', () => {
    const capture = new SurplusResponseCapture();
    capture.observe({ id: 'original', model: 'vendor/first' });
    capture.observe({ id: 'conflicting', model: 'vendor/last' });
    expect(capture.projection()).toMatchObject({ generationId: 'original', model: 'vendor/last' });
    expect(snapshot(capture).capture).toMatchObject({
      conflicts: [
        { path: 'stream.id', previous: 'original', value: 'conflicting' },
        { path: 'stream.model', previous: 'vendor/first', value: 'vendor/last' },
      ],
    });
  });

  it('hydrates validated partitions and preserves previous omission and conflict evidence', () => {
    const first = new SurplusResponseCapture();
    first.headers(new Headers({ 'x-request-id': 'req-1' }));
    first.observe({ id: 'gen-1', model: 'a', unknown_field: 'PRIVATE_VALUE' });
    first.observe({ model: 'b' });
    const restored = new SurplusResponseCapture(first.snapshot());
    restored.observe(
      { request: { id: 'req-1', usage: { buyer_cost_micro: '10' } } },
      'request_record'
    );
    expect(restored.projection()).toMatchObject({
      generationId: 'gen-1',
      requestId: 'req-1',
      buyerCostMicro: '10',
    });
    expect(snapshot(restored).capture).toMatchObject({
      counts: { unknown: 1 },
      conflicts: [{ path: 'stream.model', previous: 'a', value: 'b' }],
    });
    expect(JSON.stringify(snapshot(restored))).not.toContain('PRIVATE_VALUE');
  });

  it('does not trust unsupported seed versions or malicious stored headers and fields', () => {
    const unsupported = new SurplusResponseCapture({
      body: { id: 'PRIVATE_RAW' },
      capture: { schema_version: 99 },
    });
    expect(unsupported.projection().generationId).toBeNull();
    const capture = new SurplusResponseCapture({
      body: {
        id: 'inf_SECRET',
        model: 'vendor/model',
        usage: { prompt_tokens: -1, extra: 'PRIVATE_VALUE' },
      },
      headers: { 'x-request-id': 'bad\r\nPRIVATE_HEADER' },
      capture: { schema_version: 1 },
    });
    expect(capture.projection()).toMatchObject({ generationId: null, model: 'vendor/model' });
    expect(JSON.stringify(snapshot(capture))).not.toMatch(/PRIVATE_|inf_SECRET/);
  });

  it('bounds metadata UTF-8 bytes and diagnostic arrays while preserving terminal identity and usage', () => {
    const capture = new SurplusResponseCapture();
    const tools = Array.from({ length: 128 }, (_, index) => ({
      index,
      id: `call-${index}-${'a'.repeat(400)}`,
      type: 'function',
    }));
    capture.observe({
      id: 'gen-large',
      choices: Array.from({ length: 128 }, (_, index) => ({
        index,
        message: { role: 'assistant', tool_calls: tools },
      })),
      usage: { buyer_cost_micro: '0', total_tokens: 4 },
    });
    for (let i = 0; i < 100; i++) capture.observe({ [`extra_${i}`]: 'PRIVATE_EXTRA' });
    const saved = snapshot(capture);
    expect(Buffer.byteLength(JSON.stringify(saved), 'utf8')).toBeLessThanOrEqual(128 * 1024);
    expect(surplusRecord(saved.capture)?.diagnostics).toHaveLength(64);
    expect(capture.projection()).toMatchObject({
      generationId: 'gen-large',
      buyerCostMicro: '0',
      totalTokens: 4,
    });
    expect(saved.capture).toMatchObject({ status: 'partial' });
  });

  it('accepts exactly the first 128 bounded choices and reports remaining elements', () => {
    const capture = new SurplusResponseCapture();
    capture.observe({
      choices: Array.from({ length: 129 }, (_, index) => ({ index, finish_reason: 'stop' })),
    });
    expect(surplusRecord(snapshot(capture).stream)?.choices).toHaveLength(128);
    expect(snapshot(capture).capture).toMatchObject({
      counts: { over_limit: 1 },
      status: 'partial',
    });
  });

  it('captures documented reasoning routing headers and measures PostgreSQL separator bytes', () => {
    const capture = new SurplusResponseCapture();
    capture.headers(
      new Headers({
        'x-si-provider-family': 'openai',
        'x-si-marketplace-status': 'served',
        'x-si-routing-decision-ms': '12.25',
      })
    );
    expect(snapshot(capture).headers).toEqual({
      'x-si-provider-family': 'openai',
      'x-si-marketplace-status': 'served',
      'x-si-routing-decision-ms': '12.25',
    });
    expect(surplusJsonbBytes({ a: [1, 2], b: 'a,b:c' })).toBe(
      Buffer.byteLength('{"a": [1, 2], "b": "a,b:c"}')
    );
    expect(surplusJsonbBytes(snapshot(capture))).toBeLessThanOrEqual(128 * 1024);
    expect(surplusJsonbBytes({ latency_ms: 1e-7 })).toBe(
      Buffer.byteLength('{"latency_ms": 0.0000001}')
    );
    expect(surplusJsonbBytes({ latency_ms: Number.MIN_VALUE })).toBeGreaterThan(320);
  });

  it('stores only validated reasoning-control diagnostics and retains them across recovery', () => {
    const capture = new SurplusResponseCapture();
    capture.recordReasoningControl({
      parameters: { raw: 'PRIVATE_SETTING' },
      control: 'provider_default',
      reason: 'effort_values_unspecified',
      requestedEnabled: false,
      supportedParameters: ['reasoning_effort'],
    });
    const restored = new SurplusResponseCapture(capture.snapshot());
    expect(snapshot(restored).capture).toMatchObject({
      reasoning_control: {
        control: 'provider_default',
        reason: 'effort_values_unspecified',
        requestedEnabled: false,
        supportedParameters: ['reasoning_effort'],
      },
    });
    expect(JSON.stringify(restored.snapshot())).not.toContain('PRIVATE_SETTING');
  });
});

describe('sanitizeSurplusRequestParameters', () => {
  it('retains only actually sent non-content parameters including a negative sampling penalty', () => {
    expect(
      sanitizeSurplusRequestParameters({
        model: 'vendor/model',
        stream: true,
        frequency_penalty: -0.5,
        max_tokens: 1024,
        stream_options: { include_usage: true },
        messages: [{ role: 'user', content: 'PRIVATE_INPUT' }],
        api_key: 'PRIVATE_KEY',
      })
    ).toEqual({
      model: 'vendor/model',
      stream: true,
      frequency_penalty: -0.5,
      max_tokens: 1024,
      stream_options: { include_usage: true },
    });
    expect(sanitizeSurplusRequestParameters({ model: 'vendor/model' })).toEqual({
      model: 'vendor/model',
    });
  });
});
