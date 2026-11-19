/**
 * 创作者建卡时的状态栏 AI。作者工具：不扣星尘、不兜底（模型不可用就提示稍后再试，作者已有的状态栏不动）。
 * 非流式 JSON；产出过 shared 的结构与语义校验。每个请求最多调 3 次模型（不合格带问题清单重来，
 * 输出不完整、模型暂时不可用也重来），3 次都不行才报错。
 */
import { randomUUID } from 'node:crypto';
import {
  STATUS_BAR_LIMITS,
  StatusBarTemplateDraftSchema,
  checkStatusBarTemplate,
  type CharacterDraft,
  type StatusBarItem,
  type StatusBarTemplate,
} from '@miniapp/shared';
/** 状态栏 AI（建卡一键生成、帮写说明、补全说明、一句话改；运营批量默认同款）：Gemini 常拦成人向内容，改用 DeepSeek。 */
export const STATUS_BAR_AI_MODEL = 'deepseek/deepseek-v4.1-flash-1017';
import {
  CREATOR_STATUS_BAR_SYSTEM,
  buildCompletePrompt,
  buildDescribePrompt,
  buildEditPrompt,
  buildGeneratePrompt,
  retrySuffix,
} from './creator-status-bar-prompts.js';
import { forwardToUpstream, resolveProviderUpstream } from './upstream.js';

const TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 262_144;

export class CreatorStatusBarError extends Error {
  constructor(
    readonly code: 'unavailable' | 'invalid_output',
    message: string
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readBody(response: Response, signal: AbortSignal): Promise<string> {
  if (!response.body) throw new CreatorStatusBarError('unavailable', 'empty_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES)
        throw new CreatorStatusBarError('unavailable', 'response_too_large');
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** 调一次模型，返回解析后的 JSON 对象（容忍模型包了代码围栏）。 */
async function callJson(
  user: string,
  signal: AbortSignal,
  model: string = STATUS_BAR_AI_MODEL
): Promise<Record<string, unknown>> {
  const upstream = resolveProviderUpstream('openrouter', model);
  if (!upstream.apiKey) throw new CreatorStatusBarError('unavailable', 'unconfigured');
  let response: Response;
  try {
    response = await forwardToUpstream({
      ...upstream,
      method: 'POST',
      signal,
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0.7,
        max_tokens: 12_000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: CREATOR_STATUS_BAR_SYSTEM },
          { role: 'user', content: user },
        ],
      }),
    });
  } catch {
    throw new CreatorStatusBarError('unavailable', signal.aborted ? 'timeout' : 'transport');
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new CreatorStatusBarError('unavailable', 'http_' + response.status);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(await readBody(response, signal));
  } catch (error) {
    if (error instanceof CreatorStatusBarError) throw error;
    throw new CreatorStatusBarError('unavailable', 'invalid_response');
  }
  const choice: unknown =
    isRecord(payload) && Array.isArray(payload.choices) ? payload.choices[0] : null;
  const content = isRecord(choice) && isRecord(choice.message) ? choice.message.content : null;
  const finish = isRecord(choice) ? choice.finish_reason : null;
  if (typeof content !== 'string' || finish !== 'stop')
    // 带上 finish_reason（length = 写到上限被截断，content_filter = 被模型拦截），方便定位。
    throw new CreatorStatusBarError(
      'invalid_output',
      `模型没有给出完整结果（${typeof finish === 'string' ? finish : '无内容'}）`
    );
  const parsed = parseModelJson(content);
  if (!parsed) throw new CreatorStatusBarError('invalid_output', '模型输出的不是合法 JSON');
  return parsed;
}

/**
 * 容忍模型常见的小毛病：代码围栏、JSON 前后多一句话、字符串里直接换行（清单、列表的开局值常见）。
 * 只做确定性的修补，修不好就返回 null。
 */
function parseModelJson(content: string): Record<string, unknown> | null {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const body = content.slice(start, end + 1);
  for (const candidate of [body, escapeControlCharsInStrings(body)]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      if (isRecord(parsed)) return parsed;
    } catch {
      // 试下一种修补
    }
  }
  return null;
}

function escapeControlCharsInStrings(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString && !escaped && ch === '\n') out += '\\n';
    else if (inString && !escaped && ch === '\r') out += '';
    else if (inString && !escaped && ch === '\t') out += '\\t';
    else out += ch;
    if (escaped) escaped = false;
    else if (ch === '\\') escaped = inString;
    else if (ch === '"') inString = !inString;
  }
  return out;
}

const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

/** 模型偶尔多包一层（{"template": {...}} 之类），拆掉。 */
function unwrapTemplate(raw: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(raw.sections)) return raw;
  for (const key of ['template', 'statusBar', 'status_bar', 'data']) {
    const inner = raw[key];
    if (isRecord(inner) && Array.isArray(inner.sections)) return inner;
  }
  return raw;
}

const clipChars = (value: unknown, max: number) =>
  typeof value === 'string' ? [...value.trim()].slice(0, max).join('') : value;

/** "每个___各一组"：占位说法截到上限、组数夹到范围内，不为这点小事整张作废。 */
function normalizeRepeat(repeat: unknown): unknown {
  if (!isRecord(repeat)) return null;
  const max = Number(repeat.max);
  return {
    ...repeat,
    what: clipChars(repeat.what, STATUS_BAR_LIMITS.repeatWhatChars),
    max: Number.isFinite(max)
      ? Math.min(STATUS_BAR_LIMITS.repeatMax, Math.max(1, Math.trunc(max)))
      : repeat.max,
  };
}

/** 模型给的分区/项目补上 id、版本号；保留已有 id（"一句话改"要原样保留没改的项）。 */
function normalizeTemplate(input: Record<string, unknown>): unknown {
  const raw = unwrapTemplate(input);
  const sections = Array.isArray(raw.sections) ? raw.sections : [];
  return {
    version: 1,
    note: typeof raw.note === 'string' ? raw.note : '',
    sections: sections.filter(isRecord).map((section) => ({
      id: typeof section.id === 'string' && section.id ? section.id : newId('s'),
      title: typeof section.title === 'string' ? section.title : '',
      repeat: normalizeRepeat(section.repeat),
      items: (Array.isArray(section.items) ? section.items : []).filter(isRecord).map((item) => ({
        ...item,
        id: typeof item.id === 'string' && item.id ? item.id : newId('i'),
      })),
    })),
  };
}

function templateIssues(raw: Record<string, unknown>): {
  template: StatusBarTemplate | null;
  issues: string[];
} {
  const parsed = StatusBarTemplateDraftSchema.safeParse(normalizeTemplate(raw));
  if (!parsed.success)
    return {
      template: null,
      issues: parsed.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join('.')}：${issue.message}`),
    };
  return {
    template: parsed.data,
    issues: checkStatusBarTemplate(parsed.data).map((issue) => issue.message),
  };
}

/** 每次调用模型单独计时；作者那边断开（关页面）则整体停止。 */
function attemptSignal(callerSignal: AbortSignal | undefined, timeoutMs = TIMEOUT_MS) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

/** 状态栏 AI 每个请求最多调模型 3 次，3 次都不合格或都失败才报错。 */
export const MAX_ATTEMPTS = 3;

/**
 * 这次失败还要不要再试：不合格、输出不完整、模型暂时不可用（网络、超时、上游报错）都再试；
 * 只有作者已经断开、或服务没配模型密钥时立即停止。
 */
function shouldRetry(error: unknown, callerSignal?: AbortSignal): error is CreatorStatusBarError {
  return (
    error instanceof CreatorStatusBarError &&
    !callerSignal?.aborted &&
    error.message !== 'unconfigured'
  );
}

/**
 * 生成或改写整栏：最多 3 次，每次单独计时。不合格就带着问题清单重来；
 * 输出不完整、不是 JSON、模型暂时不可用也重来（保留上一次的问题清单）。
 */
async function produceTemplate(
  prompt: string,
  callerSignal: AbortSignal | undefined,
  options: { model?: string; timeoutMs?: number } = {}
): Promise<StatusBarTemplate> {
  let issues: string[] = [];
  let lastError = new CreatorStatusBarError('invalid_output', '生成的状态栏不合格');
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let raw: Record<string, unknown>;
    try {
      raw = await callJson(
        issues.length ? prompt + retrySuffix(issues) : prompt,
        attemptSignal(callerSignal, options.timeoutMs),
        options.model
      );
    } catch (error) {
      if (!shouldRetry(error, callerSignal)) throw error;
      lastError = error;
      continue;
    }
    const result = templateIssues(raw);
    if (result.template && result.issues.length === 0) return result.template;
    issues = result.issues;
    lastError = new CreatorStatusBarError(
      'invalid_output',
      result.issues[0] ?? '生成的状态栏不合格'
    );
  }
  throw lastError;
}

/**
 * 生成整栏。运营批量给存量卡生成时会指定模型并放宽每次的时限（长卡资料）；
 * 创作者建卡走默认模型与时限。
 */
export function generateCreatorStatusBar(
  draft: CharacterDraft,
  callerSignal?: AbortSignal,
  options: { model?: string; timeoutMs?: number } = {}
): Promise<StatusBarTemplate> {
  return produceTemplate(buildGeneratePrompt(draft), callerSignal, options);
}

export function editCreatorStatusBar(
  draft: CharacterDraft,
  template: StatusBarTemplate,
  instruction: string,
  callerSignal?: AbortSignal
): Promise<StatusBarTemplate> {
  return produceTemplate(buildEditPrompt(draft, template, instruction), callerSignal);
}

const singleItemIssues = (item: StatusBarItem, desc: string) =>
  checkStatusBarTemplate({
    version: 1,
    note: '',
    sections: [{ id: 's', title: '', repeat: null, items: [{ ...item, desc, init: undefined }] }],
  })
    .filter((issue) => issue.code.startsWith('DESC_'))
    .map((issue) => issue.message);

/** 帮写一项的说明。 */
export async function describeCreatorStatusBarItem(
  draft: CharacterDraft,
  item: StatusBarItem,
  callerSignal?: AbortSignal
): Promise<string> {
  const prompt = buildDescribePrompt(draft, item);
  let issues: string[] = [];
  let lastError = new CreatorStatusBarError('invalid_output', '这一项的说明没写好，再试一次');
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let raw: Record<string, unknown>;
    try {
      raw = await callJson(
        issues.length ? prompt + retrySuffix(issues) : prompt,
        attemptSignal(callerSignal)
      );
    } catch (error) {
      if (!shouldRetry(error, callerSignal)) throw error;
      lastError = error;
      continue;
    }
    const desc = typeof raw.desc === 'string' ? raw.desc.trim() : '';
    issues = desc ? singleItemIssues(item, desc) : ['没有给出 desc'];
    if (issues.length === 0) return desc;
    lastError = new CreatorStatusBarError('invalid_output', '这一项的说明没写好，再试一次');
  }
  throw lastError;
}

/** 只补全说明不合格的项；其余原样返回。 */
export async function completeCreatorStatusBar(
  draft: CharacterDraft,
  template: StatusBarTemplate,
  callerSignal?: AbortSignal
): Promise<StatusBarTemplate> {
  const pending = () =>
    checkStatusBarTemplate(template)
      .filter((issue) => issue.code.startsWith('DESC_') && issue.itemId)
      .map((issue) => issue.itemId!);
  const initialPending = pending().length;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const ids = pending();
    if (ids.length === 0) return template;
    let raw: Record<string, unknown>;
    try {
      raw = await callJson(buildCompletePrompt(draft, template, ids), attemptSignal(callerSignal));
    } catch (error) {
      if (shouldRetry(error, callerSignal) && attempt < MAX_ATTEMPTS - 1) continue;
      // 前几次已补上一部分就先交回；一项都没补上才报错
      if (pending().length < initialPending) return template;
      throw error;
    }
    const descs = isRecord(raw.descs) ? raw.descs : {};
    template = {
      ...template,
      sections: template.sections.map((section) => ({
        ...section,
        items: section.items.map((item) => {
          const desc = descs[item.id];
          return ids.includes(item.id) && typeof desc === 'string' && desc.trim()
            ? { ...item, desc: desc.trim() }
            : item;
        }),
      })),
    };
  }
  return template;
}
