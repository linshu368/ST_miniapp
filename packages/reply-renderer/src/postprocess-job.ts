import {
  serializeScopedCss,
  validateCompiledArtifact,
  applyTextPostprocess,
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
        jobId: request.jobId,
        generation: request.generation,
        result,
        css: '',
      };
    }
    const css = scopedCss(request);
    if (css === null) {
      return {
        jobId: request.jobId,
        generation: request.generation,
        result: originalPostprocess(request.content, 'CSS_REJECTED'),
        css: '',
      };
    }
    return { jobId: request.jobId, generation: request.generation, result, css };
  } catch {
    return {
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
      .map((rule) => serializeScopedCss(rule.css, ruleScopeClass(request.messageKey, rule.id)))
      .join('\n');
    return isSafeCss(css) ? css : null;
  } catch {
    return null;
  }
}
