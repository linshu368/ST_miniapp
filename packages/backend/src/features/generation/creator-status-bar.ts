/**
 * 创作者建卡时的状态栏 AI。作者工具：不扣星尘、不兜底（模型不可用就提示稍后再试，作者已有的状态栏不动）。
 * 非流式 JSON；产出过 shared 的结构与语义校验，不合格带着问题清单重试一次，仍不合格就报错。
 */
import { randomUUID } from 'node:crypto';
import {
  StatusBarTemplateDraftSchema,
  checkStatusBarTemplate,
  type CharacterDraft,
  type StatusBarItem,
  type StatusBarTemplate,
} from '@miniapp/shared';
import { MODEL_ID } from './creator-polish-prompts.js';
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
async function callJson(user: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const upstream = resolveProviderUpstream('openrouter', MODEL_ID);
  if (!upstream.apiKey) throw new CreatorStatusBarError('unavailable', 'unconfigured');
  let response: Response;
  try {
    response = await forwardToUpstream({
      ...upstream,
      method: 'POST',
      signal,
      body: JSON.stringify({
        model: MODEL_ID,
        stream: false,
        temperature: 0.7,
        max_tokens: 8_192,
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
  if (typeof content !== 'string' || (isRecord(choice) && choice.finish_reason !== 'stop'))
    throw new CreatorStatusBarError('invalid_output', '模型没有给出完整结果');
  try {
    const parsed: unknown = JSON.parse(content.replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, ''));
    if (!isRecord(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new CreatorStatusBarError('invalid_output', '模型输出的不是合法 JSON');
  }
}

const newId = (prefix: string) => `${prefix}-${randomUUID().slice(0, 8)}`;

/** 模型给的分区/项目补上 id、版本号；保留已有 id（"一句话改"要原样保留没改的项）。 */
function normalizeTemplate(raw: Record<string, unknown>): unknown {
  const sections = Array.isArray(raw.sections) ? raw.sections : [];
  return {
    version: 1,
    note: typeof raw.note === 'string' ? raw.note : '',
    sections: sections.filter(isRecord).map((section) => ({
      id: typeof section.id === 'string' && section.id ? section.id : newId('s'),
      title: typeof section.title === 'string' ? section.title : '',
      repeat: isRecord(section.repeat) ? section.repeat : null,
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

function deadline(callerSignal?: AbortSignal) {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return callerSignal ? AbortSignal.any([callerSignal, timeout]) : timeout;
}

/** 生成或改写整栏：不合格重试一次。 */
async function produceTemplate(prompt: string, signal: AbortSignal): Promise<StatusBarTemplate> {
  let result = templateIssues(await callJson(prompt, signal));
  if (result.template && result.issues.length === 0) return result.template;
  result = templateIssues(await callJson(prompt + retrySuffix(result.issues), signal));
  if (result.template && result.issues.length === 0) return result.template;
  throw new CreatorStatusBarError('invalid_output', result.issues[0] ?? '生成的状态栏不合格');
}

export function generateCreatorStatusBar(
  draft: CharacterDraft,
  callerSignal?: AbortSignal
): Promise<StatusBarTemplate> {
  return produceTemplate(buildGeneratePrompt(draft), deadline(callerSignal));
}

export function editCreatorStatusBar(
  draft: CharacterDraft,
  template: StatusBarTemplate,
  instruction: string,
  callerSignal?: AbortSignal
): Promise<StatusBarTemplate> {
  return produceTemplate(buildEditPrompt(draft, template, instruction), deadline(callerSignal));
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
  const signal = deadline(callerSignal);
  const prompt = buildDescribePrompt(draft, item);
  for (let attempt = 0, issues: string[] = []; attempt < 2; attempt += 1) {
    const raw = await callJson(attempt === 0 ? prompt : prompt + retrySuffix(issues), signal);
    const desc = typeof raw.desc === 'string' ? raw.desc.trim() : '';
    issues = desc ? singleItemIssues(item, desc) : ['没有给出 desc'];
    if (issues.length === 0) return desc;
  }
  throw new CreatorStatusBarError('invalid_output', '这一项的说明没写好，再试一次');
}

/** 只补全说明不合格的项；其余原样返回。 */
export async function completeCreatorStatusBar(
  draft: CharacterDraft,
  template: StatusBarTemplate,
  callerSignal?: AbortSignal
): Promise<StatusBarTemplate> {
  const signal = deadline(callerSignal);
  const pending = () =>
    checkStatusBarTemplate(template)
      .filter((issue) => issue.code.startsWith('DESC_') && issue.itemId)
      .map((issue) => issue.itemId!);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const ids = pending();
    if (ids.length === 0) return template;
    const raw = await callJson(buildCompletePrompt(draft, template, ids), signal);
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
