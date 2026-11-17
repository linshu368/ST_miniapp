# 执行计划：iOS 短剧 hls.js 低档起播 + 引擎诊断

前置：合入顺序 1→2→3，本任务是第 2 批。开始实现前先确认第 1 批（续播对齐/startPosition/预加载调用位置）是否已合入 `main`；若已合入，先 `git fetch` + rebase 到 `main`，再继续。若尚未合入，按当前 `origin/main`（b9923f3c）继续开发，合并前再 rebase 一次。

## 阶段 A：Shared schema（必须最先做，决定后续能不能跨层联调）

1. `packages/shared/src/api/drama-timing.ts`：新增 `DramaPlaybackEngineSchema`（`z.enum(['hlsjs_mse','hlsjs_mms','native_hls','native_file'])`）和导出类型 `DramaPlaybackEngine`；`DramaTimingReportSchema` 顶层新增 `engine: DramaPlaybackEngineSchema.optional()`；`dramaTimingLogFields()` 补 `engine: report.engine,`。
   - 验证：`pnpm --filter @miniapp/shared typecheck && pnpm --filter @miniapp/shared test`
2. 运行所有消费者 typecheck（跨包契约改动的强制要求）：`pnpm --filter @miniapp/frontend typecheck && pnpm --filter @miniapp/backend typecheck`。

**回滚点**：如果 schema 改动导致消费者 typecheck 大面积失败且短时间内看不出原因，回退到阶段 A 之前，重新评估字段放置位置（design.md §4），不要带着红的 typecheck 继续往下堆代码。

## 阶段 B：前端引擎路由（`packages/frontend/src/lib/drama-media-source.ts`）

3. 新增 `hasManagedMediaSource()`、`shouldUseHlsOnApple()`（design.md §2.2）。
4. 改 `capAppleHlsQuality`：加 `shouldUseHlsOnApple()` 跳过条件（design.md §2.3）。
5. 改 `loadDramaSource`：
   - 分支条件从 `native && isAppleWebKit()` 改为 `native && isAppleWebKit() && !shouldUseHlsOnApple()`。
   - 新增 `onEngine?: (engine: DramaPlaybackEngine) => void` 参数；两个同步分支（`native_file`/`native_hls`）各调用一次；`MEDIA_ATTACHED` 监听里新增异步判断（`hlsjs_mse`/`hlsjs_mms`，design.md §3）。
   - 保持现有 `onHls?.(hls, Hls.Events)` 的调用时机（在 `attachMedia` 之前），不改变其他分支的时序。
6. 改 `preloadDramaHls`：早退条件从 `isAppleWebKit()` 改为 `isAppleWebKit() && !shouldUseHlsOnApple()`。
7. 更新 `drama-media-source.test.ts`：
   - 新增 `vi.stubGlobal('ManagedMediaSource', class {})` 的 mock 场景。
   - 新增用例：开关打开 + iPhone UA + 有 `ManagedMediaSource` → 走 hls.js 分支（断言 `state.created` 被调用，而不是直接设置 `video.src`）。
   - 新增用例：开关打开但无 `ManagedMediaSource` → 仍走原生（现有「keeps native HLS on iPhone」用例在开关打开但未 stub `ManagedMediaSource` 时应保持通过，确认一下这条本身就覆盖了「无 MMS 回退」）。
   - 新增用例：`capAppleHlsQuality` 在 `shouldUseHlsOnApple()` 为真时不追加 `clientBandwidthHint`。
   - 新增用例：`MEDIA_ATTACHED` 事件数据带 `mediaSource` 实例时，`onEngine` 回调收到对应的 `hlsjs_mse`/`hlsjs_mms`。
   - 验证：`pnpm --filter @miniapp/frontend test -- drama-media-source`

**回滚点**：如果 `shouldUseHlsOnApple()` 的能力检测和现有 `isAppleWebKit()` 的 UA 判断在某些真实 UA 下冲突（例如误判 Android WebView），先回到阶段 B 开头重新核对判断条件，不要在后续阶段打补丁掩盖。

## 阶段 C：前端诊断接线

8. `packages/frontend/src/lib/perf/drama-timing.ts`：`DramaPlaybackTiming` 新增可写字段 `engine?: DramaPlaybackEngine`；`report()` 方法里把 `engine: this.engine` 带进 emit 的报告；`DramaTimingTracker.beginSeek` 新增一个可选参数 `engine?: DramaPlaybackEngine`，透传给 `observeDramaSeek`。
9. `packages/frontend/src/lib/perf/drama-seek.ts`：`observeDramaSeek` 的 `options` 新增 `engine?: DramaPlaybackEngine`；`buildReport` 里带上 `engine: options.engine`。
10. `packages/frontend/src/components/drama/drama-player.tsx`：按 design.md §3.1 接线——新增 `engineRef`，`loadDramaSource` 调用追加 `onEngine` 回调（写 `engineRef.current` 和 `timing.engine`），`beginSeek` 调用追加 `engineRef.current` 参数。
11. `packages/frontend/src/lib/perf/drama-observer.ts`：`mirrorEngineeringTiming` 的 `attributes` 和 `mirrorSeekTiming` 的 `attrs` 都加一行 `drama_engine: report.engine ?? 'unknown'`。
12. `packages/frontend/src/lib/perf/grafana.ts`：`ENUMS` 新增 `drama_engine: ['hlsjs_mse', 'hlsjs_mms', 'native_hls', 'native_file', 'unknown']`（复用现有 `safeAttributes` 的通用分支，不需要新增特判代码）。
13. 更新测试：`drama-timing.test.ts`（`engine` 字段落进报告）、`drama-seek-diagnostics.test.ts`（`beginSeek` 传入 `engine` 后报告里带上）、`drama-observer.test.ts`（`drama_engine` 维度出现在 attrs 里）、`grafana.test.ts`（新枚举值通过白名单、非法值落 `other`）。
    - 验证：`pnpm --filter @miniapp/frontend test -- drama-timing drama-seek-diagnostics drama-observer grafana`

**回滚点**：如果接线到 `drama-player.tsx` 时发现影响范围比预期大（比如必须改动第 1/3 批正在改的代码行），停下来，不要绕开冲突硬改，向用户说明冲突点，等第 1 批合入后 rebase 再继续，或者改变接线方式。

## 阶段 D：后端诊断

14. `packages/backend/src/lib/engineering-observability.ts`：`observeDramaStartupDiagnostic` 的 `attrs` 里新增 `engine: parsed.data.engine ?? 'unknown'`（JSON body 已经随 schema 自动带上 `engine`，这里只是额外加一个顶层标签方便不解析 JSON 也能按 `engine` 过滤）。
15. 更新 `engineering-observability.test.ts`：新增用例验证带 `engine` 字段的报告能通过 `safeParse` 并出现在 `attrs`/JSON body 里；`telemetry.test.ts` 补一条「旧报告（无 `engine`）仍能通过 schema」的回归，锁定兼容方向。
    - 验证：`pnpm --filter @miniapp/backend test -- engineering-observability telemetry`

## 阶段 E：开关与文档

16. README 环境变量一节补充 `NEXT_PUBLIC_DRAMA_IOS_HLSJS` 说明（design.md §5）。
17. 不在本任务执行 Vercel 环境变量的实际配置——只在 PR 描述/收尾汇总里写清楚配置步骤，等用户确认。

## 阶段 F：收尾验证（覆盖失败路径，不只是 happy path）

18. 全量运行：
    ```bash
    pnpm --filter @miniapp/shared typecheck
    pnpm --filter @miniapp/shared test
    pnpm --filter @miniapp/frontend typecheck
    pnpm --filter @miniapp/frontend test
    pnpm --filter @miniapp/frontend lint
    pnpm --filter @miniapp/backend typecheck
    pnpm --filter @miniapp/backend test
    pnpm -r typecheck
    ```
19. 人工场景检查清单（失败路径，不只 happy path）：
    - 开关关闭：确认 `capAppleHlsQuality`/`loadDramaSource`/`preloadDramaHls` 三处都落回现状行为（阶段 B 的测试已覆盖，这里是跑一遍确认没有遗漏分支）。
    - 开关打开但 `Hls.isSupported()` 返回 `false`（极端旧 WebView）：确认仍然走现有「`native` 为真则回退原生，否则 `failed()`」逻辑，不受本次改动影响。
    - 开关打开但诊断上报失败（网络失败/限流 429）：确认不影响播放本身（现有 `try/catch` 包裹遥测路径）。
    - 快进时 `hlsHandleRef.current` 为 `null`（例如原生路径快进）：确认 `engineRef.current` 为 `undefined` 时 `beginSeek` 正常工作，不因为多传一个 `undefined` 参数报错。
20. 真机验证清单见 `design.md §7`——由用户/团队在 iPhone Telegram 里测试，本任务只保证代码路径可测、诊断字段可查。
21. 复杂度预算：改动的文件里 `drama-media-source.ts`（103 行）、`drama-timing.ts`（652 行，其中 `DramaTimingTracker` 类已经不小）需要确认改完后没有超过单文件 500 行/单函数 120 行；如果 `drama-timing.ts` 因为新增字段接近或超过预算，不要在这个任务里顺带拆分（超出主路径范围），先记录到收尾汇总的「暂缓事项」，由用户决定是否单独开维护任务拆分。

## 工作量估计

约 6 个文件主改动（`drama-timing.ts`[shared]、`drama-media-source.ts`、`drama-timing.ts`[frontend]、`drama-seek.ts`、`drama-observer.ts`、`grafana.ts`、`drama-player.tsx`、`engineering-observability.ts`，共 8 个）+ 6 个测试文件更新 + README 1 处。超过约 2 倍（例如改了 15+ 个文件，或同一个判断函数反复返工 3 次以上）按用户 CLAUDE.md 的跑偏信号处理。

## 提交分组建议（供 Phase 3.4 审核时参考，不预先执行）

1. `feat(shared): add drama playback engine field to timing schema`
2. `feat(frontend): route iOS drama playback to hls.js behind a flag`
3. `feat(frontend): tag drama timing/seek diagnostics with playback engine`
4. `feat(backend): surface drama playback engine in startup/seek diagnostics`
5. `docs: document NEXT_PUBLIC_DRAMA_IOS_HLSJS`

实际分组按 Phase 3.4 的审核结果调整，不在本阶段预先 `git add`/`commit`。
