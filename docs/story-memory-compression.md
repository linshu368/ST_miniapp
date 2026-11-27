# 剧情记忆压缩：诊断与恢复

2026-11-27 更新：压缩改走 Surplus（DeepSeek V4.1 Flash 1017），**强制关思考（`reasoning.effort=none`）、只派给 mistral**（用户定；模型说明写明默认开、默认 high，不发时大块章节会想 3～4 万字；11-27 直连实测 mistral 与 DeepSeek 官方都能关，mistral 价格约 1/4），不设折扣底线、按速度排、价格带 1000%，流式请求；15 秒内没有任何输出就放弃本次（`first_output_timeout`，关思考后首字约等于读完 prompt 的时间，生产实测到 5.7 秒），总超时 240 秒、输出 token 12000（用户定；1.2 万字档案约 9000 token，偶发复读时早点作废）。压缩失败没有换家兜底，只靠退避重试（用户接受）。超长恢复：没超上限不干涉；超了才按 prompt 顺序逐板块轻压（见下文「有界恢复」，11-27 第二版），见下文「有界恢复」。任务 `11-27-story-memory-surplus`。

## 长度与限制

所有 `*_chars` 采用 `countChars`：去掉空白的 Unicode code point 数，不是 token 或 JS UTF-16 length。输出先去掉首尾代码围栏。日志不输出正文。

| 字段                                                       | 实际含义                                                                            |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `output_chars`                                             | 收到的完整或截断档案可测字数；没有可测正文则省略，不能把超时记成0字                 |
| `hard_max_chars`                                           | 本次运行读取的 `memory_max_chars`                                                   |
| `validation_max_chars`                                     | 真正执行校验的上限；预精简为硬上限85%，主阶段为硬上限本身                           |
| `target_chars`                                             | 实际提示词目标；并入85%，预精简65%，第二/三次精简80%/60%                            |
| `over_limit_chars`                                         | `max(0, output_chars-validation_max_chars)`                                         |
| `prompt_chars/history_chars/recent_chars/old_memory_chars` | 实际prompt/新历史/近期上下文/档案规模；纯精简不带历史和近期上下文，这两项记0        |
| `input_tokens/output_tokens`                               | 上游usage有效非负整数；未知省略，不由字数推算                                       |
| `max_output_tokens/finish_reason`                          | 请求token上限12000（已关思考，只装档案正文）与有限结束原因；只有stop可继续校验      |
| `response_bytes/max_response_bytes/timeout_ms/duration_ms` | 已读字节、16MiB上限（流式外壳+思考，只防失控）、240秒请求限制、调用至校验的实际耗时 |
| `first_output_ms/first_output_timeout_ms/reasoning_chars`  | 首段输出（思考也算）耗时、首字上限、思考字数（只计数，不保存）                      |
| `upstream_request_id`                                      | Surplus 请求号，去 Surplus 后台查单                                                 |

默认配置硬上限5000，生产可单独配置，排查使用日志实际值。例如预精简输出4400、硬上限5000、校验线4250时，真实超限是150字；不能用默认值推断生产限制。

## Railway 查询

按 `call_scene:job.story_memory` 或稳定event查询，使用同一 `trace_id/session_id` 关联；逐块带 `chunk_index/chunk_count/range_start/range_end`。`attempt`是本块主阶段1–3或预精简阶段1，`stage`区分pre_shrink/merge/shrink，`job_attempt`是领取时数据库失败次数加1。

- `story_memory.compression.completed`：调用与校验完成；outcome=succeeded才可提交，rejected不是成功。
- `story_memory.validation.rejected`：有限拒绝原因；检查三个限制及over_limit_chars，中间warn可能被后续精简恢复。
- `story_memory.compression.failed`：HTTP/超时/坏响应/截断等；区分供应商http_403与本地too_long。
- `story_memory.job.finished`：任务收尾、failure_count与已提交chunk_count/range_end；target_end是期望目标。finish失败/lease_lost为unknown，不宣称成功；HTTP200不证明业务提交成功。

原始err经现有Pino安全序列化；新增字段为精确标量白名单，无新日志表/查询。禁止prompt、档案、响应正文、昵称、秘密凭据进入字段或错误。

## 有界恢复

用户 2026-11-27 定的原则（第二版。第一版按位置选到了生产 prompt 的亲密板块、一次压到 1/5～1/14，2 个会话已回退）：

1. **没超上限就不干涉**（`stage=merge`）：并入结果不超过 `memory_max_chars` 就直接用，只做原有基本校验（板块齐全、无思考、非空、原有的整体缩水保护）。告诉模型的目标仍是上限的 85%。
2. **超了才压，只压超出的部分**（`stage=section_shrink`）：
   - 按生产 prompt 规定的顺序逐个板块压，每压一个就检查，回到上限以内就停。顺序按标题关键词找，不按位置：「主线」→「世界观 / 存疑」→「人物」。
   - 每个板块的目标 = max(原来的 60%，原来 − 超出量)。
   - 模型返回出现以下情况就作废、保留原样、继续下一个：少于原来一半、混进其他板块标题、丢了或改了伏笔 / 谜团 / 誓言 / 承诺 / 约定 / 仇怨 / 期限 / 长期任务 / 带「·用户」的条目。
3. **永远不动**：标题含「亲密」「偏好」「要求」的板块。**不由程序删条目。**
4. 可压的板块都压过仍超，按 too_long 失败，等下一轮再试（退避 ≤ 1 小时）。生产上限已提到 12000（配置 v5，契约上限）。
5. 并入因其他原因不合格（缺板块、含思考等）→ 带原因再并入一次；这次超长同样走第 2 步。

一块最多 4 次模型调用：并入 1 次，加上最多 3 个板块精简。

worker每轮最多处理三条，每次只claim马上执行的一条，上一条finish后再claim下一条。模型仍串行；每块成功commit续租15分钟并确认覆盖。后续失败不丢已提交块，下次从数据库覆盖终点继续；未知commit/finish不自动重试写入。

数据库退避 2、4、8、16、32 分钟后封顶 60 分钟（`20261127_story_memory_retry_cap.sql`），连续第三次失败告警不变。强制截断不会让压缩停下：截断会抬高压缩目标，压缩按轮次从数据库读、不依赖窗口，成功后截掉的章节会补进档案。

## 验证与发布

本地回归覆盖实际Pino JSON、真实验收线、有限精简、坏候选保留、截断、静止body取消、逐条领取、部分提交/恢复和finish未知。真实供应商内容质量、多副本/数据库退避、Android/iOS P95不能由mock证明。

发布后同模型/prompt和配置分组对比前后各24小时：最终拒绝率（必须有分母）、超限分布、每成功块调用数/tokens/耗时、覆盖推进、积压和lease_lost；双端与聊天API独立观察，无样本不补零。连续三个任务不推进、lease_lost增加或成本/延迟明显上升时停止扩大并复核。回滚Backend应用，保留已提交档案、原租约/CAS与数据库退避，不回写历史版本。

建议长期验收复用 `packages/ui-tests` 的 `@chat` 固定场景，覆盖记忆就绪、失败仍使用旧版；本轮没有改UI或启动浏览器，模拟不能代替真实模型和跨副本验证。
