# 图片广场初始数据审计（2026-10-13）

> 本文只记录聚合统计、字段映射与实施门禁，不包含原始提示词、完整图片 URL 或业务行导出。本轮仅补充规划，不修改产品代码、migration 或数据库数据。

## 1. 输入与可追溯性

- 需求说明：`D:/download/图片广场的图片.md`。
- 数据文件：`D:/download/图片和附件/civitai_venice_nsfw_combined.xlsx`。
- 补充过程会话：`https://chatgpt.com/s/cx_6abcc568631c819192e598a07707a031`。
- 共享会话当前只能取得标题，正文未能通过可用浏览器/网页读取能力访问；以下结论不把不可见会话内容当作已核验事实。实施前如会话含额外筛选、授权或抓取规则，须补录到本文并重新审查。

`图片广场的图片.md` 明确：前台核心展示图片、Venice 模型和正向提示词；Image URL、Civitai Image ID、热度属于内部字段；“用同款”复用模型和正向提示词；生产应把图片转存到自有存储，不依赖 Civitai 热链。

## 2. 工作簿只读审计

### 2.1 结构与完整性

| 项目             | 结果                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------- |
| 工作表           | `Data`（唯一可见工作表）                                                                             |
| 数据行           | 8,227（不含表头）                                                                                    |
| 字段             | `Venice 模型`、`正向提示词`、`Image URL`、`Civitai Image ID（内部续爬去重）`、`热度（Like + Heart）` |
| 缺失值           | 0                                                                                                    |
| Civitai Image ID | 全部为数字文本，8,227 个唯一值                                                                       |
| Image URL        | 全部为 HTTPS `image.civitai.com`，8,227 个唯一值                                                     |
| 热度             | 全部为非负整数；min=10、P50=39、P90=125、P95=194、P99=403、max=1559                                  |
| 提示词           | 长度 7–5,648；3,817 条含换行；存在 857 个重复提示词，但完整记录/ID/URL 均唯一                        |

模型分布：

| Excel 名称      | 业务模型 ID       | 上游模型 ID       |  行数 |
| --------------- | ----------------- | ----------------- | ----: |
| Seedream V5 Pro | `seedream-v5-pro` | `seedream-v5-pro` |   593 |
| Krea 2 Turbo    | `krea-2-turbo`    | `krea-2-turbo`    |   999 |
| Chroma          | `chroma`          | `chroma`          |   963 |
| Lustify v8      | `lustify-v8`      | `lustify-v8`      |   172 |
| Lustify SDXL    | `lustify-sdxl`    | `lustify-sdxl`    | 1,000 |
| Anime (WAI)     | `anime-wai`       | `wai-Illustrious` | 4,500 |

### 2.2 提示词兼容性

当前实现的 shared schema、数据库 attempt/message、前端输入框均限制 600 字；工作簿有 3,458 条超过 600 字。2026-10-13 用户最终修订为全链路统一 **2,000 字**：

| 口径                        | 可通过 | 需隔离 | 覆盖率 |
| --------------------------- | -----: | -----: | -----: |
| 当前 600 字                 |  4,769 |  3,458 |  58.0% |
| 中间决策 1,000 字（已废止） |  6,742 |  1,485 |  82.0% |
| 最终全链路 2,000 字         |  8,054 |    173 |  97.9% |

结论：在图片、来源、内容和上游 canary 检查之外，8,054 条可保留完整来源提示词继续导入；超过 2,000 字的 173 条不得静默截断，应进入隔离清单。由于部分模型公开 prompt 上限可能低于 2,000，本地长度通过记录仍须按模型实测；上游拒绝项继续隔离。

### 2.3 图片格式与容量抽样

- URL 路径虽均以 `.jpeg` 结尾，但按模型抽样可见实际响应包含 JPEG、PNG、WebP；导入必须按响应字节识别 MIME/尺寸，不能信任 URL 扩展名。
- 分层 HEAD 抽样 60 条均成功：JPEG 19、PNG 39、WebP 2。
- 抽样文件大小约 0.09–16.09 MiB，P50 约 1.50 MiB，均未超过当前 20 MiB 单图限制。
- 按抽样均值粗估，直接保存 8,227 张原图约需 19.4 GiB；这是容量估算而非完整下载结果。

导入前必须全量执行响应状态、最终主机、实际 MIME、文件字节、像素尺寸和解码检查，并决定是否把长边限制到 2,048 px、统一转 WebP。不得仅凭本次样本宣告全量可导入。

## 3. 当前实现差距

1. `experience.image_plaza_works.user_id/attempt_id/artifact_id` 与 `experience.image_plaza_artifacts.attempt_id` 面向用户生成链路且为必填；直接导入会迫使系统伪造用户、会话、报价、attempt 和账务事实。
2. 当前作品快照的 prompt 上限为 600；调整到 2,000 后可新增承载 3,285 条，仍有 173 条因本地长度超限需要隔离。
3. Studio 提交固定 `auto_optimize=true`，不保证“用同款”按来源正向提示词原样生成。
4. 当前 `like_count` 由本地点赞表重算；把来源热度写入 `like_count` 会在首次本地点赞时被覆盖。
5. 当前 Storage 路径只允许用户/attempt 路径；初始数据需要独立、可幂等的内部导入路径。
6. 当前 feed 按 `published_at,id` 游标排序；初始热度排序需要稳定物化，不能在翻页过程中动态改写游标依据。

## 4. 最小字段与不变量方案

复用现有 works/artifacts/feed/detail/like/use-same 链路，不另建第二套公开 feed 表。建议用新 migration 扩展既有表；不得改写或向已执行的基础 migration 追加初始数据。

### 4.1 `experience.image_plaza_works`

- `origin`: `generated | civitai_seed`，默认 `generated`。
- `source_platform`: 初始数据固定 `civitai`，仅内部使用。
- `source_image_id TEXT`: 保存 Civitai Image ID；`civitai_seed` 范围唯一；不出现在公开 DTO、日志、标题或 UI。
- `source_image_url TEXT`: 仅供导入审计/重试；不出现在公开 DTO。
- `source_heat INTEGER`: 非负、仅用于初始排序/运营；不得写入或混入本地 `like_count`。
- generated：必须有真实 `user_id`、`attempt_id`；不得有 source 字段。
- civitai_seed：`user_id`、`attempt_id` 为空，必须有 source ID/URL/heat 和有效 artifact；不得产生账务、返利或“首次分享”事实。

### 4.2 `experience.image_plaza_artifacts`

- seed artifact 允许 `attempt_id` 为空，但必须由 seed work 引用并满足来源约束。
- 使用确定性内部路径，例如 `image-plaza/imports/civitai/{source_image_id}.{sniffed_ext}`；上传禁止覆盖已有对象。
- 公共签名 URL 始终从自有 Storage 生成，不向前端返回 Civitai URL。

### 4.3 作品快照

- 模型：严格按 2.1 映射，导入时校验模型已发布且可用。
- prompt：保留原始正向提示词；Frontend textarea、shared DTO、snapshot/attempt/message、Backend、数据库和模型调用统一最多 2,000 字；超过 2,000 字的记录不进入作品表。
- `mode=t2i`、`reference_artifact_id=null`、`reasoning=false`、`auto_optimize=false`、`style=None`。
- aspect ratio 从实际图片尺寸映射到模型支持的最近比例；resolution 使用该模型已发布的安全默认档。
- 标题不得带 Civitai ID；源文件没有标签，默认 `tags=[]`，不自动臆造。

“用同款”只恢复模型、正向提示词及生成参数，不把来源图片作为参考图。不超过 2,000 字的提示词完整恢复到 Frontend textarea，可编辑并原样提交；若模型下架、上游拒绝或参数不再受支持，明确提示并禁止静默换模/截断。

## 5. 导入流程与可靠性

采用一次性离线 importer，不在 migration 中嵌入 8,227 行数据，也不由在线请求即时热链下载。

1. **dry-run**：校验精确表头、必填字段、模型白名单、唯一 ID/URL、HTTPS 主机、热度、提示词不超过 2,000 字；长度阶段预期 8,054 条通过、173 条隔离，并生成仅含 ID/状态/原因的结果清单。
2. **来源与内容门禁**：取得来源使用授权/归属证据和审核后的 allowlist；文件名及样本表明数据包含成人内容，须排除未成年人或年龄模糊、真实人物/深度伪造、非自愿及违法内容。未完成门禁则停止，不上传、不写库。
3. **元数据核验**：匿名 Civitai API 对 NSFW 样本可能返回空结果，实施时使用经批准的访问方式核验 image ID、NSFW/browsing level、尺寸及可追溯来源；缺失或删除项进入隔离。
4. **下载/转存**：显式超时、有限退避重试、并发/速率限制；限制重定向和最终主机以防 SSRF；流式限制 20 MiB、8,192 px；按字节识别格式并解码。
5. **写入**：先以确定性路径 `upsert=false` 上传；随后以单条/小批事务写 artifact+work；`source_image_id` 唯一约束保证重复执行幂等。
6. **排序**：首次导入按 `source_heat DESC, source_image_id` 物化稳定 `published_at`，保留现有游标；后续重跑不改已有 `published_at`。新 UGC 自然排在初始数据之前。
7. **补偿**：DB 失败时删除本次新上传对象；删除失败登记 orphan 清单供 reconciliation。日志只记批次、source ID、状态、计数、耗时和错误，不记录提示词、完整源 URL、token 或图片正文。
8. **发布**：test 环境先跑基础 migration → 兼容 migration → dry-run → 小批 canary → feed/详情/同款/点赞验证 → 分批全量。production 另行授权。

## 6. 停止条件、回滚与验收

停止导入：来源授权/内容审核未完成；Civitai 元数据不可核验；模型映射或 prompt cap 缺失；下载失败率或格式异常率超批准阈值；详情/同款出现契约错误；容量超预算。

回滚优先软删除 `origin=civitai_seed` 的作品，生成型 UGC、账务和本地点赞不受影响；确认无引用后再清理对应 Storage。兼容 schema 采用 forward-fix，不回写历史基础 migration。

必须验证：重复运行、断点续跑、部分上传/写库失败、源图删除、MIME 与扩展名不一致、超大图、模型下架、provider 拒绝超限 prompt、签名 URL、详情完整展示、用同款不自动改写、本地点赞不覆盖 source heat、公开响应与日志不泄露 source ID/URL、来源撤回后的定向下架。

### 6.1 已实现的离线命令

- dry-run（默认不连接数据库、不上传）：`pnpm --filter @miniapp/backend image-plaza:seed -- --input <xlsx>`。
- apply 必须额外提供 `--apply --manifest <审核清单> --target test|production --limit 1..500 --confirm-original-storage`；通过 `--offset` 分批和断点续跑，可用 `--concurrency 1..8` 设置同一进程内的有界并发，默认 1。
- production 还必须显式提供 `--confirm-production`，且 CLI 目标必须与 Backend 已解析的数据库环境一致。
- 审核清单格式见 `seed-approval-manifest.example.json`。批次必须注明审核批次号和内容政策版本；每条必须同时确认来源权利、内容审核和元数据核验，并记录审核人、UTC 审核时间、权利证据引用和元数据证据引用；示例 ID 不可用于真实导入。
- importer 保持单进程，内部并发显式限制为 1–8；源 URL 固定为 `image.civitai.com`，每条下载最多三次、每次 30 秒、最多三次重定向，逐跳主机只允许 Civitai 精确白名单 `image.civitai.com`、`blobs-b2.civitai.com`，响应流上限 20 MiB。需要代理时显式使用 HTTPS ProxyAgent，TLS 校验被关闭时拒绝执行。不要并行运行多个 importer 实例；提高并发前必须先用小批次验证当前网络、内存、Storage 和数据库容量。test 容量验证表明 16 并发会增加超时/TLS 中断，故运行上限保持 8。
- test/production apply 前必须先手动执行并验证 `packages/shared/migrations/20261013_image_plaza_seed_catalog.sql`。当前会话只完成本地 dry-run，未写数据库或 Storage。

## 7. 外部依据

- Venice 原生图片生成接口：prompt 总体 1–7,500 字符，并提示同时受模型约束：<https://docs.venice.ai/api-reference/endpoint/image/generate>
- 模型上限以 Venice 官方模型页为准：[Seedream V5 Pro](https://venice.ai/models/seedream-v5-pro)、[Krea 2 Turbo](https://venice.ai/models/krea-2-turbo)、[Chroma](https://venice.ai/models/chroma)、[Lustify v8](https://venice.ai/models/lustify-v8)、[Lustify SDXL](https://venice.ai/models/lustify-sdxl)、[Anime (WAI)](https://venice.ai/models/wai-illustrious)；实施时应在导入当天重新获取并固化到已发布模型配置。
- Civitai 官方开发者文档说明图片 API 可按 `imageId` 查询并返回 NSFW、浏览级别、尺寸、meta 和 model version 等字段：<https://github.com/civitai/civitai-developer-docs/blob/main/site/reference/images.md>
