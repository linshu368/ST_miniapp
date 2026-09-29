import type { TextPostprocessApplyResult } from '@miniapp/shared';

export interface WorkerRequest {
  jobId: number;
  generation: number;
  content: string;
  artifact: unknown;
  messageKey: string;
  deadlineAt: number;
}

export interface WorkerResponse {
  jobId: number;
  generation: number;
  result: TextPostprocessApplyResult;
  css: string;
}

export interface WorkerOutcome {
  result: TextPostprocessApplyResult;
  css: string;
}

export function originalPostprocess(content: string, reason: string): TextPostprocessApplyResult {
  return {
    status: 'original',
    reason,
    segments: [{ type: 'text', text: content, start: 0, end: content.length }],
  };
}

export function originalOutcome(content: string, reason: string): WorkerOutcome {
  return { result: originalPostprocess(content, reason), css: '' };
}
