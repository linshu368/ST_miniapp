import { EXIT_CODES, type CliError } from './errors';

/**
 * --json 时 stdout 只输出一段 JSON（成功和失败都是），AI 解析一个流即可；
 * 提示、确认问题等给人看的内容一律写 stderr，不污染 stdout。
 */
export function printSuccess(json: boolean, data: unknown, human?: string): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ ok: true, data }, null, 2)}\n`);
    return;
  }
  const text = human ?? (typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function printError(json: boolean, error: CliError): number {
  const exitCode = EXIT_CODES[error.code];
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: false,
          error: {
            code: error.code,
            message: error.message,
            ...(error.details === undefined ? {} : { details: error.details }),
          },
        },
        null,
        2
      )}\n`
    );
    return exitCode;
  }
  process.stderr.write(`错误 [${error.code}]：${error.message}\n`);
  if (error.details !== undefined) {
    process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
  }
  return exitCode;
}

/** 给人看的进度/提示，--json 时也写 stderr，不影响 stdout 的 JSON。 */
export function note(message: string): void {
  process.stderr.write(`${message}\n`);
}

export function table(rows: Array<Record<string, unknown>>, columns: string[]): string {
  if (rows.length === 0) return '（空）';
  const cell = (value: unknown) =>
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : JSON.stringify(value);
  const widths = columns.map((column) =>
    Math.min(
      60,
      Math.max(displayWidth(column), ...rows.map((row) => displayWidth(cell(row[column]))))
    )
  );
  const render = (values: string[]) =>
    values
      .map((value, index) => pad(truncate(value, widths[index] ?? 0), widths[index] ?? 0))
      .join('  ');
  return [
    render(columns),
    render(widths.map((w) => '-'.repeat(w))),
    ...rows.map((row) => render(columns.map((c) => cell(row[c])))),
  ].join('\n');
}

// 中文字符在终端占两格，按显示宽度对齐。
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) width += /[\u1100-\uffff]/.test(char) ? 2 : 1;
  return width;
}

function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) return text;
  let out = '';
  for (const char of text) {
    if (displayWidth(out + char) > width - 1) break;
    out += char;
  }
  return `${out}…`;
}

function pad(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}
