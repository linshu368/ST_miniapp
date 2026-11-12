import {
  getProviderModelDirectory,
  getCachedSurplusModelDirectory,
} from '../../platform/model-provider-directory.js';

export interface SurplusReasoningResolution {
  /** 按「思考开关打开」算出的参数，仅用于记录；实际请求按当轮开关用 surplusReasoningBody 生成 */
  parameters: Record<string, unknown>;
  supportedParameters: string[];
  requestedEnabled: boolean;
  control: 'effort' | 'unavailable';
  reason: 'effort_mapped' | 'unsupported' | 'directory_unavailable';
}

/**
 * 有的上游供应商接口很严，不认识的字段直接 400。实测 2026-11-12：Surplus 把 GLM 5.2 派给 mistral 时，
 * 带 reasoning 返回 400 request_rejected「Extra inputs are not permitted」，去掉就正常。
 * Surplus 的 supported_parameters 按模型给、不分供应商，所以这里按供应商记：
 * 已知的直接不发；其余碰到一次就记 REJECTION_TTL_MS，期间发给它的请求都不带思考参数。
 */
const STRICT_PROVIDERS = new Set(['mistral']);
const REJECTION_TTL_MS = 6 * 60 * 60 * 1000;
const rejectedUntil = new Map<string, number>();

export function surplusReasoningAccepted(provider: string | undefined, now = Date.now()): boolean {
  if (!provider) return true;
  if (STRICT_PROVIDERS.has(provider)) return false;
  const until = rejectedUntil.get(provider);
  return until === undefined || until <= now;
}

/** 400 且错误里点名 reasoning 是多余 / 不认识的字段 */
export function isSurplusReasoningRejection(status: number, text: string): boolean {
  return (
    status === 400 &&
    /reasoning/i.test(text) &&
    /extra_forbidden|not permitted|unrecognized|unknown (?:field|parameter|argument)|not allowed|unsupported/i.test(
      text
    )
  );
}

export function noteSurplusReasoningRejected(provider: string, now = Date.now()): void {
  rejectedUntil.set(provider, now + REJECTION_TTL_MS);
}

/** 读 400 响应的副本（不动原响应），是「不认 reasoning」就记下这家供应商。 */
export async function learnSurplusReasoningRejection(
  response: Response,
  provider: string | undefined
): Promise<void> {
  if (!provider || response.status !== 400) return;
  const text = await response
    .clone()
    .text()
    .catch(() => '');
  if (isSurplusReasoningRejection(response.status, text)) noteSurplusReasoningRejected(provider);
}

export function clearSurplusReasoningRejections(): void {
  rejectedUntil.clear();
}

/**
 * 深度思考开关 → Surplus 的思考强度（官方 Reasoning Controls：按 supported_parameters 选写法，
 * `reasoning` 是 `{ effort }` 对象，`reasoning_effort` 是顶层字符串；没声明的由 Surplus 自动去掉）。
 *
 * 取值来自 2026-11-12 对畅聊在架模型的实测（钉住在用的供应商、带 85% 折扣底线）：
 * - 开 = medium：Gemini 3 Flash Preview / 3.8 Flash 会吐出思考过程（不传时是默默思考，首字 6～30 秒）；
 * - 关 = none：同样两个模型不再思考，首字降到 1.5～4 秒；
 * - DeepSeek V4 Pro、GLM 5 / 5.2 不管怎么传都会思考并返回过程，参数被接受但不起作用；
 * - 所有被测供应商都接受 medium / none，没有报错。`{ enabled: false }` 在部分模型上无效，所以不用它。
 */
export function surplusReasoningBody(
  resolution: SurplusReasoningResolution | undefined,
  enabled: boolean,
  /** 钉住的上游供应商（畅聊只发一家）；接口严格、不认 reasoning 的不发 */
  provider?: string
): Record<string, unknown> {
  if (!resolution || resolution.control === 'unavailable') return {};
  if (!surplusReasoningAccepted(provider)) return {};
  const effort = enabled ? 'medium' : 'none';
  const supported = resolution.supportedParameters;
  // 目录拿不到时也发对象写法：模型不支持的话 Surplus 会自己去掉（响应头 X-SI-Adapted-Params）
  if (supported.length === 0 || supported.includes('reasoning')) return { reasoning: { effort } };
  if (supported.includes('reasoning_effort')) return { reasoning_effort: effort };
  return {};
}

function resolution(
  supportedParameters: string[],
  enabled: boolean,
  reason: SurplusReasoningResolution['reason']
): SurplusReasoningResolution {
  const base: SurplusReasoningResolution = {
    parameters: {},
    supportedParameters,
    requestedEnabled: enabled,
    control: reason === 'unsupported' ? 'unavailable' : 'effort',
    reason,
  };
  return { ...base, parameters: surplusReasoningBody(base, enabled) };
}

/** 读模型目录，判断这个模型声明了哪种思考参数；目录拿不到不影响生成。 */
export async function getSurplusReasoningParameters(
  modelId: string,
  enabled: boolean,
  options: { cachedOnly?: boolean } = {}
): Promise<SurplusReasoningResolution> {
  try {
    const directory = options.cachedOnly
      ? getCachedSurplusModelDirectory()
      : await getProviderModelDirectory('surplus');
    if (!directory) return resolution([], enabled, 'directory_unavailable');
    const supportedParameters =
      directory.models.find((model) => model.id === modelId)?.supported_parameters ?? [];
    const declaresReasoning = supportedParameters.some(
      (name) => name === 'reasoning' || name === 'reasoning_effort'
    );
    return resolution(
      supportedParameters,
      enabled,
      declaresReasoning ? 'effort_mapped' : 'unsupported'
    );
  } catch {
    return resolution([], enabled, 'directory_unavailable');
  }
}
