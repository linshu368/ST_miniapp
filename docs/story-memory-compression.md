# 剧情记忆压缩：诊断与恢复

2026-11-27 更新：压缩改走 Surplus（DeepSeek V4.1 Flash 1017，路由同畅聊兜底：不设折扣底线、优先 mistral、按速度排、价格带 1000%），流式请求；6 秒内没有任何输出（思考也算）就放弃本次（`first_output_timeout`），总超时 120 秒不变。超长恢复改为「只精简第一个板块 → 程序删最早条目」，见下文「有界恢复」。任务 `11-27-story-memory-surplus`。

## 长度与限制

所有 `*_chars` 采用 `countChars`：去掉空白的 Unicode code point 数，不是 token 或 JS UTF-16 length。输出先去掉首尾代码围栏。日志不输出正文。

| 字段                                                       | 实际含义                                                                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `output_chars`                                             | 收到的完整或截断档案可测字数；没有可测正文则省略，不能把超时记成0字          |
| `hard_max_chars`                                           | 本次运行读取的 `memory_max_chars`                                            |
| `validation_max_chars`                                     | 真正执行校验的上限；预精简为硬上限85%，主阶段为硬上限本身                    |
| `target_chars`                                             | 实际提示词目标；并入85%，预精简65%，第二/三次精简80%/60%                     |
| `over_limit_chars`                                         | `max(0, output_chars-validation_max_chars)`                                  |
| `prompt_chars/history_chars/recent_chars/old_memory_chars` | 实际prompt/新历史/近期上下文/档案规模；纯精简不带历史和近期上下文，这两项记0 |
| `input_tokens/output_tokens`                               | 上游usage有效非负整数；未知省略，不由字数推算                                |
| `max_output_tokens/finish_reason`                          | 请求token上限24000（思考也占输出token）与有限结束原因；只有stop可继续校验    |
| `response_bytes/max_response_bytes/timeout_ms/duration_ms` | 已读字节、1MiB上限（流式）、120秒请求限制、调用至校验的实际耗时              |
| `first_output_ms/first_output_timeout_ms/reasoning_chars`  | 首段输出（思考也算）耗时、首字上限、思考字数（只计数，不保存）               |
| `upstream_request_id`                                      | Surplus 请求号，去 Surplus 后台查单                                          |

默认配置硬上限5000，生产可单独配置，排查使用日志实际值。例如预精简输出4400、硬上限5000、校验线4250时，真实超限是150字；不能用默认值推断生产限制。

## Railway 查询

按 `call_scene:job.story_memory` 或稳定event查询，使用同一 `trace_id/session_id` 关联；逐块带 `chunk_index/chunk_count/range_start/range_end`。`attempt`是本块主阶段1–3或预精简阶段1，`stage`区分pre_shrink/merge/shrink，`job_attempt`是领取时数据库失败次数加1。

- `story_memory.compression.completed`：调用与校验完成；outcome=succeeded才可提交，rejected不是成功。
- `story_memory.validation.rejected`：有限拒绝原因；检查三个限制及over_limit_chars，中间warn可能被后续精简恢复。
- `story_memory.compression.failed`：HTTP/超时/坏响应/截断等；区分供应商http_403与本地too_long。
- `story_memory.job.finished`：任务收尾、failure_count与已提交chunk_count/range_end；target_end是期望目标。finish失败/lease_lost为unknown，不宣称成功；HTTP200不证明业务提交成功。

原始err经现有Pino安全序列化；新增字段为精确标量白名单，无新日志表/查询。禁止prompt、档案、响应正文、昵称、秘密凭据进入字段或错误。

## 有界恢复

一块最多 2 次模型调用：

1. **并入**（`stage=merge`）：目标 85% 硬上限，校验线是硬上限本身。
2. 并入超长 → **只精简第一个板块**（`stage=section_shrink`，默认 prompt 里是「一、故事主线」）：把这一个板块单独交给模型，目标是压到一半，且至少压掉超出部分；结果拼回原位后整份校验。模型返回里混进其他板块标题时视为不可用。
3. 仍超长 → **程序删条目**（`stage=trim`，不调模型）：在第一个板块里按每行最早的 T 编号从旧到新删整行，直到不超过硬上限（日志 `trimmed_line_count`）。删光了还超，说明其他板块本身就超，记 too_long。
4. 并入因其他原因不合格（缺板块、含思考等）→ 带原因再并入一次；这次超长就直接删条目。

其余六个板块不会被程序改动。不再做预精简和整份精简：2026-11-27 生产数据里整份交给模型「缩到 X 字」几乎原样返回（212 次成功 7 次），档案写满后每次重试都必然失败。

worker每轮最多处理三条，每次只claim马上执行的一条，上一条finish后再claim下一条。模型仍串行；每块成功commit续租15分钟并确认覆盖。后续失败不丢已提交块，下次从数据库覆盖终点继续；未知commit/finish不自动重试写入。

数据库退避 2、4、8、16、32 分钟后封顶 60 分钟（`20261127_story_memory_retry_cap.sql`），连续第三次失败告警不变。强制截断不会让压缩停下：截断会抬高压缩目标，压缩按轮次从数据库读、不依赖窗口，成功后截掉的章节会补进档案。

## 验证与发布

本地回归覆盖实际Pino JSON、真实验收线、有限精简、坏候选保留、截断、静止body取消、逐条领取、部分提交/恢复和finish未知。真实供应商内容质量、多副本/数据库退避、Android/iOS P95不能由mock证明。

发布后同模型/prompt和配置分组对比前后各24小时：最终拒绝率（必须有分母）、超限分布、每成功块调用数/tokens/耗时、覆盖推进、积压和lease_lost；双端与聊天API独立观察，无样本不补零。连续三个任务不推进、lease_lost增加或成本/延迟明显上升时停止扩大并复核。回滚Backend应用，保留已提交档案、原租约/CAS与数据库退避，不回写历史版本。

建议长期验收复用 `packages/ui-tests` 的 `@chat` 固定场景，覆盖记忆就绪、失败仍使用旧版；本轮没有改UI或启动浏览器，模拟不能代替真实模型和跨副本验证。
