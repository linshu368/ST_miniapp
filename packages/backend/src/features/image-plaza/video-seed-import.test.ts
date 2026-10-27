import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';
import { afterEach, describe, expect, it } from 'vitest';
import { auditVideoSeedWorkbooks } from './video-seed-import.js';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('video seed workbook audit', () => {
  it('preserves long prompts, excludes untranslated source rows and reports translation orphans', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'video-seed-test-'));
    directories.push(directory);
    const input = join(directory, 'input.xlsx');
    const translations = join(directory, 'translations.xlsx');
    // Keep the fixture below XLSX's 32,767-character cell limit while exceeding any UI prompt cap.
    const longPrompt = 'frame '.repeat(3_000);
    writeWorkbook(input, 'Data', [
      [
        'Venice 模型',
        '正向提示词',
        'Video URL',
        'Civitai Video ID（内部续爬去重）',
        '热度（Like + Heart）',
        '可能的垫图列表',
      ],
      ['Wan 3.0 Pro', longPrompt, 'https://image.civitai.com/a/one.mp4?x=1', '1', 20, ''],
      ['MiniMax H3 Max', 'second', 'https://image.civitai.com/a/two.mp4', '2', 10, ''],
    ]);
    writeWorkbook(translations, 'Sheet1', [
      ['type', 'id', 'model', 'heat', 'prompt_en', 'prompt_zh'],
      [
        'video',
        'a/one.mp4',
        'Wan 3.0 Pro',
        20,
        longPrompt.replaceAll(' ', '  '),
        '很长的视频提示词',
      ],
      ['video', 'orphan.mp4', 'Wan 3.0 Pro', 1, 'orphan', '孤儿'],
    ]);
    const audit = auditVideoSeedWorkbooks(input, translations);
    expect(audit).toMatchObject({
      total: 2,
      eligible: 1,
      excluded: 1,
      needsRepair: 0,
      translationOrphans: 1,
    });
    expect(audit.rows[0]?.prompt.length).toBe(longPrompt.trim().length);
    expect(audit.rows[0]?.promptZh).toBe('很长的视频提示词');
  });

  it('quarantines a translation whose reviewed metadata no longer matches', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'video-seed-test-'));
    directories.push(directory);
    const input = join(directory, 'input.xlsx');
    const translations = join(directory, 'translations.xlsx');
    writeWorkbook(input, 'Data', [
      [
        'Venice 模型',
        '正向提示词',
        'Video URL',
        'Civitai Video ID（内部续爬去重）',
        '热度（Like + Heart）',
        '可能的垫图列表',
      ],
      ['Wan 3.0 Pro', 'prompt', 'https://image.civitai.com/a/one.mp4', '1', 20, ''],
    ]);
    writeWorkbook(translations, 'Sheet1', [
      ['type', 'id', 'model', 'heat', 'prompt_en', 'prompt_zh'],
      ['video', 'a/one.mp4', 'Wan 3.0 Pro', 21, 'prompt', '提示词'],
    ]);
    expect(auditVideoSeedWorkbooks(input, translations)).toMatchObject({
      eligible: 0,
      needsRepair: 1,
    });
  });
});

function writeWorkbook(path: string, name: string, rows: unknown[][]): void {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  XLSX.writeFile(workbook, path);
}
