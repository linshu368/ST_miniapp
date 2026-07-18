import type { AnalyticsRow } from './analyticsApi';

export function stringifyAnalyticsValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function analyticsRowsToCsv(rows: AnalyticsRow[]): string {
  if (rows.length === 0) return '';
  const columns = Array.from(new Set(rows.flatMap((row) => Object.keys(row))));
  const escape = (value: unknown) => {
    const text = stringifyAnalyticsValue(value);
    return `"${text.replace(/"/g, '""')}"`;
  };
  return [
    columns.map(escape).join(','),
    ...rows.map((row) => columns.map((column) => escape(row[column])).join(',')),
  ].join('\r\n');
}

export function downloadAnalyticsCsv(filename: string, rows: AnalyticsRow[]): void {
  const csv = analyticsRowsToCsv(rows);
  if (!csv) return;
  const blob = new Blob([`\uFEFF${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
