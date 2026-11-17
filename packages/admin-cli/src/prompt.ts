import { createInterface } from 'node:readline/promises';
import { CliError } from './errors';

/** 只有真人坐在终端前才算交互；AI 或管道调用时 stdin/stderr 不是 TTY。 */
export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stderr.isTTY);
}

/** 问题写到 stderr，stdout 留给命令结果。 */
export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

/** 不回显的输入（密码）。逐字读原始按键，支持退格，Ctrl+C 直接退出。 */
export async function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new CliError('usage', '密码只能在交互终端输入');
  process.stderr.write(question);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = '';
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (char === '\r' || char === '\n') {
            stdin.off('data', onData);
            process.stderr.write('\n');
            resolve(value);
            return;
          }
          if (char === '\u0003') {
            stdin.off('data', onData);
            process.stderr.write('\n');
            reject(new CliError('usage', '已取消'));
            return;
          }
          if (char === '\u007f' || char === '\b') {
            value = value.slice(0, -1);
            continue;
          }
          value += char;
        }
      };
      stdin.on('data', onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}
