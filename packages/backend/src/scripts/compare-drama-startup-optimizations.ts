/**
 * 短剧起播优化的分段对比：续播对齐、hls.js 预加载、iOS hls.js、主清单内联。
 * 每项优化只看它直接作用的那一段，并尽量使用同期对照，避免多项同时上线时互相混淆。
 * 只读本地导出，不写任何存储。输入是 Loki 里 drama.startup_diagnostic 的日志导出，
 * 每行一个 JSON：{"ts":"<ISO>","body":<日志正文对象或字符串>}，按 ts 升序排列。
 *
 * LogQL：{service_name="st-miniapp-backend"} |= "drama.startup_diagnostic"
 * 运行：pnpm --filter @miniapp/backend exec tsx src/scripts/compare-drama-startup-optimizations.ts \
 *   --file /abs/export.ndjson --from ISO --to ISO [--exclude-sessions id1,id2]
 * 发布期按 context.release 是否包含下列提交来判断（读取本地 git），不按时间切分：
 * 客户端会缓存旧版本，上线后有一段时间新旧版本混在一起。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { DramaTimingReportSchema, type DramaTimingReport } from '@miniapp/shared';

const MILESTONES = { resume: '54d4c0c4', inline: 'cc7f30c3' } as const;
const FIRST_ATTEMPT_ENTRIES = new Set(['cover', 'switch', 'episode', 'direct']);
// Stream 视频分片固定 4s；续播位置能被它整除（容差 50ms）就视为已对齐。
const STREAM_FRAGMENT_MS = 4000;
const RESUME_MIN_MS = 5000;
const P95_MIN_SAMPLES = 40;

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const file = option('--file');
const from = Date.parse(option('--from') || '');
const to = Date.parse(option('--to') || '');
const excluded = new Set((option('--exclude-sessions') ?? '').split(',').filter(Boolean));
if (
  !file ||
  !Number.isFinite(from) ||
  !Number.isFinite(to) ||
  from >= to ||
  to - from > 14 * 86400000 ||
  statSync(file).size > 64 * 1024 * 1024
)
  throw new Error('invalid_export_arguments_max_14d_64MiB');

const ancestry = new Map<string, boolean | undefined>();
function contains(release: string, commit: string): boolean | undefined {
  const key = `${commit}:${release}`;
  if (!ancestry.has(key)) {
    let value: boolean | undefined;
    try {
      execFileSync('git', ['cat-file', '-e', `${release}^{commit}`], { stdio: 'ignore' });
      try {
        execFileSync('git', ['merge-base', '--is-ancestor', commit, release], { stdio: 'ignore' });
        value = true;
      } catch {
        value = false;
      }
    } catch {
      value = undefined; // 本地 git 没有这个版本：不猜，归入 unknown
    }
    ancestry.set(key, value);
  }
  return ancestry.get(key);
}
function period(release: string): 'baseline' | 'resume' | 'resume+inline' | 'unknown' {
  const resume = contains(release, MILESTONES.resume);
  if (resume === undefined) return 'unknown';
  if (!resume) return 'baseline';
  return contains(release, MILESTONES.inline) ? 'resume+inline' : 'resume';
}

// context 在 schema 里是可选的；没有它就无法归属到会话/版本/平台，单独计数后跳过。
type Report = DramaTimingReport & {
  context: NonNullable<DramaTimingReport['context']>;
  receivedAt: number;
};
const finals = new Map<string, Report>();
const networkHls = new Map<string, NonNullable<NonNullable<Report['diagnostics']>['hls']>>();
let invalid = 0;
let noContext = 0;
let outOfWindow = 0;
const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean);
if (lines.length > 50000) throw new Error('export_exceeds_50000_records');
for (const line of lines) {
  try {
    const outer = JSON.parse(line) as { ts?: string; body?: unknown };
    const body = typeof outer.body === 'string' ? JSON.parse(outer.body) : outer.body;
    const receivedAt = Date.parse(outer.ts ?? '');
    if (!Number.isFinite(receivedAt) || receivedAt < from || receivedAt >= to) {
      outOfWindow++;
      continue;
    }
    const { event, ...rest } = body as { event?: string };
    if (event !== 'drama.startup_diagnostic') continue;
    const report = DramaTimingReportSchema.parse(rest);
    if (report.type !== 'playback') continue;
    if (!report.context) {
      noContext++;
      continue;
    }
    if (excluded.has(report.context.sessionId)) continue;
    // 迟到网络报告带的 hls 记录更完整，覆盖 final 里的同名字段。
    if (report.phase === 'network' && report.diagnostics?.hls)
      networkHls.set(report.id, report.diagnostics.hls);
    if (report.phase === 'final' && !finals.has(report.id))
      finals.set(report.id, { ...report, context: report.context, receivedAt });
  } catch {
    invalid++;
  }
}

// 会话内首次起播：按到达时间排序，统计所有终态（不限结果和分组）。
const firstInSession = new Set<string>();
const sessionsSeen = new Set<string>();
for (const r of [...finals.values()].sort((a, b) => a.receivedAt - b.receivedAt)) {
  if (!sessionsSeen.has(r.context.sessionId)) firstInSession.add(r.id);
  sessionsSeen.add(r.context.sessionId);
}

function derive(r: Report) {
  const m = r.marks;
  const hls = (networkHls.get(r.id) ?? r.diagnostics?.hls)?.entries ?? [];
  const manifest = hls.find((h) => h.kind === 'manifest');
  const fragments = hls.filter((h) => h.kind === 'fragment').sort((a, b) => a.startMs - b.startMs);
  const firstMain = fragments.find((h) => h.track === 'main');
  const loaded = r.media?.events.find((e) => e.name === 'loadeddata');
  const position = loaded?.state?.currentTimeMs ?? 0;
  const resume = position > RESUME_MIN_MS;
  const gap = (a?: number, b?: number) =>
    a !== undefined && b !== undefined ? Math.max(0, b - a) : undefined;
  const canplayAt = m.canplay ?? m.loadeddata;
  return {
    session: r.context.sessionId,
    outcome: r.outcome ?? 'unknown',
    total: r.elapsedMs,
    resume,
    aligned: resume && position % STREAM_FRAGMENT_MS < 50,
    sourceToMetadata: r.stages?.source_to_metadata ?? gap(m.source_set, m.metadata),
    metadataToData: gap(m.metadata, m.loadeddata),
    dataToCanplay: gap(m.loadeddata, canplayAt),
    canplayToFrame:
      canplayAt !== undefined && m.first_frame !== undefined
        ? Math.max(0, m.first_frame - Math.max(canplayAt, m.loadeddata ?? 0))
        : undefined,
    addressWait: r.stages?.address_wait,
    sourceToManifestRequest: manifest ? gap(m.source_set, manifest.startMs) : undefined,
    manifestMs: manifest ? gap(manifest.startMs, manifest.endMs) : undefined,
    manifestInline: (networkHls.get(r.id) ?? r.diagnostics?.hls)?.manifestInline,
    hasHls: hls.length > 0,
    fragmentsBeforeData: hls.length
      ? fragments.filter((h) => h.startMs < (m.loadeddata ?? Infinity)).length
      : undefined,
    // 续播时第一片没覆盖续播位置，说明先白下了一片（典型是 sn0）。
    wastedFirstFragment:
      resume && firstMain?.positionMs !== undefined
        ? firstMain.positionMs + STREAM_FRAGMENT_MS <= position
        : undefined,
    firstFragmentHeight: firstMain?.height,
    firstFragmentBytes: firstMain?.bytes,
    firstFragmentTtfb:
      firstMain?.firstByteMs !== undefined
        ? gap(firstMain.startMs, firstMain.firstByteMs)
        : undefined,
    frameHeight: r.diagnostics?.frame?.height,
  };
}
type Row = ReturnType<typeof derive>;

function quantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const rank = p * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return Math.round(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo));
}
// 样本集中在少数会话里：按会话整体重抽样，置信区间才不会过窄。
function clusterCi(points: { session: string; value: number }[], p: number) {
  const bySession = new Map<string, number[]>();
  for (const { session, value } of points)
    bySession.set(session, [...(bySession.get(session) ?? []), value]);
  const clusters = [...bySession.values()];
  if (clusters.length < 3) return null;
  let seed = 20261110;
  const random = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const estimates: number[] = [];
  for (let i = 0; i < 1000; i++) {
    const sample: number[] = [];
    for (let j = 0; j < clusters.length; j++)
      sample.push(...clusters[Math.floor(random() * clusters.length)]!);
    estimates.push(
      quantile(
        sample.sort((a, b) => a - b),
        p
      )!
    );
  }
  estimates.sort((a, b) => a - b);
  return [quantile(estimates, 0.05), quantile(estimates, 0.95)];
}
function cell(rows: Row[], pick: (row: Row) => number | undefined) {
  const points = rows.flatMap((row) => {
    const value = pick(row);
    return value === undefined ? [] : [{ session: row.session, value }];
  });
  const sorted = points.map((point) => point.value).sort((a, b) => a - b);
  return {
    n: sorted.length,
    sessions: new Set(points.map((point) => point.session)).size,
    p50: quantile(sorted, 0.5),
    p50Ci90: clusterCi(points, 0.5),
    p95: sorted.length >= P95_MIN_SAMPLES ? quantile(sorted, 0.95) : null,
    p95Raw: quantile(sorted, 0.95),
    p95Ci90: sorted.length >= P95_MIN_SAMPLES ? clusterCi(points, 0.95) : null,
    lowSample: sorted.length < P95_MIN_SAMPLES,
  };
}
const share = (rows: Row[], pick: (row: Row) => boolean | undefined) => {
  const known = rows.map(pick).filter((value) => value !== undefined);
  return known.length
    ? { n: known.length, rate: known.filter(Boolean).length / known.length }
    : null;
};
function grouped<K extends string>(
  rows: (Row & Record<K, string>)[],
  keys: K[],
  build: (rows: Row[]) => object
) {
  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    const key = keys.map((k) => row[k]).join('|');
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return Object.fromEntries(
    [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([key, g]) => [key, build(g)])
  );
}

const unknownReleases = new Set<string>();
const all = [...finals.values()].flatMap((r) => {
  const p = period(r.context.release);
  if (p === 'unknown') unknownReleases.add(r.context.release);
  const firstAttempt = FIRST_ATTEMPT_ENTRIES.has(r.entry ?? '') && !r.recovery?.parentId;
  if (p === 'unknown' || !firstAttempt) return [];
  const row = derive(r);
  return [
    {
      ...row,
      resumeKind: row.resume ? 'resume' : 'from0',
      period: p,
      platform: r.context.platform,
      entry: r.entry ?? 'unknown',
      group: r.delivery?.group ?? 'none',
      engine: r.engine ?? 'unrecorded',
      firstInSession: firstInSession.has(r.id) ? 'first' : 'later',
    },
  ];
});
const played = all.filter((row) => row.outcome === 'playing');
const stream = played.filter((row) => row.group === 'stream');

console.log(
  JSON.stringify(
    {
      window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
      coverage: {
        finals: finals.size,
        firstAttempts: all.length,
        successes: played.length,
        invalid,
        noContext,
        outOfWindow,
        excludedSessions: excluded.size,
        unknownReleases: [...unknownReleases],
        note: 'P95 低于 40 个样本时为 null，仅在 p95Raw 中给出。CI 是按会话聚类的 bootstrap 90% 区间。',
      },
      // 整体结果：只用于汇报。Supabase（MP4，native_file）不受这几项优化影响，作为同期环境对照。
      overall: grouped(played, ['group', 'platform', 'entry', 'period', 'engine'], (g) => ({
        total: cell(g, (r) => r.total),
        withinThreeSeconds: share(g, (r) => r.total <= 3000),
      })),
      // ① 续播对齐：处理组是续播，同期对照是从 0 开始播；看两者差距在各期有没有缩小（双重差分）。
      resumeAlignment: grouped(stream, ['platform', 'period', 'resumeKind'], (g) => ({
        total: cell(g, (r) => r.total),
        metadataToData: cell(g, (r) => r.metadataToData),
        dataToCanplay: cell(g, (r) => r.dataToCanplay),
        canplayToFrame: cell(g, (r) => r.canplayToFrame),
        alignedRate: share(g, (r) => (r.resume ? r.aligned : undefined)),
        wastedFirstFragmentRate: share(g, (r) => r.wastedFirstFragment),
        fragmentsBeforeData: cell(g, (r) => r.fragmentsBeforeData),
        firstFragmentHeight: cell(g, (r) => r.firstFragmentHeight),
      })),
      // ① hls.js 预加载：只在会话首播里出现的“设置源→主清单开始请求”空档。
      hlsPreload: grouped(
        stream.filter((r) => r.hasHls),
        ['platform', 'period', 'firstInSession'],
        (g) => ({ sourceToManifestRequest: cell(g, (r) => r.sourceToManifestRequest) })
      ),
      // ② iOS hls.js：按运行时实际引擎分组；旧版本没有引擎字段，记为 unrecorded（当时 iOS 全部走原生）。
      iosEngine: grouped(
        all.filter((r) => r.group === 'stream' && r.platform === 'ios'),
        ['period', 'engine'],
        (g) => {
          const ok = g.filter((r) => r.outcome === 'playing');
          return {
            outcomes: Object.fromEntries(
              [...new Set(g.map((r) => r.outcome))].map((o) => [
                o,
                g.filter((r) => r.outcome === o).length,
              ])
            ),
            total: cell(ok, (r) => r.total),
            sourceToMetadata: cell(ok, (r) => r.sourceToMetadata),
            metadataToData: cell(ok, (r) => r.metadataToData),
            dataToCanplay: cell(ok, (r) => r.dataToCanplay),
            firstFragmentHeight: cell(ok, (r) => r.firstFragmentHeight),
            firstFragmentBytes: cell(ok, (r) => r.firstFragmentBytes),
            firstFragmentTtfb: cell(ok, (r) => r.firstFragmentTtfb),
            firstFrameHeight: cell(ok, (r) => r.frameHeight),
          };
        }
      ),
      // ③ 主清单内联：命中和未命中（缓存未命中或超时）是同期天然对照；absent 是不支持该字段的旧客户端。
      manifestInline: grouped(
        stream
          .filter((r) => r.hasHls)
          .map((r) => ({
            ...r,
            inline: r.manifestInline === undefined ? 'absent' : String(r.manifestInline),
          })),
        ['platform', 'period', 'inline'],
        (g) => ({
          manifestMs: cell(g, (r) => r.manifestMs),
          sourceToMetadata: cell(g, (r) => r.sourceToMetadata),
          addressWait: cell(g, (r) => r.addressWait),
          total: cell(g, (r) => r.total),
        })
      ),
    },
    null,
    2
  )
);
