import {
  CompiledTextPostprocessArtifactSchema,
  TEXT_POSTPROCESS_POLICY_VERSION,
  TEXT_POSTPROCESS_SCHEMA_VERSION,
  type CompiledTextPostprocessArtifact,
} from '../api/text-postprocess';
import { checkCssRule } from './css-model';
import { inspectPattern } from './pattern';
import { inspectTemplateTree } from './template-model';

export type ArtifactValidation =
  | { ok: true; artifact: CompiledTextPostprocessArtifact }
  | { ok: false; reason: 'UNKNOWN_SCHEMA' | 'UNKNOWN_POLICY' | 'INVALID_ARTIFACT' };

/**
 * 运行时再校验可信树和结构化 CSS，不重新解析运营 HTML/CSS 字符串。
 * 未知 schema/policy 与非法树分开，调用方据此整段回退原文。
 */
export function validateCompiledArtifact(input: unknown): ArtifactValidation {
  if (input && typeof input === 'object') {
    if ('schema_version' in input && input.schema_version !== TEXT_POSTPROCESS_SCHEMA_VERSION) {
      return { ok: false, reason: 'UNKNOWN_SCHEMA' };
    }
    if ('policy_version' in input && input.policy_version !== TEXT_POSTPROCESS_POLICY_VERSION) {
      return { ok: false, reason: 'UNKNOWN_POLICY' };
    }
  }
  const parsed = CompiledTextPostprocessArtifactSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: 'INVALID_ARTIFACT' };
  const ids = new Set<string>();
  for (const rule of parsed.data.rules) {
    if (ids.has(rule.id) || !flagsAreSafe(rule.flags))
      return { ok: false, reason: 'INVALID_ARTIFACT' };
    ids.add(rule.id);
    const inspected = inspectPattern(rule.pattern, rule.flags);
    if (!inspected.ok) return { ok: false, reason: 'INVALID_ARTIFACT' };
    if (
      inspected.groups.count !== rule.groups.count ||
      inspected.groups.names.length !== rule.groups.names.length ||
      inspected.groups.names.some((name, index) => name !== rule.groups.names[index]) ||
      inspected.groups.name_by_index.length !== rule.groups.name_by_index.length ||
      inspected.groups.name_by_index.some(
        (name, index) => name !== rule.groups.name_by_index[index]
      )
    ) {
      return { ok: false, reason: 'INVALID_ARTIFACT' };
    }
    if (inspectTemplateTree(rule.tree, rule.groups))
      return { ok: false, reason: 'INVALID_ARTIFACT' };
    if (rule.css.some((cssRule) => !checkCssRule(cssRule)))
      return { ok: false, reason: 'INVALID_ARTIFACT' };
  }
  return { ok: true, artifact: parsed.data };
}

function flagsAreSafe(flags: string): boolean {
  if (!/^[gimsu]*$/.test(flags)) return false;
  return new Set(flags).size === flags.length;
}
