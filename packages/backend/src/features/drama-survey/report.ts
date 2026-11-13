/** 问卷回收统计（纯函数，脚本 drama-survey-report.ts 调用）。 */
import {
  DRAMA_SURVEY_OPEN_REASONS,
  DRAMA_SURVEY_OTHER_REASON,
  DRAMA_SURVEY_WATCH_REASONS,
} from '@miniapp/shared';

export interface DramaSurveyRow {
  user_id: string;
  status: 'submitted' | 'dismissed';
  open_reasons: string[] | null;
  open_other_text: string | null;
  watch_reasons: string[] | null;
  watch_other_text: string | null;
  comment: string | null;
  platform: string | null;
  engaged_dramas: number | null;
  max_episode: number | null;
  created_at: string;
  submitted_at: string | null;
}

export interface Share {
  id: string;
  label: string;
  count: number;
  /** 选了这一项的人 / 答题人数（多选，加起来可以超过 1）。 */
  share: number;
}

const OPEN_IDS = [
  ...DRAMA_SURVEY_OPEN_REASONS.map((item) => item.id),
  DRAMA_SURVEY_OTHER_REASON.id,
];
const WATCH_IDS = [
  ...DRAMA_SURVEY_WATCH_REASONS.map((item) => item.id),
  DRAMA_SURVEY_OTHER_REASON.id,
];
const labelOf = new Map<string, string>(
  [...DRAMA_SURVEY_OPEN_REASONS, ...DRAMA_SURVEY_WATCH_REASONS, DRAMA_SURVEY_OTHER_REASON].map(
    (item) => [item.id, item.label]
  )
);

export function platformGroup(platform: string | null): 'ios' | 'android' | 'other' {
  if (platform === 'ios') return 'ios';
  if (platform === 'android' || platform === 'android_x') return 'android';
  return 'other';
}

/** 轻度：只有 1 部有效观看、且停在第 1 集。用来区分"浅尝即走"和"看过几集才走"的人。 */
export function depthGroup(row: Pick<DramaSurveyRow, 'engaged_dramas' | 'max_episode'>) {
  return (row.engaged_dramas ?? 0) <= 1 && (row.max_episode ?? 0) <= 1 ? 'light' : 'deep';
}

function shares(ids: readonly string[], picks: readonly string[], respondents: number): Share[] {
  const counts = new Map<string, number>();
  for (const pick of picks) counts.set(pick, (counts.get(pick) ?? 0) + 1);
  return ids.map((id) => {
    const count = counts.get(id) ?? 0;
    return {
      id,
      label: labelOf.get(id) ?? id,
      count,
      share: respondents ? count / respondents : 0,
    };
  });
}

function summarizeSubmitted(rows: readonly DramaSurveyRow[]) {
  return {
    respondents: rows.length,
    openReasons: shares(
      OPEN_IDS,
      rows.flatMap((row) => row.open_reasons ?? []),
      rows.length
    ),
    watchReasons: shares(
      WATCH_IDS,
      rows.flatMap((row) => row.watch_reasons ?? []),
      rows.length
    ),
  };
}

export function summarizeDramaSurvey(rows: readonly DramaSurveyRow[]) {
  const submitted = rows.filter((row) => row.status === 'submitted');
  const dismissed = rows.filter((row) => row.status === 'dismissed');
  const split = <K extends string>(keys: readonly K[], pick: (row: DramaSurveyRow) => K) =>
    Object.fromEntries(
      keys.map((key) => [key, summarizeSubmitted(submitted.filter((row) => pick(row) === key))])
    ) as Record<K, ReturnType<typeof summarizeSubmitted>>;
  const lightShare = (part: readonly DramaSurveyRow[]) =>
    part.length ? part.filter((row) => depthGroup(row) === 'light').length / part.length : 0;
  return {
    submitted: submitted.length,
    dismissed: dismissed.length,
    /** 只算看到并做了选择的人；弹出后直接退出 App 的没有记录。 */
    responseRate: rows.length ? submitted.length / rows.length : 0,
    /** 叉掉的人是不是更偏轻度用户（样本偏差参考）。 */
    lightShareSubmitted: lightShare(submitted),
    lightShareDismissed: lightShare(dismissed),
    overall: summarizeSubmitted(submitted),
    byPlatform: split(['ios', 'android', 'other'] as const, (row) => platformGroup(row.platform)),
    byDepth: split(['light', 'deep'] as const, depthGroup),
    comments: submitted.filter((row) => row.comment || row.open_other_text || row.watch_other_text)
      .length,
  };
}

const CSV_COLUMNS = [
  'user_id',
  'status',
  'platform',
  'engaged_dramas',
  'max_episode',
  'open_reasons',
  'open_other_text',
  'watch_reasons',
  'watch_other_text',
  'comment',
  'created_at',
  'submitted_at',
] as const;

function csvCell(value: string) {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** 导出原始答卷（含开放回答），用于问卷结束、删表前存档和人工阅读。 */
export function dramaSurveyCsv(rows: readonly DramaSurveyRow[]) {
  const lines = rows.map((row) =>
    CSV_COLUMNS.map((column) => {
      const value = row[column];
      if (Array.isArray(value))
        return csvCell(value.map((id) => labelOf.get(id) ?? id).join(' | '));
      return csvCell(value === null ? '' : String(value));
    }).join(',')
  );
  return [CSV_COLUMNS.join(','), ...lines].join('\n') + '\n';
}
