// 生成执行与计费出口（M3a）的统一接缝。后端内部类型，不进 shared。
//
// M3a 把 routes/llm-proxy.ts 里内联的「权威模型解析 → 免费额度预留 → 定档扣费额与余额预检
// → 上游转发与 SSE tap → 终态落库实扣」抽成服务，ST 链路与自研引擎共用同一出口，
// 保证切换前后计费口径不变。M3a 本身是纯重构，行为零变化。

import type { RequestLogger } from '../../lib/logger.js';

/**
 * 生成出口的日志入口。两条链路各自传入：ST 链路传请求内的 requestLogger（带 reqId），
 * 自研链路没有 Fastify 上下文时退化成进程级 createLogger()。
 * 形状与两者兼容，服务层因此不必绑死请求上下文。
 */
export type GenerationLogger = RequestLogger;

/**
 * 已解析的权威模型。解析动作独立成函数而不是留在生成出口内部，
 * 因为自研链路要先拿到 model 才能解析绑定的预设，两处各解析一次会漂移。
 */
export interface ResolvedModel {
  /** 模型目录的 stable id */
  modelId: string;
  /** 实际路由到的上游模型 */
  openRouterModelId: string;
  tier: 'light' | 'standard' | 'premium' | null;
  isFree: boolean;
}

export interface GenerationMessage {
  role: string;
  content: string;
}

export interface GenerationRequest {
  userId: string;
  characterId: string | null;
  model: ResolvedModel;
  messages: GenerationMessage[];
  /** 引擎解析出的采样参数，透传给上游；空对象表示全用上游默认值 */
  sampling: Record<string, number>;
  /** 落 chat_history.user_input 的原始用户输入 */
  userInput: string;
  /** 自研引擎传入；ST 链路传 null，落库为 NULL */
  sessionId?: string | null;
  /**
   * 自研链路在调用上游前已创建的 chat_history 行。
   * 传入时生成出口更新该行的计费与 LLM 元数据；ST 链路不传，仍按原行为新增日志。
   */
  historyId?: string | null;
  stream: boolean;
  /**
   * 是否为 Anthropic Claude 注入 OpenRouter 的 cache_control 断点（system 段 + 历史尾部），
   * 命中缓存可显著降低上游成本。这是相对现状的行为变更，因此 ST 链路必须传 false，
   * 由自研链路单独启用，避免污染 M3a 的「纯重构」判据。
   */
  promptCaching: boolean;
}

export interface GenerationHooks {
  /**
   * 上游返回 2xx、即将开始消费响应体时恰好调用一次。
   *
   * 这是「本次生成不会再以 HTTP 状态码失败」的分界点：它之前的余额预检与上游拒绝都还能
   * 走 402 / 502 + JSON 错误体，之后的失败只能以流内事件表达。自研链路据此决定何时写出
   * SSE 响应头——等到第一个 token 再写会让首字节白等一个上游首 token 的时延。
   */
  onStreamOpen?: () => void;
  onFirstToken?: () => void;
  onDelta?: (text: string) => void;
  onError?: (error: Error) => void;
  onDone?: (result: GenerationResult) => void;
}

/**
 * insufficient_balance 由上游请求发出之前的预检产生，对应 ST 链路现有的 402。
 * 预检失败与上游失败共用同一条返回通道，调用方一处 switch 收口。
 */
export type GenerationStatus =
  | 'success'
  | 'insufficient_balance'
  | 'upstream_error'
  | 'stream_interrupted';

export interface GenerationResult {
  status: GenerationStatus;
  content: string;
  generationId: string | null;
  finishReason: string | null;
  /** 实扣的幂等键。预检未通过、未发生扣费时为 null */
  chargeId: string | null;
  modelId: string | null;
  modelOpenRouterId: string;
  upstreamStatus?: number;
  /** 仅 insufficient_balance 时填充，用于构造 shared 的 InsufficientBalanceErrorResponse */
  balance?: {
    creditsRequired: number;
    creditsAvailable: number;
  };
}

export interface GenerationService {
  execute(request: GenerationRequest, hooks?: GenerationHooks): Promise<GenerationResult>;
}
