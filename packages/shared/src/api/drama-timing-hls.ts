import { z } from 'zod';

/** 起播/快进诊断里 hls.js 加载统计与播放资源缓存的 schema；从 drama-timing.ts 拆出以控制文件长度。 */

export const DRAMA_TIMING_MAX_RESOURCES = 16;

// 与 drama-timing.ts 相同的数值约束。
const Duration = z.number().finite().nonnegative();
const Offset = z.number().finite();

// hls.js 自带的加载统计不受 Timing-Allow-Origin 限制，能拿到首字节和字节数。
export const HlsLoadSchema = z
  .object({
    kind: z.enum(['manifest', 'level', 'audio_track', 'init', 'fragment']),
    track: z.enum(['main', 'audio']).optional(),
    level: z.number().int().min(0).max(64).optional(),
    bitrate: z.number().int().nonnegative().max(1e9).optional(),
    height: z.number().int().min(1).max(32768).optional(),
    sn: z.number().int().nonnegative().optional(),
    positionMs: Duration.optional(),
    mediaMs: Duration.optional(),
    startMs: Offset,
    firstByteMs: Offset.optional(),
    endMs: Offset,
    appendedMs: Offset.optional(),
    bytes: z.number().int().nonnegative().max(1e12).optional(),
    // 快进诊断：该分片的时间范围覆盖快进目标（frag.start ≤ 目标 < frag.start + duration）。
    coversTarget: z.boolean().optional(),
  })
  .strict();

// 前端播放资源缓存的使用情况。source 缺省 = 本次没用上缓存；discarded 是上一份报告以来
// 预取了却没用上就被丢弃的条目，用来估算浪费的流量。只记枚举、耗时和计数，不记 URL。
export const DRAMA_PREFETCH_SOURCES = ['visible_cover', 'press_cover', 'intent', 'recent'] as const;
const PrefetchSchema = z
  .object({
    source: z.enum(DRAMA_PREFETCH_SOURCES).optional(),
    ageMs: Duration.optional(), // 地址签发到本次起播使用的间隔
    playlists: z.number().int().nonnegative().max(8), // 从缓存应答的子清单数
    bytes: z.number().int().nonnegative().max(1e9), // 从缓存应答的子清单字节数
    discardedCount: z.number().int().nonnegative().max(1000),
    discardedBytes: z.number().int().nonnegative().max(1e10),
  })
  .strict();
export type DramaPrefetchSource = (typeof DRAMA_PREFETCH_SOURCES)[number];

export const HlsDiagnosticsSchema = z
  .object({
    entries: z.array(HlsLoadSchema).max(DRAMA_TIMING_MAX_RESOURCES),
    truncated: z.boolean(),
    manifestInline: z.boolean().optional(), // 主清单是否来自内联下发；旧客户端缺省，不推断为 false
    prefetch: PrefetchSchema.optional(), // 旧客户端缺省，不推断为未命中
  })
  .strict();
