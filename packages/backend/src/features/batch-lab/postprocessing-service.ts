import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import {
  BATCH_LAB_MAX_PROCESSOR_INPUT_CHARS,
  BATCH_LAB_MAX_PROCESSOR_OUTPUT_CHARS,
  BATCH_LAB_PROCESSOR_TIMEOUT_MS,
  batchLabCreateProcessorVersionRequestSchema,
  batchLabProcessorPreviewRequestSchema,
  type BatchLabCreateProcessorVersionRequest,
  type BatchLabDisplayResult,
  type BatchLabErrorCode,
  type BatchLabProcessorConfig,
  type BatchLabProcessorPreviewRequest,
  type BatchLabProcessorVersion,
  type BatchLabRegexRule,
} from '@miniapp/shared';
import {
  BatchLabProcessorRepository,
  type CreateDisplayResultInput,
} from '../../infrastructure/repositories/BatchLabProcessorRepository.js';
import { BatchLabRepositoryError } from '../../infrastructure/repositories/BatchLabSampleRepository.js';

const DISPLAY_RENDERER = { protocol: 'batch_lab_html_v1' as const, version: 1 as const };
const INLINE_PREVIEW_PROCESSOR_NAME = 'Preview processor';

interface WorkerSuccess {
  ok: true;
  outputText: string;
  matchCount: number;
}

interface WorkerFailure {
  ok: false;
  error: string;
}

type WorkerPayload = WorkerSuccess | WorkerFailure;

export class BatchLabPostprocessingService {
  constructor(private readonly repository = new BatchLabProcessorRepository()) {}

  async listProcessorVersions(): Promise<BatchLabProcessorVersion[]> {
    return this.repository.listProcessorVersions();
  }

  async createProcessorVersion(
    input: BatchLabCreateProcessorVersionRequest
  ): Promise<BatchLabProcessorVersion> {
    const parsed = batchLabCreateProcessorVersionRequestSchema.parse(input);
    if (!validateProcessorConfig(parsed.config).valid) {
      throw new BatchLabRepositoryError(
        'BATCH_LAB_PROCESSOR_VALIDATION_ERROR',
        'Batch Lab processor config is invalid'
      );
    }
    return this.repository.createProcessorVersion({
      name: parsed.name,
      config: parsed.config,
      digest: computeProcessorDigest(parsed.config),
    });
  }

  async preview(input: BatchLabProcessorPreviewRequest): Promise<BatchLabDisplayResult> {
    const parsed = batchLabProcessorPreviewRequestSchema.parse(input);
    const inlineConfig = parsed.config;
    if (inlineConfig && !validateProcessorConfig(inlineConfig).valid) {
      throw new BatchLabRepositoryError(
        'BATCH_LAB_PROCESSOR_VALIDATION_ERROR',
        'Batch Lab processor config is invalid'
      );
    }
    const version =
      parsed.processor_version_id === undefined
        ? await this.repository.createProcessorVersion({
            name: INLINE_PREVIEW_PROCESSOR_NAME,
            config: requireInlineConfig(inlineConfig),
            digest: computeProcessorDigest(requireInlineConfig(inlineConfig)),
          })
        : await this.repository.getProcessorVersion(parsed.processor_version_id);
    const result = await runPostprocessor(version, parsed.input_text);
    const storedInput: CreateDisplayResultInput = {
      ...result,
      input_digest: digestText(parsed.input_text),
    };
    return this.repository.createDisplayResult(storedInput);
  }
}

export async function runPostprocessor(
  version: Pick<BatchLabProcessorVersion, 'id' | 'digest' | 'config'>,
  inputText: string
): Promise<BatchLabDisplayResult> {
  if (inputText.length > BATCH_LAB_MAX_PROCESSOR_INPUT_CHARS) {
    return failureResult(
      version,
      'limit_exceeded',
      'BATCH_LAB_PROCESSOR_LIMIT_EXCEEDED',
      inputText
    );
  }

  const validation = validateProcessorConfig(version.config);
  if (!validation.valid) {
    return failureResult(
      version,
      'validation_error',
      'BATCH_LAB_PROCESSOR_VALIDATION_ERROR',
      inputText
    );
  }

  if (version.config.protocol === 'none_v1') {
    return successResult(version, inputText, inputText, 0);
  }

  const timeoutMs = version.config.timeout_ms ?? BATCH_LAB_PROCESSOR_TIMEOUT_MS;
  const workerResult = await runRegexWorker(inputText, version.config.rules, timeoutMs);
  if (workerResult.status === 'timeout') {
    return failureResult(version, 'timeout', 'BATCH_LAB_PROCESSOR_TIMEOUT', inputText);
  }
  if (workerResult.status === 'runtime_error') {
    return failureResult(version, 'failed', 'BATCH_LAB_PROCESSOR_RUNTIME_ERROR', inputText);
  }
  if (workerResult.outputText.length > BATCH_LAB_MAX_PROCESSOR_OUTPUT_CHARS) {
    return failureResult(
      version,
      'limit_exceeded',
      'BATCH_LAB_PROCESSOR_LIMIT_EXCEEDED',
      inputText
    );
  }
  return successResult(version, inputText, workerResult.outputText, workerResult.matchCount);
}

export function computeProcessorDigest(config: BatchLabProcessorConfig): string {
  return digestText(stableJson(config));
}

export function renderSafeHtml(text: string): string {
  const statusBlocks: string[] = [];
  const memoryBlocks: string[] = [];
  let bodyText = text
    .replace(/\[status\]([\s\S]*?)\[\/status\]/gi, (_match, content: string) => {
      statusBlocks.push(content.trim());
      return '\n';
    })
    .replace(/\[memory\]([\s\S]*?)\[\/memory\]/gi, (_match, content: string) => {
      memoryBlocks.push(content.trim());
      return '\n';
    })
    .trim();

  const bodyHtml = bodyText
    ? `<div class="batch-lab-message-text">${renderParagraphs(bodyText)}</div>`
    : '';
  const statusHtml = statusBlocks
    .filter((value) => value.length > 0)
    .map(
      (value) =>
        `<section class="batch-lab-status-block"><strong>当前状态</strong>${renderLines(value)}</section>`
    )
    .join('');
  const memoryHtml = memoryBlocks
    .filter((value) => value.length > 0)
    .map(
      (value) =>
        `<details class="batch-lab-memory-block"><summary>记忆</summary><div>${renderParagraphs(value)}</div></details>`
    )
    .join('');

  return `<div class="batch-lab-message-render">${bodyHtml}${statusHtml}${memoryHtml}</div>`;
}

function renderParagraphs(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
    .map((paragraph) => `<p>${renderLines(paragraph)}</p>`)
    .join('');
}

function renderLines(text: string): string {
  return escapeHtml(text).replace(/\r\n|\r|\n/g, '<br>');
}

function requireInlineConfig(config: BatchLabProcessorConfig | undefined): BatchLabProcessorConfig {
  if (config === undefined) {
    throw new BatchLabRepositoryError(
      'BATCH_LAB_PROCESSOR_VALIDATION_ERROR',
      'Batch Lab processor preview config is required'
    );
  }
  return config;
}

function validateProcessorConfig(
  config: BatchLabProcessorConfig
): { valid: true } | { valid: false } {
  try {
    if (config.protocol === 'regex_json_v1') {
      for (const rule of config.rules) {
        validateRegexRule(rule);
      }
    }
    return { valid: true };
  } catch {
    return { valid: false };
  }
}

function validateRegexRule(rule: BatchLabRegexRule): void {
  const flags = rule.flags ?? 'g';
  new RegExp(rule.pattern, flags);
}

function successResult(
  version: Pick<BatchLabProcessorVersion, 'id' | 'digest'>,
  inputText: string,
  outputText: string,
  matchCount: number
): BatchLabDisplayResult {
  return {
    processor_version_id: version.id,
    processor_digest: version.digest,
    status: 'success',
    match_count: matchCount,
    input_text: inputText,
    output_text: outputText,
    sanitized_html: renderSafeHtml(outputText),
    error_code: null,
    renderer: DISPLAY_RENDERER,
  };
}

function failureResult(
  version: Pick<BatchLabProcessorVersion, 'id' | 'digest'>,
  status: Exclude<BatchLabDisplayResult['status'], 'success'>,
  errorCode: BatchLabErrorCode,
  inputText: string
): BatchLabDisplayResult {
  return {
    processor_version_id: version.id,
    processor_digest: version.digest,
    status,
    match_count: 0,
    input_text: inputText,
    output_text: inputText,
    sanitized_html: renderSafeHtml(inputText),
    error_code: errorCode,
    renderer: DISPLAY_RENDERER,
  };
}

async function runRegexWorker(
  inputText: string,
  rules: BatchLabRegexRule[],
  timeoutMs: number
): Promise<
  | { status: 'success'; outputText: string; matchCount: number }
  | { status: 'timeout' }
  | { status: 'runtime_error' }
> {
  const worker = new Worker(regexWorkerSource(), {
    eval: true,
    workerData: { inputText, rules },
  });

  return new Promise((resolve) => {
    let settled = false;
    let runtimeTimer: ReturnType<typeof setTimeout> | undefined;
    const startupTimer = setTimeout(() => finish({ status: 'timeout' }), 2_000);
    const finish = (
      result:
        | { status: 'success'; outputText: string; matchCount: number }
        | { status: 'timeout' }
        | { status: 'runtime_error' }
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      if (runtimeTimer) clearTimeout(runtimeTimer);
      void worker.terminate();
      resolve(result);
    };

    worker.once('online', () => {
      runtimeTimer = setTimeout(() => finish({ status: 'timeout' }), timeoutMs);
    });
    worker.once('message', (message: WorkerPayload) => {
      if (message.ok) {
        finish({
          status: 'success',
          outputText: message.outputText,
          matchCount: message.matchCount,
        });
      } else {
        finish({ status: 'runtime_error' });
      }
    });
    worker.once('error', () => finish({ status: 'runtime_error' }));
    worker.once('exit', (code) => {
      if (code !== 0) finish({ status: 'runtime_error' });
    });
  });
}

function regexWorkerSource(): string {
  return `
    const { parentPort, workerData } = require('node:worker_threads');

    function countMatches(input, regex) {
      const flags = regex.flags.includes('g') ? regex.flags : regex.flags + 'g';
      const counter = new RegExp(regex.source, flags);
      let count = 0;
      let match;
      while ((match = counter.exec(input)) !== null) {
        count += 1;
        if (match[0] === '') counter.lastIndex += 1;
      }
      return count;
    }

    try {
      let output = workerData.inputText;
      let matchCount = 0;
      for (const rule of workerData.rules) {
        const flags = rule.flags || 'g';
        const regex = new RegExp(rule.pattern, flags);
        matchCount += countMatches(output, regex);
        output = output.replace(regex, rule.replacement);
      }
      parentPort.postMessage({ ok: true, outputText: output, matchCount });
    } catch (error) {
      parentPort.postMessage({ ok: false, error: error instanceof Error ? error.message : 'error' });
    }
  `;
}

function digestText(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)])
    );
  }
  return value;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function assertProcessorResultSuccess(result: BatchLabDisplayResult): void {
  if (result.status !== 'success') {
    throw new BatchLabRepositoryError(
      result.error_code ?? 'BATCH_LAB_PROCESSOR_RUNTIME_ERROR',
      'Batch Lab processor execution failed'
    );
  }
}
