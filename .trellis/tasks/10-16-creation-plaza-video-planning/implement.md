# 执行计划（待审核；任务保持 planning）

参考：design.md（§ 编号）、prd.md（R 编号）、task.md（任务 ID）。

## 0. 开工门禁

- [ ] PRD/design 审核通过，ADR（design §2.1）通过架构评审。
- [x] B-MODEL-1 → D8：Seedance 2.0 R2V 映射到 `seedance-2-0-reference-to-video-basic`。
- [x] B-OPT-1 → D9：视频关闭自动优化提示词。
- [x] B-FFMPEG-1 → D10：安装 ffmpeg。P3 里记录镜像体积和构建耗时的前后对比。
- [x] B-ENV-1 → D12：先在 test 执行。每次执行前在记录里核对连接目标，并采集结构快照（只读，不读业务行）。
- [x] B-SEED-2 → D14：视频提示词不设字数上限，图片不变。
- [ ] B-SEED-1：种子转存授权与 bucket 实际配额已确认。流程已定（D13）：P6 先跑体积估算脚本（对 5,097 条 HEAD 求和），人工看过报告后带 `--confirm-size <报告 hash>` 才能继续 dry-run。
- [ ] 基于最新 `origin/dev` 开 feature 分支，PR 目标为 dev。不在规划阶段切换分支。
- [ ] 测试文件范围：本任务涉及计费、并发、契约、迁移，规划确认**需要**回归测试，清单见 §3。审核批准后才创建测试文件。

## 1. 分阶段交付

### P0 证据与基线（T1）
- 用 Venice test key 对 6 个模型的 t2v/i2v/r2v 各调用 1 次 quote，整理成价格矩阵草案。
- 每个模型做 1 次 queue canary，实测以下内容：
  - 耗时；
  - 返回的是 `download_url` 还是 mp4；
  - 输出编码，以及能否被 ffprobe 解析；
  - 拒审路径。
- 在 Telegram iOS/Android 上测图片广场冷/热启动基线，每种 ≥20 次。

### P1 契约（T2）
- `shared/src/api/video-plaza.ts`，以及 `image-plaza.ts` 的兼容扩展（design §4）。
- 运行 `pnpm --filter @miniapp/shared test` 和 `pnpm -r typecheck`。

### P2 迁移（T3）
- 写 M1、M2、M3 及对应回滚脚本，并做 preflight/postflight 断言（design §2）。
- 后端加入 `plazaDb()` 双读探测；`DOMAIN_SCHEMAS` 加入 media_plaza；准备 PostgREST 暴露 SQL。
- 在 test 逐个文件执行，执行前后各记录一次 shape、权限、锁耗时。执行完 M1 立即跑图片回归。

### P3 后端视频链路（T4）
- 编写 `video-catalog.ts`、`video-upstream.ts`、`video-repository.ts`、`video-job.ts`、`video-media.ts`。视频不做提示词优化（D9）。
- Dockerfile 运行层（`node:20-bookworm-slim`）在现有 apt 命令里加 `ffmpeg`，并加构建期断言 `ffmpeg -version && ffprobe -version`。`video-media.ts` 在启动时探测二进制；缺失时报 error 日志，并隐藏视频模型；入库前 remux `+faststart`（D15）。
- 本地开发（Windows）需要 ffmpeg 在 PATH 中，或者通过 `FFMPEG_PATH`/`FFPROBE_PATH` 指定（经 `platform/config.ts` 读取），写入 README。
- 补齐路由（含 playback；按需 stream Range 代理）和 `@frontend-ready: false` 注释，同步 config.ts 环境变量。
- 先用 mock 上游验证失败路径，再接真实 canary。

### P4 读层、分享、Admin（T5、T6）
- feed 支持 media/tags 筛选，新增 tag-counts 接口，详情支持视频，会话增加 `include_video`。
- 视频分享 RPC 接入。
- Admin 新增视频目录编辑器，标签增加 media_types，参考价代理。
- 核实签名 URL 的 Range/206；若不支持则启用同域 `/stream`（design §5.1 接法 B）。

### P5 前端（T7）
- 按 design §5 / §5.1 落地：广场、详情、工作室，以及 4 个新组件。
- 播放器只把可播放 URL 赋给 `<video src>`；禁止 `fetch`→`blob`/`createObjectURL` 作播放主路径。
- 新增 `video_generate` 埋点。

### P6 种子导入（T8）
- 第一步：`estimate-video-plaza-seed-size.ts`（D13）对原表 5,097 条 `Video URL` 发 HEAD（并发 10），输出总字节数、按模型小计、失败清单，写成 `video-seed-size-report.json`。人工看过报告、确认 bucket 配额够用（关闭 B-SEED-1）之后，才带 `--confirm-size <报告 hash>` 进入下一步。
- `video-seed-import.ts` 与对应脚本：dry-run → manifest → test 小批 → test 全量 → 对账。production 单独审批（D12）。
- 输入两份文件：原表 `--input civitai_venice_nsfw_videos.xlsx`，翻译包 `--translations 翻译包/video.xlsx`。按 design §7 的 URL 路径对照写入 `prompt_zh`。
- 提示词不设上限（D14），`prompt`/`prompt_zh` 原样写入 TEXT 列。
- dry-run 预期（2026-10-24 实测基线）：命中 5,082 条，不一致 0 条，「已剔除」15 条（`excluded_by_translation_pack`），孤儿 0 条。实际数字偏离基线时停下核查。

### P7 验证、文档、灰度（T9、T10）
- 跑完 §2 的命令和 §3 的场景。
- 同步更新以下文档：
  - README（迁移顺序、seed 命令）
  - `docs/ARCHITECTURE.md`（九域、路由、worker）
  - spec：schema 规范、backend/frontend 模块
- production 按 design §10 执行。

## 2. 命令

```sh
pnpm --filter @miniapp/shared test
pnpm --filter @miniapp/backend test
pnpm --filter @miniapp/frontend test
pnpm --filter @miniapp/admin test
pnpm -r typecheck
pnpm --filter @miniapp/frontend lint
pnpm lint:imports
pnpm lint:legacy
pnpm lint:migrations
pnpm --filter @miniapp/frontend build
pnpm --filter @miniapp/admin build
docker build -f ops/docker/Dockerfile.backend .   # 验证 ffmpeg 已安装
pnpm --filter @miniapp/backend video-plaza:estimate-size -- --input <原表xlsx> --report video-seed-size-report.json   # P6 第一步，体积估算
pnpm --filter @miniapp/backend video-plaza:seed -- --input <原表xlsx> --translations <翻译包video.xlsx> --target test --confirm-size <报告hash>   # dry-run（P6 新增脚本），没有 --confirm-size 时拒绝执行
pnpm --filter @miniapp/backend video-plaza:reconcile                        # dry-run（P3 新增脚本）
```

backend、shared 没有 build script，不要虚构。真实上游调用和 DB 写入只能在明确授权的 test 环境手动执行，不放进单元测试。

## 3. 验证场景（含失败路径）

| 领域 | 场景 | 通过标准 | 自动/人工 |
| --- | --- | --- | --- |
| 迁移 M1 | preflight 发现残留引用；锁超时；回滚演练；迁移后图片全链路 | 发现残留或锁超时即中止；回滚后结构与迁移前一致；图片回归全部通过 | 人工 + SQL 断言 |
| 契约 | 旧客户端不传 media/tags；旧 tag 配置不含 media_types；未知 status | 旧 payload 仍可解析；非法值在边界被拒绝 | shared 测试 |
| feed | media×sort×search×tags 组合；多标签 OR；切换 media 后游标作废；计数失败 | 无重复、无遗漏；计数显示“—”而不是 0 | backend 测试 + 人工 |
| 计费 | 重复提交同一个幂等键；并发两单只够一单；reserve 响应丢失；重复 refund | 最多扣一次、退一次；不透支 | backend 测试（mock RPC）+ test DB 手动 |
| worker | queue 超时（结果未知）；429/503 退避；进程在 submitting 或 storing 时崩溃；双副本抢同一任务；超过 deadline | 不重复调用 queue；租约 fencing 生效；状态可解释 | backend 测试 |
| 审核 | queue 返回 422；retrieve 返回 422 `provider_content_policy` | 状态为 moderation_rejected，退款 1 次，前端显示专用文案，Sentry 记录事件 | 测试 + canary |
| 存储 | 伪造 MIME；超过 200MiB；ffmpeg/faststart 失败；地址过期后刷新；越权访问 playback/stream；stream 无 Range 或整文件进内存 | 拒绝或降级处理；不泄露 URL；stream 必须流式 + 支持 206 | 测试 + 人工 |
| complete | 转存成功后才调用；complete 失败 | 失败只记日志，不影响 ready | 测试 |
| 分享 | 图片先分享再分享视频；反过来；两者并发；重复分享；分享已退款的视频 | 首次分享奖励只发一次；不重复返利；已退款的拒绝 | test DB |
| Admin | 价格矩阵缺项；默认模型被禁用；`required_reference` 配了 t2v；发布后回滚 | 无法发布；回滚后生效 | admin 测试 |
| 前端 | 模型不支持图片时禁用附图；必须附图却没附；切换模型参数被重置；402 时草稿保留；离页后返回；轮询退避；页面隐藏时暂停 | 无静默丢图；无重复提交 | 人工（Telegram 双端） |
| 播放 | 点击播放、暂停、拖动；地址过期刷新；列表页 mp4 请求数；弱网边下边播；签名 URL 的 Range/206（或同域 stream 的 Range）；未 faststart 的对照样例 | 拖动可用；列表 mp4 请求数为 0；未下完即可出画（可见 Range/分片，而非 blob 整包后再播）；过期可恢复；faststart 缺失时记录为缺陷并修 worker | 人工 + curl Range 抽检 |
| seed | 6 列解析；重复 id；未知模型；URL 失效；超大文件；断点续跑；重跑；翻译包缺行、字段不一致、孤儿行；xlsx hash 变化；超长 prompt（25,279 字）；HEAD 超时/404/无 Content-Length；缺 `--confirm-size`；报告 hash 与确认时不符 | 四类计数之和为 5,097；已剔除 ≥15；导入作品 `prompt_zh` 全部非空且不截断；xlsx/报告 hash 变化时拒绝执行；缺 `--confirm-size` 时在估算步骤后停止；超长 prompt 正常导入、不归为待修复；重跑无副作用；不产生扣费或返利 | 脚本 + 人工 |
| 自动优化关闭 | 视频提交请求带 `auto_optimize`；从图片切到视频 | 返回 400；视频设置里没有该开关；图片 auto_optimize 行为不变 | shared 测试 + 人工 |
| ffmpeg | 镜像内二进制缺失；损坏 mp4；抽帧超时 | 构建期断言失败；缺失时隐藏视频模型；损坏或超时时用占位封面并告警 | docker build + 测试 |
| 性能 | feed p95、工作室首屏、图片回归 | 达到 PRD R8 预算 | 人工 20 次采样 |
| 监控 | 各终态都上报事件；metrics 只用低基数 tag | Sentry 看板可见 | 人工 |

## 4. 本轮（规划）验证

只修改任务目录下的文档。检查内容：

- R1–R8 和 2.1–2.8 每一项都能映射到 design 和 task；
- JSON 能被正常解析；
- 引用的路径都存在。

产品命令不运行，原因是本轮没有产品代码变更。
