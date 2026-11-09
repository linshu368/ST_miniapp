# 设计：iOS 短剧 hls.js 低档起播 + 引擎诊断

## 1. 复用调研

已检索的现有组件/函数，复用或扩展理由：

| 组件                                           | 位置                                                    | 处理方式                                                                                                          |
| ---------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `isAppleWebKit()`                              | `packages/frontend/src/lib/drama-media-source.ts`       | 复用，不改                                                                                                        |
| `capAppleHlsQuality()`                         | 同上                                                    | 扩展：加一个跳过条件                                                                                              |
| `loadDramaSource()`                            | 同上                                                    | 扩展：原生/hls.js 分支条件改用新判断函数；新增引擎检测与 `onEngine` 回调                                          |
| `preloadDramaHls()`                            | 同上                                                    | 扩展：早退条件改用新判断函数                                                                                      |
| `observeDramaHls()` / `recordHlsLoads()`       | `packages/frontend/src/lib/perf/drama-hls.ts`           | 复用，不改——分片级诊断逻辑与引擎无关                                                                              |
| `DramaPlaybackTiming` / `DramaTimingTracker`   | `packages/frontend/src/lib/perf/drama-timing.ts`        | 扩展：新增 `engine` 字段，`beginSeek` 新增一个参数                                                                |
| `observeDramaSeek()`                           | `packages/frontend/src/lib/perf/drama-seek.ts`          | 扩展：`buildReport` 带上 `engine`                                                                                 |
| `mirrorEngineeringTiming` / `mirrorSeekTiming` | `packages/frontend/src/lib/perf/drama-observer.ts`      | 扩展：attrs 里带上 `drama_engine`                                                                                 |
| `ENUMS` 白名单                                 | `packages/frontend/src/lib/perf/grafana.ts`             | 扩展：新增 `drama_engine` 枚举，复用现有 `safeAttributes` 的 `ENUMS[key]` 通用分支，不需要新增特判代码            |
| `DramaTimingReportSchema`                      | `packages/shared/src/api/drama-timing.ts`               | 扩展：新增可选字段 `engine`                                                                                       |
| `observeDramaStartupDiagnostic()`              | `packages/backend/src/lib/engineering-observability.ts` | 扩展：`attrs` 里带上 `engine`（JSON body 已经是全量 `parsed.data`，字段跟着 schema 自动出现，不需要新增解析代码） |
| `drama-media-source.test.ts`                   | `packages/frontend/src/lib`                             | 扩展：覆盖新分支                                                                                                  |

未发现需要新建的组件、hook、feature 或数据库函数——这是前端播放路径分支 + 现有 schema/诊断管线的字段扩展，不是新能力。

## 2. 唯一判断源：引擎路由决策

### 2.1 决策内容

有两个不同性质的判断，不要混在一起：

1. **路由决策**（同步、决定要不要用 hls.js）——在 `capAppleHlsQuality` 取地址和 `loadDramaSource` 装载时都要用，必须一致。
2. **运行态引擎标签**（异步、只有 hls.js 真正 attach 之后才知道是 MSE 还是 MMS）——只用于诊断上报，不影响播放路径选择。

### 2.2 路由决策函数

```ts
// drama-media-source.ts
function hasManagedMediaSource(): boolean {
  return typeof window !== 'undefined' && 'ManagedMediaSource' in window;
}

/** 唯一判断源：capAppleHlsQuality 与 loadDramaSource 都调用这个函数，
 *  保证同一次播放对「走不走 hls.js」的判断一致，不会出现 play_url 和
 *  实际装载路径不匹配。开关读取 NEXT_PUBLIC_DRAMA_IOS_HLSJS。 */
export function shouldUseHlsOnApple(): boolean {
  return (
    isAppleWebKit() && hasManagedMediaSource() && process.env.NEXT_PUBLIC_DRAMA_IOS_HLSJS === 'true'
  );
}
```

- `'ManagedMediaSource' in window` 是同步能力检测，不依赖 `import('hls.js')`，满足「判断同步完成」的要求。
- iOS 17.1 以下、WKWebView 不支持 MMS 的情况下 `hasManagedMediaSource()` 为 `false`，自动落到现状分支，不需要额外的版本判断逻辑。

### 2.3 落点改动

**`capAppleHlsQuality`**（约束 1、3）：

```ts
export function capAppleHlsQuality(playback: DramaPlayback): DramaPlayback {
  if (playback.format !== 'hls' || !playback.play_url || !isAppleWebKit() || shouldUseHlsOnApple())
    return playback;
  // ...现有 clientBandwidthHint 逻辑不变
}
```

**`loadDramaSource`**（约束 1）：

```ts
const native = Boolean(video.canPlayType('application/vnd.apple.mpegurl'));
const useNative =
  playback.format !== 'hls' || (native && isAppleWebKit() && !shouldUseHlsOnApple());
if (useNative) {
  video.src = source;
  onEngine?.(playback.format !== 'hls' ? 'native_file' : 'native_hls');
  ready();
} else {
  // 现有 import('hls.js') 分支；MEDIA_ATTACHED 回调里补上引擎检测（见 §3）
}
```

**`preloadDramaHls`**（约束 4）：

```ts
export function preloadDramaHls(): void {
  if (isAppleWebKit() && !shouldUseHlsOnApple()) return;
  void import('hls.js').catch(() => undefined);
}
```

只改函数体，不改调用位置（`dramas/[id]/page.tsx`、`drama-home.tsx` 里的 `useEffect(() => preloadDramaHls(), [])` 保持不变，属于第 1 批范围）。

## 3. 运行态引擎标签：MSE vs MMS

hls.js 1.7.4 的 `MEDIA_ATTACHED` 事件数据里带 `mediaSource?: MediaSource`，是 hls.js 内部按 `hls.config.preferManagedMediaSource` 实际选中的构造器实例（不是我们猜的）。在 `loadDramaSource` 现有的

```ts
hls.on(Hls.Events.MEDIA_ATTACHED, () => { ... });
```

旁边新增一个不影响现有行为的监听（复用同一个 `onHls` 时机，在 `attachMedia` 之前完成订阅，不会错过事件）：

```ts
hls.on(Hls.Events.MEDIA_ATTACHED, (_event, data) => {
  const MMS = (window as unknown as { ManagedMediaSource?: unknown }).ManagedMediaSource;
  onEngine?.(
    MMS && data.mediaSource instanceof (MMS as new (...a: never[]) => unknown)
      ? 'hlsjs_mms'
      : 'hlsjs_mse'
  );
});
```

`loadDramaSource` 新增一个可选参数 `onEngine?: (engine: DramaPlaybackEngine) => void`，三个分支（`native_file` / `native_hls` 同步调用，`hlsjs_mse` / `hlsjs_mms` 在 `MEDIA_ATTACHED` 异步调用）各自调用一次。不新增状态、不改变 `ready()`/`failed()` 的时序。

### 3.1 诊断接线（跨 drama-player.tsx 的最小改动）

`engine` 需要落到 `DramaPlaybackTiming`（起播诊断）和 `beginSeek`（快进诊断）两处，而这两处目前都由 `drama-player.tsx` 调用 `loadDramaSource` / `dramaTiming.beginSeek` 时传参（例如 `playback.delivery` 就是这样直接传进去的，不是组件自己算的）。这个任务不在「负责范围」明确列出 `drama-player.tsx`，但只做两行接线、不碰续播/起播位置参数/loader 配置，和第 1、3 批范围不重叠：

```ts
// drama-player.tsx，与现有 hlsHandleRef 同级
const engineRef = useRef<DramaPlaybackEngine | undefined>(undefined);

// loadDramaSource(...) 的第 5 个回调参数之后追加 onEngine：
(engine) => {
  engineRef.current = engine;
  timing.engine = engine; // DramaPlaybackTiming 新增的可写字段
};

// beginSeek(...) 调用追加一个参数：
dramaTiming.beginSeek(
  videoEl,
  playback.play_url,
  seconds,
  wasPlaying,
  id,
  currentVideoId ?? undefined,
  playback.delivery,
  hlsHandleRef.current ?? undefined,
  engineRef.current // 新增
);
```

如果你希望这两行接线也算越界，可以改成在 `design.md` 审核时把它单独列出来再定；但不接线的话 `engine` 字段只能停在 shared schema 里，起播/快进诊断实际上报不出来，验收标准 3/4 无法达成，所以这里先按主路径处理。

## 4. Shared schema：新增可选字段

`packages/shared/src/api/drama-timing.ts`：

```ts
export const DramaPlaybackEngineSchema = z.enum([
  'hlsjs_mse',
  'hlsjs_mms',
  'native_hls',
  'native_file',
]);
export type DramaPlaybackEngine = z.infer<typeof DramaPlaybackEngineSchema>;
```

在 `DramaTimingReportSchema` 顶层加一行 `engine: DramaPlaybackEngineSchema.optional(),`（和 `addressSource`/`frameMethod` 同级，不嵌进 `context`——`context` 是请求级环境维度，`engine` 是每次播放/快进的运行态事实，生命周期不同）。

`dramaTimingLogFields()` 里加一行 `engine: report.engine,`，自动进入日志体和 POST body。

### 4.1 Schema 是 strict 的：兼容方向与部署顺序

`DramaTimingReportSchema` 整体 `.strict()`。后端两处用它：

- `packages/backend/src/routes/telemetry.ts:63` —— `safeParse(request.body)`，**失败时整条上报 400，不是只丢诊断字段**。
- `packages/backend/src/lib/engineering-observability.ts:517` —— 再次 `safeParse`，只影响诊断投影。

如果前端先部署、后端 schema 还没加 `engine`：前端上报的 body 里多出一个 `engine` key，旧后端的 strict schema 会把整条 POST 判定为 400，**这次播放/快进的所有计时数据都会丢**，不只是诊断字段缺失。

**部署顺序（延续本项目「以往是后端先部署」的做法）**：

1. 合并 PR 到 `main` → Railway 后端自动部署，schema 已包含可选 `engine` 字段（新增可选字段对旧前端完全透明，旧前端不发这个字段，`parse` 照样通过）。
2. 确认后端部署成功（Railway 日志 / 一次手动 timing 上报验证）。
3. 再把 Vercel 前端从 preview 提升到 production（见 §5 开关章节），让前端开始实际发送 `engine` 字段。
4. 不存在"先关"的问题：`engine` 在 schema 里永远是 `optional()`，新后端兼容旧前端（不发送该字段）和新前端（发送该字段）；只有"新前端 + 旧后端"这一种组合不兼容，用上面的顺序规避。

回滚方向对称：如果要回滚，先回滚前端（停止发送 `engine`，旧/新后端都能解析），再回滚后端（可选字段，回滚不影响任何一侧）。

## 5. 开关：环境变量与 Vercel 环境

命名：`NEXT_PUBLIC_DRAMA_IOS_HLSJS`（跟现有 `NEXT_PUBLIC_DRAMA_STREAM_ORIGIN`、`NEXT_PUBLIC_DRAMA_TIMING_MODE` 命名风格一致）。

- 未设置或非 `'true'` 字符串：默认关闭，等同现状。
- Next.js 要求 `NEXT_PUBLIC_*` 在构建时静态内联，不能运行时切换——这意味着开/关需要重新构建（Vercel 的 preview/production 各自独立构建，天然符合「先 preview 验证再 production」的节奏，不需要额外的运行时 feature flag 基建）。
- 配置步骤（**写在这里但不由本任务自动执行，需要你在对话里确认后再执行**）：
  1. Vercel 项目 → Settings → Environment Variables → 新增 `NEXT_PUBLIC_DRAMA_IOS_HLSJS=true`，Environment 勾选 `Preview`（不勾 `Production`）。
  2. PR 合并后在对应 preview 部署上按 §7 真机验证清单测试。
  3. 验证通过后，把同一个变量的 Environment 改成同时包含 `Production`（或新增一条 Production 专属的记录），触发一次 production 重新部署。
  4. 需要回退时，去掉 `Production` 的勾选并重新部署即可，不需要改代码。
- README「环境变量」一节补充一行，说明用途、默认关闭、只在 Apple 设备 + MMS 下生效。

## 6. 可靠性设计

| 维度          | 处理                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 超时          | hls.js 现有 `manifestLoadingTimeOut: 10000` / `fragLoadingTimeOut: 15000` 不变，两条路径共用同一套配置，不新增超时面                                                                                   |
| 降级          | `shouldUseHlsOnApple()` 为 `false`（无 MMS / 开关关闭 / iOS<17.1）时自动回退现状原生路径；`Hls.isSupported()` 为 `false` 时现有逻辑已经会在 `native` 为真时回退原生、否则 `failed()`，不受本次改动影响 |
| 幂等/并发     | 不涉及写操作；`loadDramaSource` 的 cleanup（`disposed` 标志、`owners` WeakMap）逻辑不变                                                                                                                |
| 限流          | 不涉及新增网络调用；诊断上报复用现有 `/api/telemetry/drama-timing` 的速率限制（每用户 120/分钟），不新增字段不改变限流维度                                                                             |
| 容量          | `engine` 是 4 选 1 的短字符串枚举，对 `DRAMA_TIMING_BODY_LIMIT`（32KB）和 Faro `MAX_PAYLOAD_BYTES`（2KB）影响可忽略                                                                                    |
| 可观测性      | 本任务本身就是在补可观测性（引擎维度）；额外新增：`drama_engine` 枚举走现有 `safeAttributes` 白名单机制，非法值自动落到 `'other'`，不会污染指标基数                                                    |
| 回滚/停止条件 | 开关是环境变量，回退只需去掉 Production 勾选重新部署，不需要代码回滚；如果 hls.js 路径线上表现明显劣于原生（卡顿占比上升、起播变慢），直接关闭开关即可，不涉及数据损坏或不可逆状态                     |

## 7. 真机验证清单（WKWebView / Telegram iOS）

验证时用以下方式确认实际走的是 hls.js：看起播诊断日志（`drama.startup_diagnostic`）里的 `engine` 字段是否为 `hlsjs_mse`/`hlsjs_mms`，而不是看界面表现（原生和 hls.js 起播视觉上可能很像）。

1. **WKWebView 里有没有 `ManagedMediaSource`**——这是开关生效的前提，建议先于其余项单独确认（可以让工程师在 Telegram iOS 里打开一个带 `javascript:` 调试或远程调试工具执行 `'ManagedMediaSource' in window`）。
2. 首页自动播、点封面、切集、切剧——确认引擎字段在切换时正确更新（新一次播放重新判断，不沿用上一次的值）。
3. 快进、拖动进度条——确认快进诊断里的 `buffered` 口径在 hls.js 下仍能正常工作（MSE 的 `video.buffered`），对比 §3.1 的接线是否生效（`engineRef.current` 有没有传进 `beginSeek`）。
4. 切到后台再回来、锁屏——确认 hls.js 实例不会在后台被系统回收后播放异常（`disableRemotePlayback` 在 MMS 下会被 hls.js 自动设置）。
5. 静音自动播放的降级——确认现有「有声失败→静音重试一次」逻辑在 hls.js 路径下行为不变（`drama-player.tsx` 这部分代码本任务不改）。
6. 长时间播放——确认 hls.js 的 ABR/buffer 管理在长剧集下不异常增长内存（可用 Safari 远程调试面板观察）。
7. 关掉开关后能回到原生——重新部署一次不带该变量（或设为非 `true`）的构建，确认行为和改动前完全一致。
8. 画质：前 4 秒是不是低档，多久升档，最终稳定在哪一档——对应验收标准里「无 720p 封顶」。

## 8. 发布后验证方法

- Grafana token：`/Users/qj/.config/grafana/token`，Loki 数据源 uid `grafanacloud-logs`。
- 后端诊断查询：`{service_name="st-miniapp-backend"} |= "drama.startup_diagnostic"`，JSON 格式。关注：
  - `diagnostics.hls.entries`：iOS 上应该开始出现 `fragment` 记录（原来只有 Android 有）。
  - 新增的 `engine` 字段：确认出现 `hlsjs_mse`/`hlsjs_mms`，且没有意外的 `native_hls`（开关打开后仍落到原生，说明 MMS 检测或开关读取有问题）。
- 画质分布：筛 `tg_platform=ios` 且 `engine` 为 `hlsjs_*` 的样本，看 `diagnostics.hls.entries[].height` 随 `startMs`的变化趋势，确认从低档起步、ABR 升档。
- 快进诊断同理，查 `drama.seek_diagnostic`，对比 `engine=hlsjs_*` 和 `engine=native_hls` 两组的 `seek_budget` 分布，不要把两组混在一起算同一个 P95（见 prd.md 口径变化）。

## 9. 最小充分方案：拒绝的过度设计

- **不**做运行时可切换的 feature flag 基建（如远程配置/Admin CLI 开关）——`NEXT_PUBLIC_*` 环境变量 + Vercel 环境分离已经满足「preview 先验证、production 再开」的节奏，构建时静态内联也更安全（不会出现同一进程内新旧逻辑混跑）。待拍板项见下方。
- **不**给 `engine` 字段建单独的 Grafana 看板卡——按 prd.md 约定，看板改动不在本批。
- **不**抽象出一个通用的「播放引擎检测」插件层——只有 iOS 这一条分支需要区分 MSE/MMS，Android 路径不受影响，提前泛化没有第二个使用者。
- **不**改 `use-drama-scrub.ts` 和 `drama-seek.ts` 的 `currentSrc`/`ownsDramaSource` 比对逻辑——已核实这两处不受 `blob:` 地址影响（§ prd.md「口径变化」）。

## 测试覆盖说明（非待拍板，直接按规范执行）

`.trellis/spec/frontend/app/testing-quality-and-deployment.md` 第 104-111 行（短剧统一测量 v3）明确写了「Tests Required：扩展既有 shared telemetry-contract、frontend drama-timing/observer/media/grafana 及 backend telemetry 回归」，本次改动落在同一条诊断管线上，按同一条规范执行，不是新开的测试要求，因此不作为待拍板项，直接列入 implement.md 的主路径：

- 实际检索结果：shared 包目前没有独立的「telemetry-contract」测试文件（`packages/shared/src/__tests__/` 下没有覆盖 `DramaTimingReportSchema` 的用例），spec 这句描述与当前实现有差异——按 AGENTS.md「若文档与实现冲突，先记录来源和差异，不得把推断写成当前事实」的要求，这里记录差异：新增字段的 schema 校验改在 backend `engineering-observability.test.ts` / `telemetry.test.ts`（两者本来就 `safeParse` 这个 schema）里补用例，不新建 shared 层测试文件。
- Frontend 已有可直接扩展的测试文件：`drama-media-source.test.ts`（引擎路由分支）、`drama-timing.test.ts`、`drama-observer.test.ts`、`drama-hls.test.ts`、`drama-seek-diagnostics.test.ts`、`grafana.test.ts`（ENUMS 新增维度）。
- Backend 已有可直接扩展的测试文件：`engineering-observability.test.ts`、`telemetry.test.ts`。
- `drama-hls.test.ts`/`drama-media-source.test.ts` 现有 mock 没有真实的 `MediaSource`/`ManagedMediaSource` 全局对象，需要在新增用例里补一个最小 mock（`vi.stubGlobal('ManagedMediaSource', class {})`），用于验证 `MEDIA_ATTACHED` 的 `data.mediaSource instanceof` 判断——这不是新建测试基建，是现有 `vi.stubGlobal` 模式的直接复用（`drama-media-source.test.ts` 已经在用 `vi.stubGlobal('navigator', ...)`）。

## 待拍板项

- **运营平台开关（Admin CLI managed config）替代环境变量**｜理由：环境变量改动需要重新构建+部署，运营想临时关闭时不能像 Admin 配置一样秒级生效｜不做的代价：出现问题时响应速度比运营配置慢（分钟级部署 vs 秒级发布），但本任务影响面小（纯前端播放路径，无数据损坏风险），可接受｜建议：暂缓，先用环境变量验证可行性，如果决定长期双路径运行再考虑迁移到运营平台配置。
