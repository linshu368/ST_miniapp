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
  enabled: boolean
): Record<string, unknown> {
  if (!resolution || resolution.control === 'unavailable') return {};
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
