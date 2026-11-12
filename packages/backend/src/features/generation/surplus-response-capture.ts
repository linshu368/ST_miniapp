import {
  SURPLUS_REQUEST_RULE,
  SURPLUS_RESPONSE_RULE,
  SURPLUS_REQUEST_RECORD_RULE,
  surplusMoney,
  surplusRecord,
  surplusUsd,
  surplusJsonbBytes,
  type SurplusJson,
  type SurplusObject,
} from './surplus-response-schema.js';
import {
  filterSurplusValue,
  safeSurplusPath,
  SURPLUS_HEADER_NAMES,
  validSurplusHeader,
  type SurplusDiagnostic,
  type SurplusIssue,
} from './surplus-response-filter.js';

export type SurplusSource = 'body' | 'stream' | 'headers' | 'request_record';
export type SurplusResponseMetadata = SurplusObject;
interface Conflict {
  path: string;
  previous?: SurplusJson;
  value?: SurplusJson;
}
const SOURCES: SurplusSource[] = ['body', 'stream', 'headers', 'request_record'];
const REASONS = new Set([
  'forbidden',
  'not_found',
  'missing_id',
  'http_error',
  'timeout',
  'network',
  'invalid',
  'interrupted',
  'not_requested',
  'unknown',
  'unsupported_version',
  'over_limit',
  'retry_budget_exhausted',
]);
const LIMIT = 128 * 1024;
const size = surplusJsonbBytes;
const valueType = (value: unknown) =>
  value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;

/** Accumulates only bounded protocol facts; sparse terminal frames cannot erase first-frame evidence. */
export class SurplusResponseCapture {
  private readonly sources: Partial<Record<SurplusSource, SurplusObject>> = {};
  private readonly unavailableSources = new Map<SurplusSource, string>();
  private readonly counts = { unknown: 0, invalid: 0, excluded: 0, over_limit: 0 };
  private readonly diagnostics: SurplusDiagnostic[] = [];
  private readonly conflicts: Conflict[] = [];
  private diagnosticsOmitted = 0;
  private conflictsOmitted = 0;
  private streamCompleted: boolean | null = null;
  private budgetReported = false;
  private identityConflictDetected = false;
  private reasoningControl: SurplusObject | null = null;

  constructor(seed?: unknown) {
    if (seed !== undefined) this.hydrate(seed);
  }

  get identityConflict(): boolean {
    return this.identityConflictDetected;
  }

  recordReasoningControl(value: unknown): void {
    const item = surplusRecord(value);
    if (
      !item ||
      !['effort', 'provider_default', 'unavailable'].includes(String(item.control)) ||
      ![
        'effort_mapped',
        'effort_values_unspecified',
        'unsupported',
        'directory_unavailable',
      ].includes(String(item.reason)) ||
      typeof item.requestedEnabled !== 'boolean' ||
      !Array.isArray(item.supportedParameters) ||
      item.supportedParameters.length > 128 ||
      !item.supportedParameters.every(
        (name) => typeof name === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(name)
      )
    ) {
      this.report('invalid', 'capture.reasoning_control', value);
      return;
    }
    this.reasoningControl = {
      control: String(item.control),
      reason: String(item.reason),
      requestedEnabled: item.requestedEnabled,
      supportedParameters: item.supportedParameters,
    };
  }

  private readonly report = (kind: SurplusIssue, path: string, value: unknown): void => {
    if (
      kind === 'invalid' &&
      /^(?:(?:body|stream|request_record)(?:\.(?:data|request))?\.(?:id|request_id|generation_id)|headers\.(?:x-request-id|x-si-request-id|x-generation-id))$/.test(
        path
      )
    )
      this.identityConflictDetected = true;
    this.counts[kind] = Math.min(Number.MAX_SAFE_INTEGER, this.counts[kind] + 1);
    const diagnostic = { kind, path: safeSurplusPath(path), type: valueType(value) };
    if (this.diagnostics.some((item) => JSON.stringify(item) === JSON.stringify(diagnostic)))
      return;
    if (this.diagnostics.length < 64) this.diagnostics.push(diagnostic);
    else this.diagnosticsOmitted += 1;
  };

  observe(value: unknown, source: Exclude<SurplusSource, 'headers'> = 'stream'): void {
    const rule = source === 'request_record' ? SURPLUS_REQUEST_RECORD_RULE : SURPLUS_RESPONSE_RULE;
    const filtered = filterSurplusValue(value, rule, this.report, source);
    if (!surplusRecord(filtered)) return;
    this.sources[source] = this.merge(
      this.sources[source] ?? {},
      filtered as SurplusObject,
      source
    ) as SurplusObject;
    this.unavailableSources.delete(source);
    this.enforceBudget();
  }

  headers(headers: Headers): void {
    const result: SurplusObject = {};
    for (const [name, value] of headers.entries()) {
      if (!SURPLUS_HEADER_NAMES.has(name)) {
        // Transport headers are not provider metadata. Unknown SI fields are surfaced for review.
        if (name.startsWith('x-si-')) this.report('unknown', `headers.${name}`, value);
        continue;
      }
      if (validSurplusHeader(name, value)) result[name] = value;
      else this.report('invalid', `headers.${name}`, value);
    }
    this.sources.headers = this.merge(
      this.sources.headers ?? {},
      result,
      'headers'
    ) as SurplusObject;
    this.unavailableSources.delete('headers');
    this.enforceBudget();
  }

  comment(line: string): void {
    if (/^(?:data:\s*)?\[DONE\]\s*$/.test(line)) {
      this.finish(true);
      return;
    }
    const match = /^:\s*si-secrets-withheld\s+(\d+)\s*$/.exec(line);
    if (!match) return;
    const amount = surplusMoney(match[1]);
    if (amount === null) {
      this.report('invalid', 'stream.si_secrets_withheld', match[1]);
      return;
    }
    const stream = this.sources.stream ?? {};
    this.sources.stream = this.merge(
      stream,
      { si_secrets_withheld: amount },
      'stream'
    ) as SurplusObject;
  }

  finish(completed: boolean): void {
    this.streamCompleted = this.streamCompleted === true || completed;
    if (!completed) this.unavailable('stream', 'interrupted');
  }

  unavailable(source: SurplusSource, reason: string): void {
    this.unavailableSources.set(source, REASONS.has(reason) ? reason : 'unknown');
  }

  snapshot(): SurplusResponseMetadata {
    this.enforceBudget();
    return JSON.parse(
      JSON.stringify({ ...this.sources, capture: this.capture() })
    ) as SurplusObject;
  }

  projection() {
    const record = this.sources.request_record;
    const recordPayload = surplusRecord(record?.data) ?? surplusRecord(record?.request) ?? record;
    const ordered = [recordPayload, this.sources.body, this.sources.stream];
    const pick = (key: string) =>
      ordered.map((source) => source?.[key]).find((value) => value !== null && value !== undefined);
    const text = (value: unknown) => (typeof value === 'string' ? value : null);
    const number = (value: unknown) =>
      typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
    const usages = ordered.map((source) => surplusRecord(source?.usage));
    const token = (key: string) =>
      number(
        usages.map((usage) => usage?.[key]).find((value) => value !== null && value !== undefined)
      );
    const details = (parent: string, key: string) =>
      number(
        usages
          .map((usage) => surplusRecord(usage?.[parent])?.[key])
          .find((value) => value !== null && value !== undefined)
      );
    const headers = this.sources.headers;
    const costs = [
      ...ordered.flatMap((source) => [
        source?.buyer_cost_micro,
        surplusRecord(source?.usage)?.buyer_cost_micro,
      ]),
      headers?.['x-si-buyer-cost-micro'],
    ];
    const buyerCostMicro = costs.map(surplusMoney).find((value) => value !== null) ?? null;
    const choices = ordered.flatMap((source) =>
      Array.isArray(source?.choices) ? source.choices : []
    );
    const choiceFinish = choices
      .map((choice) => surplusRecord(choice)?.finish_reason)
      .find((value) => typeof value === 'string');
    return {
      generationId:
        text(pick('generation_id')) ??
        text(this.sources.body?.id) ??
        text(this.sources.stream?.id) ??
        text(headers?.['x-generation-id']),
      requestId:
        text(pick('request_id')) ??
        text(headers?.['x-si-request-id']) ??
        text(headers?.['x-request-id']) ??
        text(recordPayload?.id),
      model: text(pick('model')),
      providerName: text(pick('provider_name')) ?? text(pick('provider')),
      finishReason: text(pick('finish_reason')) ?? text(choiceFinish),
      promptTokens: token('prompt_tokens') ?? token('input_tokens'),
      completionTokens: token('completion_tokens') ?? token('output_tokens'),
      totalTokens: token('total_tokens'),
      cachedTokens:
        details('prompt_tokens_details', 'cached_tokens') ??
        details('input_tokens_details', 'cached_tokens') ??
        token('cached_tokens'),
      reasoningTokens:
        details('completion_tokens_details', 'reasoning_tokens') ??
        details('output_tokens_details', 'reasoning_tokens') ??
        token('reasoning_tokens'),
      buyerCostMicro,
      usageUsd: surplusUsd(buyerCostMicro),
      routeOverheadMs: number(pick('route_overhead_ms')),
      firstTokenMs: number(pick('first_token_ms')),
      upstreamTotalMs: number(pick('upstream_total_ms')),
      truncated: headers?.['x-si-truncated'] === '1' || pick('truncated') === true,
      streamCompleted: this.streamCompleted,
      errorCode:
        typeof surplusRecord(pick('error'))?.code === 'number'
          ? String(surplusRecord(pick('error'))?.code)
          : text(surplusRecord(pick('error'))?.code),
    };
  }

  private capture(): SurplusObject {
    const partial =
      this.counts.unknown + this.counts.invalid + this.counts.over_limit > 0 ||
      this.unavailableSources.size > 0;
    return {
      schema_version: 1,
      status:
        Object.keys(this.sources).length === 0 ? 'unavailable' : partial ? 'partial' : 'complete',
      observed_sources: Object.keys(this.sources),
      unavailable_sources: [...this.unavailableSources].map(([source, reason]) => ({
        source,
        reason,
      })),
      counts: { ...this.counts },
      diagnostics: this.diagnostics.map((item) => ({ ...item })),
      conflicts: this.conflicts.map((item) => ({ ...item })),
      diagnostics_omitted: this.diagnosticsOmitted,
      conflicts_omitted: this.conflictsOmitted,
      stream_completed: this.streamCompleted,
      identity_conflict: this.identityConflictDetected,
      ...(this.reasoningControl ? { reasoning_control: this.reasoningControl } : {}),
    };
  }

  private merge(previous: SurplusJson, value: SurplusJson, path: string): SurplusJson {
    if (value === null && previous !== null) return previous;
    const left = surplusRecord(previous);
    const right = surplusRecord(value);
    if (left && right) {
      const result = { ...left } as SurplusObject;
      for (const [key, child] of Object.entries(right)) {
        const existing = result[key];
        result[key] =
          existing !== undefined
            ? this.merge(existing, child as SurplusJson, `${path}.${key}`)
            : (child as SurplusJson);
      }
      return result;
    }
    if (Array.isArray(previous) && Array.isArray(value))
      return this.mergeArray(previous, value, path);
    if (JSON.stringify(previous) !== JSON.stringify(value)) {
      this.recordConflict(path, previous, value);
      if (
        /(?:^|\.)(?:id|request_id|generation_id|x-request-id|x-si-request-id|x-generation-id)$/.test(
          path
        )
      ) {
        this.identityConflictDetected = true;
        this.report('invalid', path, value);
        return previous;
      }
    }
    return value;
  }

  private mergeArray(previous: SurplusJson[], value: SurplusJson[], path: string): SurplusJson[] {
    const result = [...previous];
    for (const [position, item] of value.entries()) {
      const index = surplusRecord(item)?.index;
      const target =
        typeof index === 'number'
          ? result.findIndex((candidate) => surplusRecord(candidate)?.index === index)
          : position;
      const existing = result[target];
      if (target >= 0 && existing !== undefined)
        result[target] = this.merge(existing, item, `${path}.[]`);
      else if (result.length < 128) result.push(item);
      else this.report('over_limit', path, item);
    }
    return result;
  }

  private recordConflict(path: string, previous: SurplusJson, value: SurplusJson): void {
    if (this.conflicts.length >= 64) {
      this.conflictsOmitted += 1;
      return;
    }
    const scalar = (item: SurplusJson) => item === null || typeof item !== 'object';
    this.conflicts.push({
      path: safeSurplusPath(path),
      ...(scalar(previous) ? { previous } : {}),
      ...(scalar(value) ? { value } : {}),
    });
  }

  private enforceBudget(): void {
    if (size({ ...this.sources, capture: this.capture() }) <= LIMIT) return;
    if (!this.budgetReported) {
      this.report('over_limit', 'capture.bytes', LIMIT);
      this.budgetReported = true;
    }
    this.conflicts.length = 0;
    // Choice/tool diagnostics can be wide. Keep call identity, terminal usage and money intact.
    for (const source of SOURCES) {
      const partition = this.sources[source];
      const choices = partition?.choices;
      if (!Array.isArray(choices)) continue;
      for (const choice of choices) {
        const record = surplusRecord(choice);
        for (const field of ['message', 'delta']) {
          const message = surplusRecord(record?.[field]);
          if (message?.tool_calls) delete message.tool_calls;
        }
      }
      while (choices.length > 1 && size({ ...this.sources, capture: this.capture() }) > LIMIT)
        choices.pop();
    }
  }

  private hydrate(seed: unknown): void {
    const source = surplusRecord(seed);
    const capture = surplusRecord(source?.capture);
    if (!source || capture?.schema_version !== 1) {
      this.unavailable('request_record', 'unsupported_version');
      return;
    }
    for (const name of ['body', 'stream', 'request_record'] as const) {
      if (!source[name]) continue;
      const value = { ...surplusRecord(source[name]) };
      const withheld = value.si_secrets_withheld;
      delete value.si_secrets_withheld;
      this.observe(value, name);
      if (name === 'stream' && surplusMoney(withheld) !== null)
        this.comment(`: si-secrets-withheld ${String(withheld)}`);
    }
    const headers = surplusRecord(source.headers);
    if (headers) {
      const validated = new Headers();
      for (const [key, value] of Object.entries(headers)) {
        if (
          SURPLUS_HEADER_NAMES.has(key) &&
          typeof value === 'string' &&
          validSurplusHeader(key, value)
        )
          validated.set(key, value);
        else this.report('invalid', `headers.${key}`, value);
      }
      this.headers(validated);
    }
    const counts = surplusRecord(capture.counts);
    for (const key of ['unknown', 'invalid', 'excluded', 'over_limit'] as const)
      this.counts[key] = Math.max(this.counts[key], count(counts?.[key]));
    if (typeof capture.stream_completed === 'boolean')
      this.streamCompleted = capture.stream_completed;
    this.identityConflictDetected ||= capture.identity_conflict === true;
    if (capture.reasoning_control !== undefined)
      this.recordReasoningControl(capture.reasoning_control);
    if (Array.isArray(capture.unavailable_sources)) {
      for (const item of capture.unavailable_sources.slice(0, 4)) {
        const row = surplusRecord(item);
        if (SOURCES.includes(row?.source as SurplusSource) && typeof row?.reason === 'string')
          this.unavailable(row.source as SurplusSource, row.reason);
      }
    }
    this.diagnosticsOmitted += count(capture.diagnostics_omitted);
    this.conflictsOmitted += count(capture.conflicts_omitted);
    this.restoreDiagnostics(capture);
    this.enforceBudget();
  }

  private restoreDiagnostics(capture: Record<string, unknown>): void {
    const kinds: SurplusIssue[] = ['unknown', 'invalid', 'excluded', 'over_limit'];
    const types = [
      'null',
      'array',
      'object',
      'number',
      'boolean',
      'string',
      'undefined',
      'bigint',
      'function',
      'symbol',
    ];
    for (const value of Array.isArray(capture.diagnostics)
      ? capture.diagnostics.slice(0, 64)
      : []) {
      const item = surplusRecord(value);
      if (
        !item ||
        !kinds.includes(item.kind as SurplusIssue) ||
        typeof item.path !== 'string' ||
        !types.includes(String(item.type))
      )
        continue;
      if (this.diagnostics.length < 64)
        this.diagnostics.push({
          kind: item.kind as SurplusIssue,
          path: safeSurplusPath(item.path),
          type: String(item.type),
        });
      else this.diagnosticsOmitted += 1;
    }
    const safeScalar = (value: unknown): value is null | boolean | number | string =>
      value === null ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (typeof value === 'string' &&
        /^[a-zA-Z0-9_.:/@+\-]{1,512}$/.test(value) &&
        !/^(?:bearer|sk[-_]|inf[-_]|sb_secret[-_]|eyJ)/i.test(value));
    for (const value of Array.isArray(capture.conflicts) ? capture.conflicts.slice(0, 64) : []) {
      const item = surplusRecord(value);
      if (!item || typeof item.path !== 'string') continue;
      if (this.conflicts.length < 64)
        this.conflicts.push({
          path: safeSurplusPath(item.path),
          ...(safeScalar(item.previous) ? { previous: item.previous } : {}),
          ...(safeScalar(item.value) ? { value: item.value } : {}),
        });
      else this.conflictsOmitted += 1;
    }
  }
}

/** Persist only fields actually sent. Messages and unknown extensions never enter this snapshot. */
export function sanitizeSurplusRequestParameters(body: unknown): Record<string, unknown> {
  const result = filterSurplusValue(body, SURPLUS_REQUEST_RULE, () => undefined, 'request');
  const object = surplusRecord(result) ?? {};
  if (size(object) > 16 * 1024) throw new Error('Surplus request parameters exceed 16 KiB');
  return object;
}
