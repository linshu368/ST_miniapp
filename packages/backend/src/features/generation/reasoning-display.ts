/**
 * 思考过程要不要显示给用户、算不算「出字」。
 *
 * 默认跟用户的「深度思考」开关一致。畅聊免费模型例外，一律显示：
 * GLM、DeepSeek 这类模型关不掉思考（实测 effort=none 照样先想），开关关着时思考过程既不显示、
 * 也不算出字，正文要 6～9 秒才出来，用户以为卡住了，5 秒一到还会被兜底抢先（2026-11-12 生产
 * 6 小时：GLM 5 / 5.2 被抢先的轮次里，关着开关的占大多数）。能关掉思考的模型（Gemini 3 系列）
 * 开关关着时本来就不吐思考过程，显示规则对它们没有影响。
 * 发给上游的思考强度仍按用户开关（surplusReasoningBody）。
 */
import type { GenerationRequest, ResolvedModel } from './types.js';

export function shouldRevealReasoning(thinkingEnabled: boolean, model: ResolvedModel): boolean {
  return thinkingEnabled || (model.provider === 'surplus' && Boolean(model.freeZone));
}

export function revealsReasoning(
  request: Pick<GenerationRequest, 'thinkingEnabled' | 'revealReasoning'>
): boolean {
  return request.revealReasoning ?? request.thinkingEnabled !== false;
}
