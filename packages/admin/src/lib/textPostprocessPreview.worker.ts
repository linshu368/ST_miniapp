/// <reference path="../../../../packages/shared/src/text-postprocess/css-tree-entries.d.ts" />
import {
  applyTextPostprocess,
  TEXT_POSTPROCESS_LIMITS,
  type TextPostprocessDiagnostic,
} from '@miniapp/shared';
import { compileTextPostprocessSource } from '@miniapp/shared/src/text-postprocess/compile';

interface PreviewWorkerRequest {
  jobId: number;
  generation: number;
  source: unknown;
  sample: string;
}

interface PreviewRuleStat {
  ruleId: string;
  count: number;
  firstMatch: string | null;
  firstCaptures: Array<{ index: number; name: string | null; text: string }>;
}

interface PreviewWorkerResponse {
  jobId: number;
  generation: number;
  compileMs: number;
  diagnostics: TextPostprocessDiagnostic[];
  artifact: unknown;
  apply: {
    status: 'applied' | 'original';
    reason: string | null;
    matches: number;
    elapsedMs: number;
    rules: PreviewRuleStat[];
    skipped: Array<{ ruleId: string; code: string }>;
  } | null;
  failure: 'WORKER_EXCEPTION' | null;
}

const CLIP = 180;

/**
 * 编译和用户正则只在这个 Worker 里运行。
 * 编译器不在 shared 根出口，避免 MiniApp 主包带上 parse5/css-tree；这里按源码子路径加载，和 Backend 校验 Worker 用的是同一个 compile.ts。
 */
const scope = self as unknown as {
  onmessage: (event: MessageEvent<PreviewWorkerRequest>) => void;
  postMessage: (message: PreviewWorkerResponse) => void;
};

scope.onmessage = (event) => {
  const message = event.data;
  if (!message || typeof message.jobId !== 'number' || typeof message.generation !== 'number')
    return;
  const started = Date.now();
  try {
    const compiled = compileTextPostprocessSource(message.source);
    const compileMs = Date.now() - started;
    if (!compiled.ok || !compiled.artifact) {
      scope.postMessage({
        jobId: message.jobId,
        generation: message.generation,
        compileMs,
        diagnostics: compiled.diagnostics,
        artifact: null,
        apply: null,
        failure: null,
      });
      return;
    }
    const sample = typeof message.sample === 'string' ? message.sample : '';
    const applyStarted = Date.now();
    const applied = applyTextPostprocess({
      text: sample,
      artifact: compiled.artifact,
      clock: () => Date.now(),
      deadlineAt: applyStarted + TEXT_POSTPROCESS_LIMITS.messageBudgetMs,
    });
    const rules = new Map<string, PreviewRuleStat>();
    for (const rule of compiled.artifact.rules) {
      rules.set(rule.id, { ruleId: rule.id, count: 0, firstMatch: null, firstCaptures: [] });
    }
    scope.postMessage({
      jobId: message.jobId,
      generation: message.generation,
      compileMs,
      diagnostics: compiled.diagnostics,
      artifact: compiled.artifact,
      apply: summarize(applied, Date.now() - applyStarted, rules),
      failure: null,
    });
  } catch {
    scope.postMessage({
      jobId: message.jobId,
      generation: message.generation,
      compileMs: Date.now() - started,
      diagnostics: [],
      artifact: null,
      apply: null,
      failure: 'WORKER_EXCEPTION',
    });
  }
};

function summarize(
  result: ReturnType<typeof applyTextPostprocess>,
  elapsedMs: number,
  rules: Map<string, PreviewRuleStat>
): NonNullable<PreviewWorkerResponse['apply']> {
  if (result.status !== 'applied') {
    return {
      status: 'original',
      reason: result.reason,
      matches: 0,
      elapsedMs,
      rules: [...rules.values()],
      skipped: [],
    };
  }
  for (const segment of result.segments) {
    if (segment.type !== 'slot') continue;
    const current = rules.get(segment.rule_id) ?? {
      ruleId: segment.rule_id,
      count: 0,
      firstMatch: null,
      firstCaptures: [],
    };
    current.count += 1;
    if (current.firstMatch === null) {
      current.firstMatch = clip(segment.match_text);
      current.firstCaptures = segment.captures.slice(0, 32).map((capture) => ({
        index: capture.index,
        name: capture.name,
        text: clip(capture.text),
      }));
    }
    rules.set(segment.rule_id, current);
  }
  return {
    status: 'applied',
    reason: null,
    matches: result.stats.matches,
    elapsedMs,
    rules: [...rules.values()],
    skipped: result.skipped_rules.map((item) => ({ ruleId: item.rule_id, code: item.code })),
  };
}

function clip(value: string): string {
  return value.length > CLIP ? value.slice(0, CLIP) : value;
}
