import {
  serializeScopedCss,
  validateCompiledArtifact,
  applyTextPostprocess,
  LEGACY_RICH_REPLY_CSS,
} from '@miniapp/shared';

import { isSafeCss } from './css-safety';
import { ruleScopeClass } from './scope-class';
import { originalPostprocess, type WorkerRequest, type WorkerResponse } from './worker-protocol';

/** Worker 入口实际调用的处理函数。主线程不直接跑规则。 */
export function buildWorkerResponse(request: WorkerRequest): WorkerResponse {
  try {
    const result = applyTextPostprocess({
      text: request.content,
      artifact: request.artifact,
      clock: () => Date.now(),
      deadlineAt: request.deadlineAt,
    });
    if (result.status !== 'applied') {
      return {
        type: 'result',
        jobId: request.jobId,
        generation: request.generation,
        result,
        css: '',
      };
    }
    const css = scopedCss(request);
    if (css === null) {
      return {
        type: 'result',
        jobId: request.jobId,
        generation: request.generation,
        result: originalPostprocess(request.content, 'CSS_REJECTED'),
        css: '',
      };
    }
    return { type: 'result', jobId: request.jobId, generation: request.generation, result, css };
  } catch {
    return {
      type: 'result',
      jobId: request.jobId,
      generation: request.generation,
      result: originalPostprocess(request.content, 'WORKER_EXCEPTION'),
      css: '',
    };
  }
}

function scopedCss(request: WorkerRequest): string | null {
  const validated = validateCompiledArtifact(request.artifact);
  if (!validated.ok) return null;
  try {
    const css = validated.artifact.rules
      .filter((rule) => rule.css.length > 0)
      .map((rule) =>
        serializeScopedCss(
          rule.css,
          ruleScopeClass(request.messageKey, richReplyScopeRuleId(rule.id))
        )
      )
      .join('\n');
    const withCompatibility =
      validated.artifact.rich_reply_protocol?.version === 1
        ? `${LEGACY_RICH_REPLY_CSS}\n${css}`
        : css;
    return isSafeCss(withCompatibility) ? withCompatibility : null;
  } catch {
    return null;
  }
}

/** The fixed protocol emits stable internal slot ids while Admin owns the four source rules. */
function richReplyScopeRuleId(ruleId: string): string {
  switch (ruleId) {
    case 'choice':
      return 'rich-reply-choices';
    case 'status':
      return 'rich-reply-status';
    case 'memory':
      return 'rich-reply-memory';
    case 'dialogue':
      return 'rich-reply-dialogue';
    default:
      return ruleId;
  }
}
