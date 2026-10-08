import {
  TEXT_POSTPROCESS_POLICY_VERSION,
  TEXT_POSTPROCESS_SCHEMA_VERSION,
  parseTextPostprocessSource,
  type CompiledTextPostprocessArtifact,
  type CompiledTextPostprocessRule,
  type TextPostprocessDiagnostic,
} from '../api/text-postprocess';
import { compileCss } from './compile-css';
import { compileTemplate } from './compile-html';
import { diagnostic } from './diagnostics';
import { inspectPattern } from './pattern';
import { validateCompiledArtifact } from './validate-artifact';

export interface CompileTextPostprocessResult {
  ok: boolean;
  diagnostics: TextPostprocessDiagnostic[];
  artifact: CompiledTextPostprocessArtifact | null;
}

/**
 * 同步纯编译。调用方必须在可终止的 Worker 里执行；这里不读时钟、随机数、网络或环境。
 * 任一条规则失败时不返回半份 artifact，避免把未通过策略的树当成可发布结果。
 */
export function compileTextPostprocessSource(input: unknown): CompileTextPostprocessResult {
  const parsed = parseTextPostprocessSource(input);
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics, artifact: null };
  const diagnostics: TextPostprocessDiagnostic[] = [];
  const rules: CompiledTextPostprocessRule[] = [];
  for (const rule of parsed.source.rules) {
    const pattern = inspectPattern(rule.pattern, rule.flags);
    if (!pattern.ok) {
      diagnostics.push(
        diagnostic({
          code: pattern.code,
          ruleId: rule.id,
          field: 'pattern',
          message:
            pattern.code === 'EMPTY_MATCH'
              ? 'Pattern can match an empty string.'
              : 'Pattern is not a supported regular expression.',
        })
      );
      continue;
    }
    const template = compileTemplate({
      ruleId: rule.id,
      replacement: rule.replacement,
      groups: pattern.groups,
    });
    const css = compileCss({ ruleId: rule.id, css: rule.css });
    diagnostics.push(...template.diagnostics, ...css.diagnostics);
    if (template.diagnostics.length > 0 || css.diagnostics.length > 0) continue;
    rules.push({
      id: rule.id,
      enabled: rule.enabled,
      pattern: rule.pattern,
      flags: rule.flags,
      groups: pattern.groups,
      placement: template.placement,
      tree: template.tree,
      css: css.rules,
    });
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics, artifact: null };
  const artifact = {
    schema_version: TEXT_POSTPROCESS_SCHEMA_VERSION,
    policy_version: TEXT_POSTPROCESS_POLICY_VERSION,
    rules,
  };
  const validated = validateCompiledArtifact(artifact);
  if (!validated.ok) {
    return {
      ok: false,
      diagnostics: [
        diagnostic({
          code: 'INVALID_REPLACEMENT',
          field: 'source',
          message: 'Compiled artifact failed policy revalidation.',
        }),
      ],
      artifact: null,
    };
  }
  return { ok: true, diagnostics: [], artifact: validated.artifact };
}
