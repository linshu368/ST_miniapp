import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import XLSX from 'xlsx';
import { afterEach, describe, expect, it } from 'vitest';
import {
  auditVideoSeedWorkbooks,
  closeVideoSeedImportResources,
  headVideoSize,
  selectBalancedTopVideoSeedRows,
  selectVideoSeedCanaryRows,
} from './video-seed-import.js';

const directories: string[] = [];
afterEach(async () => {
  await closeVideoSeedImportResources();
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('video seed workbook audit', () => {
  it('refuses remote reads when TLS verification is disabled', async () => {
    const previous = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    try {
      await expect(headVideoSize('https://image.civitai.com/a/video.mp4')).rejects.toThrow(
        'video_seed_tls_verification_disabled'
      );
    } finally {
      if (previous === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previous;
    }
  });

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

describe('balanced video seed selection', () => {
  it('redistributes unused quotas and uses a stable heat tie-break', () => {
    const rows = [
      seedRow('model-a', 'a-2', 10),
      seedRow('model-a', 'a-1', 10),
      seedRow('model-b', 'b-1', 30),
      seedRow('model-b', 'b-2', 20),
      seedRow('model-b', 'b-3', 10),
      seedRow('model-b', 'b-4', 1),
      seedRow('model-c', 'c-1', 40),
      seedRow('model-c', 'c-2', 30),
      seedRow('model-c', 'c-3', 20),
      seedRow('model-c', 'c-4', 10),
    ];

    const selection = selectBalancedTopVideoSeedRows(rows, 8);

    expect(selection.groups.map(({ modelId, quota }) => ({ modelId, quota }))).toEqual([
      { modelId: 'model-a', quota: 2 },
      { modelId: 'model-b', quota: 3 },
      { modelId: 'model-c', quota: 3 },
    ]);
    expect(selection.rows.map((row) => row.sourceVideoId)).toEqual([
      'a-1',
      'b-1',
      'c-1',
      'a-2',
      'b-2',
      'c-2',
      'b-3',
      'c-3',
    ]);
  });

  it('rejects a target larger than the available candidates', () => {
    expect(() => selectBalancedTopVideoSeedRows([seedRow('model-a', 'a-1', 1)], 2)).toThrow(
      'video_seed_selection_insufficient_candidates'
    );
  });

  it('takes a deterministic ten-row canary covering every selected model', () => {
    const rows = Array.from({ length: 18 }, (_, index) =>
      seedRow(`model-${index % 6}`, `id-${index}`, 100 - index)
    );
    const selection = selectBalancedTopVideoSeedRows(rows, 18);

    const canary = selectVideoSeedCanaryRows(selection, 10);

    expect(canary).toEqual(selection.rows.slice(0, 10));
    expect(new Set(canary.map((row) => row.modelId)).size).toBe(6);
  });
});

function seedRow(modelId: string, sourceVideoId: string, sourceHeat: number) {
  return {
    rowNumber: sourceHeat,
    sourceModelName: modelId,
    modelId,
    prompt: 'prompt',
    promptZh: '提示词',
    videoUrl: `https://image.civitai.com/${sourceVideoId}.mp4`,
    sourceVideoId,
    sourceHeat,
    publishedAt: '2026-01-01T00:00:00.000Z',
  };
}

function writeWorkbook(path: string, name: string, rows: unknown[][]): void {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  XLSX.writeFile(workbook, path);
}
