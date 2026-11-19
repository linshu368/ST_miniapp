# 设计

## 契约（`packages/shared/src/api/drama-timing-hls.ts`）

在 `DiagnosticsSchema.hls` 里新增三个可选字段，全部 strict：

```ts
const HlsEventSchema = z
  .object({
    atMs: Offset,
    type: z.enum(['frag_loading', 'frag_emergency_aborted', 'level_switching', 'error']),
    track: z.enum(['main', 'audio']).optional(),
    sn: z.number().int().nonnegative().optional(),
    level: z.number().int().min(0).max(64).optional(),
    detail: z
      .string()
      .max(48)
      .regex(/^[A-Za-z]+$/)
      .optional(), // hls.js ErrorDetails 标识符
    fatal: z.boolean().optional(),
  })
  .strict();
// hls: { ..., events?: HlsEvent[] (max 24), eventsTruncated?: boolean,
//        eventCounts?: { fragLoading, emergencyAborted, levelSwitching, error } }  // 计数含已逐条记录的
```

`dramaTimingLogFields` 已经把 `diagnostics` 整段透传，后端不需要改代码；后端部署新的 shared 后就能接收并写进 Loki。

## 前端（`packages/frontend/src/lib/perf/drama-hls.ts`）

新增 `recordHlsEvents`：订阅上面 4 个事件，`atMs` 相对快进开始，`frag.type` 映射为 track，`sn` 只取数字（init 段不记），`level` 只记主轨画质档位；`ERROR` 的 `details` 不符合标识符格式时不记。所有回调走 `guard`，异常时吞掉。

取样：真实 hls.js 1.7.4 每次中止分片都会发一条非致命 `ERROR`（`details=aborted`），中止重发循环每秒约 20 条，只留前 24 条只能覆盖开头约 1 秒。所以保留**最早 12 条 + 最近 12 条**，中间的只累加 `eventCounts` 并置 `eventsTruncated`。这样快进刚开始和放弃前的稳定循环都能看到。

新增 `recordSeekHls`：把 `recordHlsLoads`（加载统计）和 `recordHlsEvents` 合成同一份 hls 诊断，`observeDramaSeek` 原来的订阅代码换成一次调用（该函数在复杂度基线里，不能再变长：315 → 309 行）。没有按最初设想给 `recordHlsLoads` 加开关：它已有 7 个位置参数、约 110 行，再加 4 个订阅会超过 120 行。起播诊断仍只调用 `recordHlsLoads`，不带 events。

## 为什么是这 4 类

卡死时资源计时显示每 100ms 一对请求：一个约 3ms 结束，一个约 100ms 结束，正好对上 stream controller 的 tick 间隔。要区分是「同一分片反复 `FRAG_LOADING`」、「档位反复切换」、「某个 `ERROR`（如 `bufferAppendError`、`fragParsingError`）触发重试」，还是「紧急中止」，这 4 类就够了。状态机内部状态不是公开 API，不记录。

## 复用调研

- `recordHlsLoads`：复用它的订阅、计时、截断和 stop 模型，只加一个开关，不另起记录器。
- `DRAMA_TIMING_MAX_RESOURCES`（16）用于 entries；events 单独上限 24，因为循环事件更密，需要覆盖至少 1–2 秒。
- 后端 `observeDramaStartupDiagnostic` / `telemetry.ts`：通过 schema 校验后整体写入 Loki，不改。

## 可靠性

- 体积：单条事件约 60–130B，24 条最坏约 3.2KB；本地真实 hls.js 实测整段 hls 诊断 1.5–2.2KB。线上快进诊断 7 天最大 11.5KB（939 条，P99 7.2KB），加上后离 32KB 上限仍远。
- 并发、重试、幂等：沿用现有的诊断上报，不新增请求。
- 失败模型：schema 不兼容会导致整条诊断被拒（400）；所以严格按「契约先、前端后」的顺序发布，发布后看 telemetry 4xx。

## 演进与回滚

- PR1（shared）：合并后 Railway 部署；前端行为不变。
- PR2（frontend）：确认 Railway 部署的版本包含 PR1 后再合并。回滚 PR2 即可停止记录；PR1 的可选字段保留无害。
- 定位出根因后另开修复任务；修复上线后可以删除 events 记录，也可以保留作为长期诊断（届时再定）。
