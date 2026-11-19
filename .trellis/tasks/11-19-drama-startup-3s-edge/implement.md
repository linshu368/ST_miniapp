# Implement：短剧双端起播 ≤3s（修订 + 附加 A–G）

## 执行顺序

### Batch 0 — 入口补齐 + 进页 + D

1. `[id]/page.tsx`：hydrate 不挡 `DramaPlayer` 挂载。
2. `drama-home` switch、`drama-player` 选集/自动续集：`beginPlayback` 后 `startDramaPlayIntent`。
3. **D**：片库 warmup / 接着看可见时 `router.prefetch('/dramas/:id')`（保留现有 `/watch` prefetch）。
4. 人工/诊断确认非 cover 出现 cache|inflight。
5. Faro：按含 #932 的 release 重算基线，写入附录 / task notes。

### Batch 1 — 观测与契约

1. shared：`diagnostics.hls.prefetch` 增加 segments/init；可选 `delivery_path`。
2. 若做 **A**：`DramaPlayback` 增加可选起播子清单内联字段（strict、有界）。
3. Backend 先部署兼容，再 Frontend。

### Batch 2 — iOS 默认 hls.js + 首块 + 水位 + C/E/F/B（Railway）

1. 默认 `forceHlsOnApple`（对齐广场 MMS）；engine 上报。
2. 扩展 `drama-playback`：MAP + 视频/音轨首片；frag loader 命中；**E** critical 首块 `priority: 'high'`。
3. `hls-media-source`：`startFragPrefetch`、起播/稳播缓冲、保守 ABR、rebuffer 降档。
4. **C**：pointerdown 降低封面/装饰图带宽优先级。
5. **F**：可见封面预取默认 4，停留达标后扩至 ≤6。
6. **B**：替换 `usePreloadDramaPlayback`「只预取详情」为详情并行 + `prefetchDramaPlayback`（清单+首块）；可取消。
7. 单测：过期、URL 不匹配、缺音轨/init、fresh 绕过、动态预取上限；回归 seek 测试。

### Batch 2b — A 子清单内联 + G 审计（可与 Batch 2/3 并行）

1. Backend：签后短超时拉起播两份子清单（或缓存结构+当次重写）；miss 不长阻塞；字段可选。
2. Frontend loader：优先消费内联子清单，再回落 #932 网络预取。
3. **G**：抽样最低档 4s 体积，写入附录；异常升高记风险，不改 1s 分片。

### Batch 3 — 边缘 `edge_ticket`

1. Backend：签/刷新 ticket；KV uid 同步；Railway 回退保持（含 A 字段若已上）。
2. Worker：只验票 → KV → 签 Stream JWT → 可选 inline 主清单/子清单。
3. Frontend：持票优先边缘；401 续票或回退一次。
4. 灰度：内部 → 10% → 50% → 100%。

### Batch 4 — 首片边缘预热

1. Cron 暖热门 uid 视频/音轨/init。
2. 对照预热前后首片 TTFB。
3. 门禁差一线再开 R2 E2 或 H–L（单独任务）。

### Batch 5 — 门禁验收

等长 ≥7 天；分层 hit；护栏；勾选说明文档验收项（含 A8–A10）。

## 验证命令

```bash
pnpm --filter @miniapp/shared test
pnpm -r typecheck
pnpm --filter frontend test -- drama
pnpm --filter @miniapp/backend test -- drama
pnpm lint:complexity
pnpm --filter frontend build
pnpm --filter @miniapp/backend build
```

## 人工验证

- 片库停留：/play + 子清单 +（Batch 2 后）首块；停留更久可见第 5–6 部预取。
- 点预热封面：起播少网络；3s 内首帧+playing；弱网下封面不抢首块。
- 接着看进详情：路由 chunk 已预取倾向（Network）。
- 首页换剧 / 选集 / 续集：挂载前 cache|inflight。
- 冷路径（清缓存直打开某集）：有内联子清单时无两路 playlist 网络。
- 片尾前：下一部/下一集出现预取；滑走可取消。
- iOS：默认 engine=hlsjs_mms。
- 关边缘：回退 Railway 可播。

## 附录 — #932 后基线（待填）

| 平台    | 窗口 | 全入口 3s | 全入口 P95 | cover 3s | cover P95 | 备注                     |
| ------- | ---- | --------- | ---------- | -------- | --------- | ------------------------ |
| Android | TBD  | TBD       | TBD        | TBD      | TBD       | 含 #932 后代 app_version |
| iOS     | TBD  | TBD       | TBD        | TBD      | TBD       | 按 engine 分层           |

## 附录 — G 最低档审计（待填）

| 样本数 | 最低档分辨率 | 估 4s 体积 P50/P95 | 结论 |
| ------ | ------------ | ------------------ | ---- |
| TBD    | TBD          | TBD                | TBD  |

## 规划门禁自检

- [x] 复用 #932；可靠性；最小充分；演进；可验证；meta 已写；附加 A–G 已入设计
- [ ] #932 后 Faro 基线数字（Batch 0）
- [ ] G 审计数字（Batch 2b）
