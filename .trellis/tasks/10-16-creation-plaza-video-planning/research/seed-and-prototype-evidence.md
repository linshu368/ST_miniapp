# 种子表与原型证据（2026-10-24 只读采集）

## xlsx

- 路径：`g:/JobWork/ST/civitai_venice_nsfw_videos.xlsx`，2,666,134 字节，SHA-256 `2d6359af28833109b1e216d4189b9fc3cece7b2ba359f42a1d3161a9d8b1159d`。
  - 这与旧规划中 `D:/JobExe/ST/翻译包/...` 的文件（7 列、含 prompt_zh、SHA `cbbd1d...`）**不是同一个文件**。
- 读取方式：用 backend 已有的 `xlsx` 依赖只读解析。没有访问任何 URL，也没有下载媒体。
- 只有 `Data` 一个 sheet，共 5,097 行，**6 列**，各列均非空：
  - `Venice 模型`（5097）
  - `正向提示词`（5097）
  - `Video URL`（5097）
  - `Civitai Video ID（内部续爬去重）`（5097，全部唯一）
  - `热度（Like + Heart）`（5097，min 11 / 中位 93 / max 4086）
  - `可能的垫图列表`（901）
- **没有 `prompt_zh` 列**。正向提示词中有 143 条本身就含中文，其余为英文。中文来源见下方“翻译包 video.xlsx”（PRD D11）。
- 提示词长度：879 条超过 2,000 字，最长 25,279 字。用户确认视频不设字数上限（PRD D14），这些行正常导入，不隔离、不截断。

## 翻译包 video.xlsx（2026-10-24 只读对照，PRD D11）

- 路径：`G:/JobWork/ST/图片广场-全量翻译_1015/翻译包/video.xlsx`，4,912,517 字节，SHA-256 `ce3b2c896be51e53acbb88c01cd7b96ec362859c44e871efd83e3a48e4bb0b8d`。
- 只有 `Sheet1` 一个 sheet，共 5,082 行，6 列且全部非空：`type`（全部为 video）、`id`、`model`、`heat`、`prompt_en`、`prompt_zh`。
- `id` 的格式是 `xG1nkqKTMzGDvpLrqFT7WA/<uuid>/original=true/<uuid>.mp4`，等于原表 `Video URL` 去掉 `https://image.civitai.com/` 后的部分。全部唯一。
- 对照结果（用 backend 的 `xlsx` 依赖做本地只读计算；不访问 URL，不写 DB）：
  - 原表 5,097 条中，命中 5,082 条；翻译包中没有孤儿行。
  - 命中行的 `model` 与原表一致（不一致 0 条），`heat` 也一致（不一致 0 条）。
  - `prompt_en` 去除空白差异后与原表正向提示词全部一致（5,082/5,082）。按原文直接比较时有 2,686 条不同，全部是空白字符差异。
  - `prompt_zh` 全部含中文；有 47 条与 `prompt_en` 相同，这些是原文本身就是中文的行。
  - 中文超过 2,000 字的有 129 条，最长 10,604 字。同样不设上限（PRD D14）。
  - 未命中的 15 条，按模型分布：Wan 3.0 Pro 3、Seedance 2.0 R2V Enhanced 4、MiniMax H3 Max 5、MiniMax H3 Max R2V 3。与原型“视频 5097→5082”的涉未成年剔除相符，导入时归为「已剔除」。
- 翻译包中各模型条数：Wan 3.0 Pro 1877、MiniMax H3 Max R2V 1109、MiniMax H3 Max 711、Seedance 2.0 R2V Enhanced 682、Seedance 1.5 Pro 583、Wan 3.0 Reference 120。
- 模型分布：

  | 模型 | 条数 |
  | --- | --- |
  | Wan 3.0 Pro | 1880 |
  | MiniMax H3 Max R2V | 1112 |
  | MiniMax H3 Max | 716 |
  | Seedance 2.0 R2V Enhanced | 686 |
  | Seedance 1.5 Pro | 583 |
  | Wan 3.0 Reference | 120 |

- 候选垫图列是 `orchestration.civitai.com/...jpg?sig=...` 形式的签名 URL，很可能已经过期；只作为来源元数据保存，**不在日志里输出**。
- 原型总览记录了 27 条“涉未成年”剔除（图+视频合计；视频 5097→5082）。导入时必须加审核门禁，不能全量公开。
- 表里没有时长、分辨率、封面列，这些需要在导入时用 ffprobe 探测，封面用 ffmpeg 抽首帧。

## 原型（只作交互参考）

`G:/JobWork/ST/图片广场原型-总包_1022/图片广场原型-总包_1022/05-单文件应用版/`，效果截图如下：

- **广场-手机.png**：
  - 顶部标题“图片广场”，右侧“去创作”
  - 搜索框
  - 「全部 / 图片 / 视频」分段控件
  - 标签横滑（不限、制服扮演 22、体位玩法 27…），右侧固定「全部风格 ▾」
  - 双列卡片：视频卡左上角显示时长 0:05，中央有播放图标；底部为描述两行、♥ 计数、“模型 · 男女”、「用同款」
- **视频模型弹层.png**：底部 Sheet“选择视频模型”，列出 6 个模型（名称 + 类型副标题），当前项打勾。
- **视频配置面板.png**：设置 Sheet，包含时长（5 秒）、画面比例（Landscape 16:9）、清晰度（720P）、生成声音（开）、自动优化提示词（开），右上角“重置”。会话内结果下方是 5 个图标按钮：重新生成、复制、下载、视频、分享。

约束（用户需求 4）：原型的**广场顶部按钮、会话内操作按钮、弹窗样式**都不照搬，沿用现有 `create/page.tsx`、`studio-artifact-card.tsx`、`studio-settings-dialog.tsx` 的样式；只借鉴信息结构。

原型总览列出的已知限制：

- 视频生成是假的。
- `ImagePlazaWork` 没有 media_type。
- 封面靠 ffmpeg 抽首帧。
- civitai 中转不支持 Range。

这些都需要在本任务中补齐。

## 代码现状要点（2026-10-24，分支 feat_video_park）

- 后端 Docker 运行镜像（`node:20-bookworm-slim`，`ops/docker/Dockerfile.backend` 第 116、121 行）只安装了 `tini wget openssl`，**没有 ffmpeg**。用户已确认加装（PRD D10）。
- `DOMAIN_SCHEMAS` 是八域常量（`packages/backend/src/lib/supabase.ts`），新增 schema 需要：
  - 扩展这个常量
  - 修改 PostgREST 暴露列表（`ops/schema-split/postgrest-expose-{test,prod}.sql`）
- 图片 worker（`features/image-plaza/job.ts`）是同步调用 + DB 租约模式，每次 tick 处理 2 个任务。`settle_image_plaza_generation` 采用成功后扣费，余额不足时把任务标记为 failed。
- 前端 `useImagePlazaFeedQuery(search, tag, sort)` 只支持单个 tag。标签匹配规则是 `snapshot->>prompt_zh ILIKE %label%`。
- `action-tracker.ts` 中的 `TrackedAction` 已包含 `image_generate`、`create_conversation`。
