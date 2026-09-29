import type { SupabaseClient } from '@supabase/supabase-js';
import {
  DiscardTextPostprocessDraftRequestSchema,
  PublishTextPostprocessRequestSchema,
  TEXT_POSTPROCESS_LIMITS,
  TEXT_POSTPROCESS_MUTATION_ERROR_CODES,
  TextPostprocessAdminStateSchema,
  TextPostprocessDiagnosticSchema,
  TextPostprocessMutationOutcomeSchema,
  TextPostprocessRequestLookupSchema,
  RollbackTextPostprocessRequestSchema,
  SaveTextPostprocessDraftRequestSchema,
  diagnosticsFromZod,
  type DiscardTextPostprocessDraftRequest,
  type PublishTextPostprocessRequest,
  type RollbackTextPostprocessRequest,
  type SaveTextPostprocessDraftRequest,
  type TextPostprocessAdminState,
  type TextPostprocessDiagnostic,
  type TextPostprocessMutationErrorCode,
  type TextPostprocessMutationOutcome,
  type TextPostprocessRequestLookup,
} from '@miniapp/shared';
import { z } from 'zod';
import type { AdminEnvironment } from './environment';
import { getAdminApiUrl } from './environment';

/** 与设计里的管理端 API 超时一致。写操作超时按结果未知处理，不自动重发。 */
export const TEXT_POSTPROCESS_API_TIMEOUT_MS = 5_000;
export const TEXT_POSTPROCESS_HISTORY_LIMIT = TEXT_POSTPROCESS_LIMITS.maxVersionsPerBatch;

export const TEXT_POSTPROCESS_RESULT_UNKNOWN = 'RESULT_UNKNOWN';
export const TEXT_POSTPROCESS_VALIDATION_UNAVAILABLE = 'VALIDATION_UNAVAILABLE';

const MUTATION_CODES = new Set<string>(TEXT_POSTPROCESS_MUTATION_ERROR_CODES);

export type TextPostprocessClientKind =
  | 'unauthorized'
  | 'forbidden'
  | 'result_unknown'
  | 'validation_unavailable'
  | 'mutation'
  | 'transport'
  | 'bad_response';

export class TextPostprocessClientError extends Error {
  readonly kind: TextPostprocessClientKind;
  readonly code: string;
  readonly diagnostics: TextPostprocessDiagnostic[];
  readonly status: number | null;

  constructor(input: {
    kind: TextPostprocessClientKind;
    code: string;
    message: string;
    diagnostics?: TextPostprocessDiagnostic[];
    status?: number | null;
  }) {
    super(input.message);
    this.name = 'TextPostprocessClientError';
    this.kind = input.kind;
    this.code = input.code;
    this.diagnostics = input.diagnostics ?? [];
    this.status = input.status ?? null;
  }
}

export interface TextPostprocessTransport {
  environment: AdminEnvironment;
  getAccessToken: () => Promise<string | null>;
  /** 测试注入。缺省时使用当前环境的 Admin API 根地址。 */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface TextPostprocessApi {
  readState(query?: { beforeVersion?: number }): Promise<TextPostprocessAdminState>;
  lookup(requestId: string): Promise<TextPostprocessRequestLookup>;
  save(body: SaveTextPostprocessDraftRequest): Promise<TextPostprocessMutationOutcome>;
  publish(body: PublishTextPostprocessRequest): Promise<TextPostprocessMutationOutcome>;
  rollback(body: RollbackTextPostprocessRequest): Promise<TextPostprocessMutationOutcome>;
  discard(body: DiscardTextPostprocessDraftRequest): Promise<TextPostprocessMutationOutcome>;
}

export function createTextPostprocessApi(transport: TextPostprocessTransport): TextPostprocessApi {
  return {
    readState(query = {}) {
      return request({
        transport,
        intent: 'read',
        method: 'GET',
        path: historyPath(query.beforeVersion),
        schema: TextPostprocessAdminStateSchema,
      });
    },
    lookup(requestId) {
      return request({
        transport,
        intent: 'read',
        method: 'GET',
        path: `/api/admin/text-postprocess/requests/${encodeURIComponent(requestId)}`,
        schema: TextPostprocessRequestLookupSchema,
      });
    },
    save(body) {
      return write(
        transport,
        '/api/admin/text-postprocess/draft',
        SaveTextPostprocessDraftRequestSchema,
        body
      );
    },
    publish(body) {
      return write(
        transport,
        '/api/admin/text-postprocess/publish',
        PublishTextPostprocessRequestSchema,
        body
      );
    },
    rollback(body) {
      return write(
        transport,
        '/api/admin/text-postprocess/rollback',
        RollbackTextPostprocessRequestSchema,
        body
      );
    },
    discard(body) {
      return write(
        transport,
        '/api/admin/text-postprocess/discard',
        DiscardTextPostprocessDraftRequestSchema,
        body
      );
    },
  };
}

export async function readAdminAccessToken(client: SupabaseClient): Promise<string | null> {
  const { data } = await client.auth.getSession();
  return data.session?.access_token ?? null;
}

export function textPostprocessApiUrl(
  environment: AdminEnvironment,
  path: string,
  baseUrl?: string
): string {
  const root = (baseUrl ?? getAdminApiUrl(environment)).replace(/\/+$/, '');
  return `${root}${path}`;
}

function historyPath(beforeVersion: number | undefined): string {
  const params = new URLSearchParams();
  params.set('limit', String(TEXT_POSTPROCESS_HISTORY_LIMIT));
  if (beforeVersion !== undefined) {
    if (!Number.isInteger(beforeVersion) || beforeVersion < 1) {
      throw new TextPostprocessClientError({
        kind: 'bad_response',
        code: 'BAD_REQUEST',
        message: '历史游标无效',
      });
    }
    params.set('before_version', String(beforeVersion));
  }
  return `/api/admin/text-postprocess?${params.toString()}`;
}

async function write<T>(
  transport: TextPostprocessTransport,
  path: string,
  schema: z.ZodType<T>,
  body: unknown
): Promise<TextPostprocessMutationOutcome> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new TextPostprocessClientError({
      kind: 'mutation',
      code: 'invalid_draft',
      message: '请求未通过契约校验，没有发送',
      diagnostics: diagnosticsFromZod(parsed.error, body),
    });
  }
  return request({
    transport,
    intent: 'write',
    method: 'POST',
    path,
    schema: TextPostprocessMutationOutcomeSchema,
    body: parsed.data,
  });
}

async function request<T>(input: {
  transport: TextPostprocessTransport;
  intent: 'read' | 'write';
  method: 'GET' | 'POST';
  path: string;
  schema: z.ZodType<T>;
  body?: unknown;
}): Promise<T> {
  const token = await input.transport.getAccessToken();
  if (!token) {
    throw new TextPostprocessClientError({
      kind: 'unauthorized',
      code: 'UNAUTHORIZED',
      message: '登录状态已失效，请重新登录',
    });
  }

  const controller = new AbortController();
  const timeoutMs = input.transport.timeoutMs ?? TEXT_POSTPROCESS_API_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const fetchImpl = input.transport.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(
      textPostprocessApiUrl(input.transport.environment, input.path, input.transport.baseUrl),
      {
        method: input.method,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${token}`,
          ...(input.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        body: input.body === undefined ? undefined : JSON.stringify(input.body),
        signal: controller.signal,
      }
    );
    const payload = await readJson(response);
    if (!response.ok || !isSuccess(payload)) {
      throw classifyFailure(input.intent, response.status, payload);
    }
    const parsed = input.schema.safeParse(payload.data);
    if (!parsed.success) {
      throw unreadable(input.intent, response.status);
    }
    return parsed.data;
  } catch (error) {
    if (error instanceof TextPostprocessClientError) throw error;
    throw transportFailure(input.intent);
  } finally {
    clearTimeout(timer);
  }
}

function isSuccess(payload: unknown): payload is { success: true; data: unknown } {
  return (
    Boolean(payload) &&
    typeof payload === 'object' &&
    (payload as { success?: unknown }).success === true
  );
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function classifyFailure(
  intent: 'read' | 'write',
  status: number,
  payload: unknown
): TextPostprocessClientError {
  const parsed = readFailure(payload);
  const code = parsed?.code ?? '';
  if (code === TEXT_POSTPROCESS_VALIDATION_UNAVAILABLE) {
    return new TextPostprocessClientError({
      kind: 'validation_unavailable',
      code,
      message: '校验服务暂不可用。这不是字段格式错误。',
      diagnostics: parsed?.diagnostics ?? [],
      status,
    });
  }
  if (code === TEXT_POSTPROCESS_RESULT_UNKNOWN) {
    return new TextPostprocessClientError({
      kind: 'result_unknown',
      code,
      message: '结果未知。请查询同一请求，不要用新的请求编号重发。',
      status,
    });
  }
  if (status === 401 || code === 'UNAUTHORIZED') {
    return new TextPostprocessClientError({
      kind: 'unauthorized',
      code: 'UNAUTHORIZED',
      message: '登录状态已失效，请重新登录',
      status,
    });
  }
  if (status === 403 || code === 'forbidden' || code === 'FORBIDDEN') {
    return new TextPostprocessClientError({
      kind: 'forbidden',
      code: 'forbidden',
      message: '当前身份不能执行此操作',
      status,
    });
  }
  if (MUTATION_CODES.has(code)) {
    return new TextPostprocessClientError({
      kind: 'mutation',
      code: code as TextPostprocessMutationErrorCode,
      message: mutationMessage(code as TextPostprocessMutationErrorCode, parsed?.message),
      diagnostics: parsed?.diagnostics ?? [],
      status,
    });
  }
  if (intent === 'write' && (status >= 500 || parsed === null)) {
    return new TextPostprocessClientError({
      kind: 'result_unknown',
      code: TEXT_POSTPROCESS_RESULT_UNKNOWN,
      message: '结果未知。请查询同一请求，不要用新的请求编号重发。',
      status,
    });
  }
  return new TextPostprocessClientError({
    kind: intent === 'write' ? 'bad_response' : 'transport',
    code: code || 'TEXT_POSTPROCESS_FAILED',
    message: intent === 'write' ? '请求被拒绝' : '读取富文本规则失败',
    status,
  });
}

function unreadable(intent: 'read' | 'write', status: number): TextPostprocessClientError {
  if (intent === 'write') {
    return new TextPostprocessClientError({
      kind: 'result_unknown',
      code: TEXT_POSTPROCESS_RESULT_UNKNOWN,
      message: '结果未知。请查询同一请求，不要用新的请求编号重发。',
      status,
    });
  }
  return new TextPostprocessClientError({
    kind: 'bad_response',
    code: 'BAD_RESPONSE',
    message: '响应不符合富文本规则契约',
    status,
  });
}

function transportFailure(intent: 'read' | 'write'): TextPostprocessClientError {
  if (intent === 'write') {
    return new TextPostprocessClientError({
      kind: 'result_unknown',
      code: TEXT_POSTPROCESS_RESULT_UNKNOWN,
      message: '结果未知。请查询同一请求，不要用新的请求编号重发。',
    });
  }
  return new TextPostprocessClientError({
    kind: 'transport',
    code: 'NETWORK',
    message: '读取富文本规则失败',
  });
}

const FailureSchema = z.object({
  success: z.literal(false),
  error: z.object({
    code: z.string().min(1).max(80),
    message: z.string().min(1).max(240),
    diagnostics: z.array(z.unknown()).max(TEXT_POSTPROCESS_LIMITS.maxDiagnostics).optional(),
  }),
});

function readFailure(payload: unknown): {
  code: string;
  message: string;
  diagnostics: TextPostprocessDiagnostic[];
} | null {
  const parsed = FailureSchema.safeParse(payload);
  if (!parsed.success) return null;
  const diagnostics: TextPostprocessDiagnostic[] = [];
  for (const item of parsed.data.error.diagnostics ?? []) {
    const diagnostic = TextPostprocessDiagnosticSchema.safeParse(item);
    if (diagnostic.success) diagnostics.push(diagnostic.data);
  }
  return { code: parsed.data.error.code, message: parsed.data.error.message, diagnostics };
}

function mutationMessage(
  code: TextPostprocessMutationErrorCode,
  fallback: string | undefined
): string {
  switch (code) {
    case 'cas_conflict':
      return '草稿或正式版本已变化。本地编辑已保留。';
    case 'request_id_conflict':
      return '这个请求编号已经用于不同内容。';
    case 'draft_revision_mismatch':
      return '要发布的修订与已保存草稿不一致。';
    case 'compile_rejected':
      return '已保存草稿没有通过编译。';
    case 'invalid_source':
      return '正式规则未通过校验。';
    case 'invalid_draft':
      return '草稿结构无效。';
    case 'target_version_unavailable':
      return '目标版本不可用。';
    case 'policy_unsupported':
      return '该快照的安全策略已不再支持。';
    case 'forbidden':
      return '当前身份不能执行此操作。';
    default:
      return fallback || '富文本规则请求被拒绝';
  }
}
