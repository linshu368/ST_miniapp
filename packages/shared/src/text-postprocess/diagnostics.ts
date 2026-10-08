import type { TextPostprocessDiagnostic, TextPostprocessField } from '../api/text-postprocess';

export function diagnostic(input: {
  code: string;
  ruleId?: string | null;
  field: TextPostprocessField;
  message: string;
  location?: TextPostprocessDiagnostic['location'];
}): TextPostprocessDiagnostic {
  return {
    code: input.code,
    rule_id: input.ruleId ?? null,
    field: input.field,
    message: input.message.slice(0, 240),
    location: input.location ?? null,
  };
}

export function lineColumn(
  source: string,
  offset: number
): {
  line: number;
  column: number;
} {
  let line = 1;
  let column = 1;
  const end = Math.max(0, Math.min(offset, source.length));
  for (let index = 0; index < end; index += 1) {
    if (source[index] === '\n') {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}
