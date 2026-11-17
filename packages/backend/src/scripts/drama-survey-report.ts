/**
 * 短剧原因问卷回收报告（只读）。
 *
 *   pnpm --filter backend drama-survey:report [-- --out ./drama-survey.csv]
 *
 * 读 miniapp_analytics.drama_survey_responses，打印汇总（回答率、两组原因占比，按平台和观看深度拆分），
 * 并把原始答卷导出为 CSV。连接哪个环境由 backend 的 DATABASE_URL 决定。
 */
import '../platform/config.js';
import { writeFile } from 'node:fs/promises';
import { DRAMA_SURVEY_KEY } from '@miniapp/shared';
import { prisma } from '../lib/db.js';
import {
  dramaSurveyCsv,
  summarizeDramaSurvey,
  type DramaSurveyRow,
  type Share,
} from '../features/drama-survey/report.js';

const PAGE = 1000;
const outIndex = process.argv.indexOf('--out');
const outPath =
  (outIndex > 0 ? process.argv[outIndex + 1] : undefined) ??
  `drama-survey-${new Date().toISOString().slice(0, 10)}.csv`;

// miniapp_analytics 没有暴露给 PostgREST，走直连 SQL；列与 DramaSurveyRow、migration 对齐。
async function readAll(): Promise<DramaSurveyRow[]> {
  const rows: DramaSurveyRow[] = [];
  for (let offset = 0; ; offset += PAGE) {
    const page = await prisma.$queryRaw<DramaSurveyRow[]>`
      SELECT user_id::text, status, open_reasons, open_other_text, watch_reasons, watch_other_text,
        comment, platform, engaged_dramas, max_episode,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS created_at,
        to_char(submitted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS submitted_at
      FROM miniapp_analytics.drama_survey_responses r
      WHERE r.survey_key = ${DRAMA_SURVEY_KEY}
      ORDER BY r.created_at, r.user_id
      LIMIT ${PAGE} OFFSET ${offset}`;
    rows.push(...page);
    if (page.length < PAGE) return rows;
  }
}

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
function printShares(title: string, denominator: number, items: Share[]) {
  console.log(`\n${title}（n=${denominator}）`);
  for (const item of items)
    console.log(
      `  ${item.label.padEnd(28)} ${String(item.count).padStart(5)}  ${percent(item.share)}`
    );
}

try {
  const rows = await readAll();
  const summary = summarizeDramaSurvey(rows);
  console.log(`问卷 ${DRAMA_SURVEY_KEY}`);
  console.log(
    `提交 ${summary.submitted}，叉掉 ${summary.dismissed}，回答率 ${percent(summary.responseRate)}，` +
      `有文字回答 ${summary.comments}`
  );
  console.log(
    `轻度用户（1 部、停在第 1 集）占比：提交 ${percent(summary.lightShareSubmitted)}，` +
      `叉掉 ${percent(summary.lightShareDismissed)}`
  );
  const parts = [
    ['全部', summary.overall],
    ['iOS', summary.byPlatform.ios],
    ['Android', summary.byPlatform.android],
    ['其他平台', summary.byPlatform.other],
    ['轻度用户', summary.byDepth.light],
    ['看过更多的用户', summary.byDepth.deep],
  ] as const;
  for (const [name, part] of parts) {
    if (!part.respondents) continue;
    console.log(`\n==== ${name} ====`);
    printShares('Q2a 平时较少点开的原因', part.respondents, part.openReasons);
    printShares('Q2b 没多看的原因', part.respondents, part.watchReasons);
  }
  await writeFile(outPath, dramaSurveyCsv(rows), 'utf8');
  console.log(`\n原始答卷已导出：${outPath}（${rows.length} 行，含开放回答，注意不要外传）`);
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
