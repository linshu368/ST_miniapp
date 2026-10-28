# 任务清单（执行中）

## 需求追溯

| 需求                                                 | PRD                               | design             | 任务           |
| ---------------------------------------------------- | --------------------------------- | ------------------ | -------------- |
| 1 新 schema                                          | R1                                | §2.1–2.2、§10      | T3             |
| 2.1 类型筛选                                         | R2                                | §3.2、§4、§5       | T2 T5 T7       |
| 2.2 全部风格 + 标签管理                              | R2                                | §2.5、§4、§5、§6   | T2 T5 T6 T7    |
| 2.3 视频卡片                                         | R2                                | §4、§5             | T7             |
| 2.4 视频详情                                         | R2                                | §3.2、§5           | T5 T7          |
| 2.5 输入栏（切换、附图、模型、默认值、用同款、设置） | R2                                | §3.5、§4、§5       | T4 T7          |
| 2.6 Admin 模型 media_type                            | R2                                | §2.5、§6           | T6             |
| 2.7 编辑/重生成/分享/下载                            | R2                                | §2.4、§5           | T5 T7          |
| 2.8 参考图持久化 + 首帧封面                          | R2                                | §2.3、§3.3         | T4             |
| 3 种子 + 6 个模型（均匀热度 Top 4,000）              | R3、D16                           | §7、research       | T1 T8          |
| 4 原型仅作参考                                       | R4                                | §5（D7）           | T7             |
| 5 计费                                               | R5                                | §2.4、§3.6         | T3 T4          |
| 6 审核拒绝                                           | R6                                | §3.3、§3.7         | T4 T7          |
| 7 复用/隔离                                          | R7                                | §1、§2.3           | T3 T4          |
| 8 性能/异步/Sentry                                   | R8.A 列表 / R8.B 创作 / R8.C 指标 | §3.3、§5.2–5.3、§8 | T1 T4 T5 T7 T9 |

## 任务

| ID  | 状态        | 内容                                                                                                                                                | 依赖     | 完成条件                                                                       |
| --- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------ |
| R1  | Done        | 2026-10-24 证据采集（Venice 目录与文档、xlsx、原型、代码现状）                                                                                      | —        | 写入 `research/*.md`                                                           |
| R2  | Done        | 改版 PRD、design、implement、task、jsonl                                                                                                            | R1       | 8 项需求全部可追溯                                                             |
| G1  | Done        | 用户决策：schema 名为 `media_plaza`（账务留在 billing）；视频预扣 + 退款                                                                            | —        | 写入 PRD D1/D2                                                                 |
| G2  | In Progress | 2026-10-24 已关闭 B-MODEL-1/B-OPT-1/B-FFMPEG-1/B-ENV-1/B-SEED-2（D8–D14）；剩余 B-SEED-1（授权/实际配额，流程已由 D13 固定）                        | —        | 剩余 1 项确认                                                                  |
| G3  | Done        | 审核与架构评审（ADR），之后执行 `task.py start`                                                                                                     | G2       | 用户于 2026-10-27 明确批准开始执行                                             |
| T1  | Blocked     | Venice 价格与 canary 证据；图片广场列表/创作 Sentry p95 基线（冷热各≥20）                                                                           | G3       | 等待真实供应商密钥与监控环境                                                   |
| T2  | Done        | shared 契约                                                                                                                                         | G3       | shared 测试及全仓 typecheck 已通过                                             |
| T3  | In Progress | 合并已完成的 M1/PostgREST/直连改动；继续推进视频 M2/M3，不保留旧 schema 回退                                                                        | T2       | M1 两环境完成；待 TEST 执行并验证 M2/M3                                        |
| T4  | In Progress | 视频 worker/upstream/计费/审核/封面 + Dockerfile 加 ffmpeg（视频无提示词优化）                                                                      | T2 T3    | 本地实现和单测完成；待 Docker 构建与供应商 canary                              |
| T5  | In Progress | feed 游标+media/tags、列表无 MP4、签名 LRU 扩视频桶、DTO 裁剪、tag-counts、详情、分享                                                               | T3       | 本地实现和单测完成；待真实 Range/签名资源人工验证                              |
| T6  | In Progress | Admin 视频目录、标签 media_types、参考价代理                                                                                                        | T2 T3    | 目录和标签编辑器完成；待真实参考价接线                                         |
| T7  | In Progress | 前端广场/详情/工作室 + 4 组件；接线 feed 预取；创作预取/报价复用/轮询退避；埋点                                                                     | T4 T5 T6 | 实现、测试和构建完成；待 Telegram 双端及 R8 预算验证                           |
| T8  | In Progress | 体积估算+Top 4,000（已完成）→ D17 方案确认 → TEST 10 条 → main Storage 4,000 组纯资产上传 → 生成/审核 8×500 SQL → 上线执行与对账；当前只读/本地规划 | T3 T4    | 用户确认媒体方案；TEST 10 条通过；main manifest 全 verified；上线 SQL 全部记账 |
| T9  | In Progress | 全量验证、canary；列表/创作 Sentry p95 门禁；图片回归 ≤10%；看板分图                                                                                | T7 T8    | 本地检查通过；外部 canary、Sentry 与人工验证未完成                             |
| T10 | In Progress | 文档同步与 production 灰度                                                                                                                          | T9       | 本地文档已同步；production 仍需单独审批                                        |

## 记录

- 2026-10-28 TEST 10 条执行：锁定报告复验通过；本地四路下载、最多两路 FFmpeg 完成 10/10，9 条转码、1 条 remux，六模型分布 2/2/2/2/1/1；全部 H.264/yuv420p、音频 AAC/无、GOP ≤2s、`moov < mdat` 且 `moov` 最大 115,736 bytes，并通过 0/10/50/90% 解码。源视频 93,964,071 bytes，处理后视频 49,495,483 bytes，poster 583,363 bytes；processed manifest SHA-256=`161dc1d37ba75c570ff78ac856386d4581084f20e9bc7336cbb8693c82f0d074`。
- 2026-10-28 TEST Storage 执行：只读身份/私有桶预检通过后，以 6MiB TUS 分块、4 路并发上传 10 视频 + 10 poster；`x-upsert:false`，20/20 对象通过认证 Range 回读与大小校验。签名 URL 首段 Range p95=1,873.0ms，中段 Range p95=967.3ms（同 URL 复用），达到参考网络 2s 预算。尚未写数据库；TEST 已发布视频模型目录仍缺失，必须先由运营审核/发布目录，再生成并执行 10 条 TEST SQL。
- 2026-10-28 用户新增 D23：Admin/Frontend 视频选项只保留 5/10 秒、16:9/9:16/1:1、720P/1080P，并按模型真实能力取交集；供应商值大小写保持原样，UI 统一大写展示。旧目录由 Admin/Frontend 消费侧收窄，Admin 同步裁剪价格矩阵。
- 2026-10-28 用户新增 D20–D22：参考短剧播放链路优化；TEST 因容量只导入 10 条；main/Production 先上传全部 4,000 组私有对象但不写业务表，完成后从锁定 upload manifest 生成 8×500 migration，等上线窗口逐文件执行。上传器与 SQL 生成器物理分离，生产对象使用不可变 hash 路径；入口在八批与 postflight 完成前保持关闭。D17 审核门禁继续有效，本次仅更新规划，未运行 FFmpeg、未上传、未写库。
- 2026-10-28 短剧复用结论：采用稳定签名 URL、同 key single-flight、5s 签名超时、点击/临近播放只预取地址、换签保留 currentTime/paused、旧 source 释放，以及 address/metadata/first-frame/seek/buffer 分段观测；不复制短剧 UI，不在当前自建 ABR。
- 2026-10-27 用户确认 D16：总量只保留 4,000 条，模型间尽量均匀，模型内按热度取舍。翻译命中 5,082 条的 URL 排除前水位填充配额为 711 / 952 / 583 / 682 / 952 / 120；同热度用 source_video_id 稳定排序。
- 2026-10-27 用户新增 D17：Supabase 上传前必须先规划 FFmpeg 编码与文件处理以支持快速打开，并由用户确认后再执行。门禁前不得完整下载、运行 FFmpeg 或写远程环境。
- 2026-10-27 用户新增 D18：参考网络下播放快开与未缓存 seek 的 p95 均 ≤2 秒；处理门禁增加 GOP/关键帧检查。播放层预留 provider/format adapter，后续 CDN 点播以加法方式接入，当前不提前引入 HLS/MSE 实现。
- 2026-10-27 用户确认 D19：本次不做 ABR/HLS/DASH，只优化 Supabase 私有桶中的 progressive MP4；后续通过 CDN 点播平台接入 ABR。
- 2026-10-27 D16 最终只读容量报告：5,082 个候选中 5,073 个 URL 可访问，9 个连续三轮为 404；均匀热度 Top 4,000 共 43,593,139,500 bytes（40.599 GiB），报告 SHA-256=`f4004258ecd11d91088a7dabc670420e5cb1c10d0fafde8f949fa7c12dd8b1c4`。仍未完整下载、运行 FFmpeg 或写 Supabase。
- 2026-10-27 只读容量统计：全候选 5,097 条中 5,087 条最终取得 Content-Length，共 48.569 GiB；9 条 404、1 条连续网络失败。未执行 seed dry-run/apply，未写数据库或私有桶；最终容量需按 D16 的 4,000 条集合重算。

- 2026-10-27 合并图片 M1 后复验：Backend typecheck 与 991 项测试、Shared 186 项测试、Frontend/Admin/Reply Renderer typecheck、migration/legacy/import lint、两份 Trellis context validate 均通过。`pnpm -r typecheck` 仅因 `packages/ui-tests` 未安装本地依赖而缺少 `@types/node`；Frontend/Admin build 分别因当前 `node_modules` 缺少 Next `./impl`、`source-map-js` 依赖而未完成，未出现本次代码的类型错误。
- 2026-10-27 用户确认 TEST、Production 已完成图片 M1（8 张表、3 个 RPC）和 PostgREST `media_plaza` 暴露；本分支按直接访问新 schema 合并，不重跑/回滚 M1。视频 M2/M3、供应商 canary 与 seed 导入仍未执行。
- 2026-10-27 本地实现验证：`pnpm -r typecheck`；shared 184、backend 903、admin 122、frontend 390 项测试通过；Admin/Frontend production build 通过；migration/legacy/import lint 通过。Docker CLI 不可用，未构建后端镜像。
- 2026-10-27 用户明确批准开始执行；B-SEED-1 继续作为实际 seed 转存和 production 灰度门禁，不阻止本地实现与验证。
- 2026-10-26 再补：列表三条硬约束写死——**游标分页**（filter 含 media/tags）、**列表无 MP4**（只签 poster）、**资源走签名 LRU**（扩展 `storage.ts` 至视频桶，24h 稳定 URL）。与 p95 同级验收。
- 2026-10-26 补充性能设计（用户要求）：结合当前图片广场列表与数据请求现状，把 R8 拆成列表加载（R8.A）、创作页回复生成（R8.B）、Sentry p95 预算（R8.C）。合并 D15 播放设计后对应 design §5.2/§5.3，并加厚 §8.1；implement P0/P4/P5 与验证表同步。仍保持 planning，未改产品代码。
- 2026-10-24 改版。取代 10-16 版的规划，主要差异：
  - 新增 schema 迁移；
  - 视频改为预扣 + 退款；
  - xlsx 改为 6 列新文件，没有 prompt_zh；
  - 6 个模型已核对 Venice id，其中 Seedance 2.0 R2V Enhanced 缺失；
  - safe_mode 和 prompt 优化在视频接口中都没有对应字段；
  - 镜像中没有 ffmpeg。
- 规划阶段没有调用付费接口或写数据库；图片 M1 的远程执行由独立 schema-move 工作完成，本任务仍未执行视频 M2/M3、付费接口或 seed 转存。
- 2026-10-24 用户确认 5 项，记为 D8–D12：Seedance 映射；视频关闭自动优化；安装 ffmpeg；用翻译包 video.xlsx 补 prompt_zh；先在 test 执行。
  - 翻译包对照已实测（只读本地 xlsx）：5,082/5,082 命中，三项字段全部一致，原表多出 15 条。
  - 新发现：超过 2,000 字的提示词有 879 条，列为 B-SEED-2。
- 2026-10-24 用户再确认 2 项，记为 D13、D14：
  - D13：导入前先对 5,097 条视频 URL 做 HEAD 体积估算，人工确认体积后才能继续 dry-run 后续步骤（关闭 B-SEED-1 的流程部分，实际配额数字仍要执行期核对）。
  - D14：视频提示词不设字数上限（图片 2,000 字不变），关闭 B-SEED-2。
- 2026-10-26 补充 D15 / design §5.1：mp4 边下边播。
  - `<video>` **不能**接收 `fetch()` 的 `ReadableStream`；`res.blob()` + `createObjectURL` 会整文件下完才播，禁止作主路径。
  - 正确做法：可播放 URL（签名或同域 `/stream`）直接赋给 `video.src`，依赖 HTTP Range + 入库 `faststart`。
  - 可选增加 `GET .../video-artifacts/:id/stream` 鉴权代理（支持 `206`），仍由浏览器对 `src` 发 Range。
