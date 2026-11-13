/**
 * 短剧原因问卷回收报告（只读）。
 *
 *   pnpm --filter backend drama-survey:report [-- --out ./drama-survey.csv]
 *
 * 读 miniapp_analytics.drama_survey_responses，打印汇总（回答率、Q1 分布、两组原因占比，按平台拆分），
 * 并把原始答卷导出为 CSV。连接哪个环境由 backend 的 Supabase 环境变量决定。
 */
import '../platform/config.js';
import { writeFile } from 'node:fs/promises';
import { DRAMA_SURVEY_KEY } from '@miniapp/shared';
import { closeSupabaseClient, getDomainDb } from '../lib/supabase.js';
import {
  dramaSurveyCsv,
  summarizeDramaSurvey,
  type DramaSurveyRow,
  type Share,
} from '../features/drama-survey/report.js';

const PAGE = 1000;
const COLUMNS: string =
  'user_id,status,open_reasons,open_other_text,watch_reasons,watch_other_text,comment,platform,engaged_dramas,max_episode,created_at,submitted_at';
const outIndex = process.argv.indexOf('--out');
const outPath =
  (outIndex > 0 ? process.argv[outIndex + 1] : undefined) ??
  `drama-survey-${new Date().toISOString().slice(0, 10)}.csv`;

async function readAll(): Promise<DramaSurveyRow[]> {
  const rows: DramaSurveyRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await getDomainDb('miniapp_analytics')
      .from('drama_survey_responses')
      .select(COLUMNS)
      .eq('survey_key', DRAMA_SURVEY_KEY)
      .order('created_at', { ascending: true })
      .order('user_id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`读取问卷失败：${error.code ?? ''} ${error.message}`);
    // 没有生成的库类型，列表由 COLUMNS 与 migration 对齐。
    rows.push(...((data ?? []) as unknown as DramaSurveyRow[]));
    if (!data || data.length < PAGE) return rows;
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
  await closeSupabaseClient();
}
