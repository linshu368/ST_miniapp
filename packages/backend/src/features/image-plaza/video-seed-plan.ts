import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  auditVideoSeedWorkbooks,
  selectBalancedTopVideoSeedRows,
  type VideoSeedAudit,
  type VideoSeedSourceRow,
  workbookSha256,
} from './video-seed-import.js';

export interface ReviewedVideoSeedPlan {
  audit: VideoSeedAudit;
  rows: VideoSeedSourceRow[];
  inputSha256: string;
  translationsSha256: string;
  reportSha256: string;
}

export async function loadReviewedVideoSeedPlan(input: {
  workbookPath: string;
  translationsPath: string;
  reportPath: string;
  expectedReportSha256: string;
}): Promise<ReviewedVideoSeedPlan> {
  const audit = auditVideoSeedWorkbooks(input.workbookPath, input.translationsPath);
  assertVideoSeedAuditBaseline(audit);
  const [inputSha256, translationsSha256, reportBytes] = await Promise.all([
    workbookSha256(input.workbookPath),
    workbookSha256(input.translationsPath),
    readFile(input.reportPath),
  ]);
  const reportSha256 = createHash('sha256').update(reportBytes).digest('hex');
  if (reportSha256 !== input.expectedReportSha256.toLowerCase()) {
    throw new Error('video_seed_size_report_hash_mismatch');
  }
  const report = parseVideoSeedSelectionReport(reportBytes.toString('utf8'));
  if (report.inputSha256 !== inputSha256 || report.translationsSha256 !== translationsSha256) {
    throw new Error('video_seed_size_report_workbook_mismatch');
  }
  const failedRows = new Set(report.failedRowNumbers);
  const expected = selectBalancedTopVideoSeedRows(
    audit.rows.filter((row) => !failedRows.has(row.rowNumber)),
    4_000
  ).rows.map((row) => row.sourceVideoId);
  if (
    expected.length !== report.selectedIds.length ||
    expected.some((id, index) => id !== report.selectedIds[index])
  ) {
    throw new Error('video_seed_size_report_selection_mismatch');
  }
  const rowsById = new Map(audit.rows.map((row) => [row.sourceVideoId, row] as const));
  const rows = report.selectedIds.map((id) => {
    const row = rowsById.get(id);
    if (!row) throw new Error('video_seed_size_report_selection_unknown');
    return row;
  });
  return { audit, rows, inputSha256, translationsSha256, reportSha256 };
}

export function parseVideoSeedSelectionReport(contents: string): {
  inputSha256: string;
  translationsSha256: string;
  selectedIds: string[];
  failedRowNumbers: number[];
} {
  const value: unknown = JSON.parse(contents);
  if (!value || typeof value !== 'object') throw new Error('video_seed_size_report_invalid');
  const report = value as Record<string, unknown>;
  if (report.version !== 2 || report.target_rows !== 4_000 || report.selected_rows !== 4_000) {
    throw new Error('video_seed_size_report_invalid');
  }
  if (typeof report.input_sha256 !== 'string' || typeof report.translations_sha256 !== 'string') {
    throw new Error('video_seed_size_report_invalid');
  }
  if (!Array.isArray(report.selected) || !Array.isArray(report.failures)) {
    throw new Error('video_seed_size_report_invalid');
  }
  const selectedIds = report.selected.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('video_seed_size_report_invalid');
    const id = (item as Record<string, unknown>).source_video_id;
    if (typeof id !== 'string' || !id) throw new Error('video_seed_size_report_invalid');
    return id;
  });
  const failedRowNumbers = report.failures.map((item) => {
    if (!item || typeof item !== 'object') throw new Error('video_seed_size_report_invalid');
    const rowNumber = (item as Record<string, unknown>).row_number;
    if (!Number.isSafeInteger(rowNumber)) throw new Error('video_seed_size_report_invalid');
    return rowNumber as number;
  });
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new Error('video_seed_size_report_invalid');
  }
  return {
    inputSha256: report.input_sha256,
    translationsSha256: report.translations_sha256,
    selectedIds,
    failedRowNumbers,
  };
}

export function assertVideoSeedAuditBaseline(audit: VideoSeedAudit): void {
  if (
    audit.total !== 5_097 ||
    audit.eligible !== 5_082 ||
    audit.excluded < 15 ||
    audit.needsRepair ||
    audit.invalid ||
    audit.duplicateIds ||
    audit.translationOrphans
  ) {
    throw new Error('video_seed_audit_baseline_mismatch');
  }
}
