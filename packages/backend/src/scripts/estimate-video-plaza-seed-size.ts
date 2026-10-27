import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import {
  headVideoSize,
  readVideoSourceRows,
  workbookSha256,
} from '../features/image-plaza/video-seed-import.js';

const options = parseArgs(process.argv.slice(2));
const rows = readVideoSourceRows(options.input);
const failures: Array<{ row_number: number; source_video_id: string; code: string }> = [];
const byModel: Record<string, { files: number; bytes: number }> = {};
let totalBytes = 0;
let cursor = 0;
const worker = async () => {
  while (cursor < rows.length) {
    const row = rows[cursor++];
    if (!row) return;
    try {
      const bytes = await headVideoSize(row.videoUrl);
      totalBytes += bytes;
      const summary = byModel[row.sourceModelName] ?? { files: 0, bytes: 0 };
      summary.files += 1;
      summary.bytes += bytes;
      byModel[row.sourceModelName] = summary;
    } catch (err) {
      failures.push({
        row_number: row.rowNumber,
        source_video_id: row.sourceVideoId,
        code: err instanceof Error ? err.message.slice(0, 120) : 'head_failed',
      });
    }
  }
};
await Promise.all(Array.from({ length: Math.min(10, rows.length) }, () => worker()));
const report = {
  version: 1,
  generated_at: new Date().toISOString(),
  input_sha256: await workbookSha256(options.input),
  total_rows: rows.length,
  measured_rows: rows.length - failures.length,
  total_bytes: totalBytes,
  by_model: byModel,
  failures,
};
const contents = `${JSON.stringify(report, null, 2)}\n`;
await writeFile(options.report, contents, 'utf8');
const reportHash = createHash('sha256').update(contents).digest('hex');
console.log(
  `video seed size report=${options.report} sha256=${reportHash} total_bytes=${totalBytes} failures=${failures.length}`
);
if (failures.length) process.exitCode = 1;

function parseArgs(args: string[]) {
  let input = '';
  let report = 'video-seed-size-report.json';
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--input') input = args[++index] ?? '';
    else if (args[index] === '--report') report = args[++index] ?? '';
    else throw new Error(`unknown_argument:${args[index] ?? ''}`);
  }
  if (!input) throw new Error('missing_required_argument:--input');
  const path = (value: string) =>
    isAbsolute(value) ? value : resolve(process.env.INIT_CWD || process.cwd(), value);
  return { input: path(input), report: path(report) };
}
