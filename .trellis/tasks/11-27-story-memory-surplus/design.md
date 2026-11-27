# 设计：长期记忆压缩改走 Surplus，止住重复压缩

D1、D2 已由用户 11-27 确认（见 prd「已定」）。

## 1. 复用调研

| 检索对象                                                                                  | 结论                                                                                                                                        |
| ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `generation/upstream.ts` `resolveProviderUpstream('surplus')` / `forwardToUpstream`       | **复用**。Surplus 的 key、地址、统一屏蔽 dashscope-cn、默认路由头都在这里。                                                                 |
| `generation/surplus-route.ts` `SurplusRoute` / `surplusRouteBody` / `surplusRouteHeaders` | **复用**。记忆的路由按畅聊兜底的写法拼（`freeZoneFallbackRoute` 的同款字段），不另写头。                                                    |
| `generation/upstream.ts` `createSseTap`                                                   | **复用**解析流式响应：content 与 reasoning 分开累积，有 finish_reason、usage、流内错误块（Surplus 断流会先发错误块再发 [DONE]）。           |
| `generation/surplus-reasoning.ts`                                                         | **不复用**。mistral 在严格名单里，不收 reasoning 字段；DeepSeek 1017 在 Surplus 上关不掉思考（11-27 已实测）。记忆请求不带 reasoning 参数。 |
| `free_zone_config.fallback`                                                               | **不直接读**。prd 约束：记忆配置各存一份，切换时取值相同。                                                                                  |
| `story-memory/compress-chunk.ts`、`compression-attempt.ts`、`validate.ts`                 | **扩展**。校验规则不变，只改尝试序列（见 §4）。                                                                                             |
| `story_memory_jobs` 退避、`advance_story_memory_window` 重试守卫（生产已生效）            | **不改**。不需要迁移。                                                                                                                      |
| `ops.llm_calls`                                                                           | 记忆压缩一直没进台账，这次也不进（不在范围内；要算成本另开任务）。                                                                          |

## 2. 配置契约（`packages/shared/src/api/story-memory.ts`）

`StoryMemoryConfigSchema` 改动：

- `model_id`：含义改为 **Surplus 模型名**，默认 `deepseek-v4.1-flash-1017`。
- 删掉 `preferred_providers`（OpenRouter 的供应商顺序）。
- 新增：
  - `preferred_provider: string | null`，默认 `mistral`（Surplus provider_order，只排序、不限定）；
  - `route_objective: 'latency' | 'reliability'`，默认 `latency`（复用 `SurplusRouteObjectiveSchema`）；
  - `price_tolerance_pct: int 0–10000`，默认 1000；
  - `first_output_timeout_ms: int 1000–60000`，默认 6000（D1）。
- **兼容旧值**：用 `z.preprocess` 识别旧形状，判断依据是带了 `preferred_providers`：
  - 去掉 `preferred_providers`；
  - `model_id` 换成新默认的 Surplus 模型名；
  - 新字段取默认值。

  这样生产 v3 不会因为 strict 校验失败而回落到代码默认值（上限 5000）。发布后用 CLI 把生产配置改成新形状（§6），之后这段兼容代码可以删。

- `DEFAULT_STORY_MEMORY_CONFIG` 同步。

消费方：

- `admin-client/configSchemas.ts`（自动跟 schema）；
- `admin/StoryMemoryEditors.tsx`：供应商多选框换成 4 个字段（优先供应商、路由方式、价格带、首字上限）；
- `backend/scripts/story-memory-replay.ts`：调用签名跟着改。

## 3. 压缩调用（`generation/story-memory-compress.ts`）

- 平台改为 `surplus`，请求由「非流式」改为**流式**（D1 需要知道第一段输出什么时候到）。
- 请求：
  - body：`{ model, stream: true, temperature, max_tokens, messages, ...surplusRouteBody(route) }`；
  - 头：`surplusRouteHeaders(route)`。route 由配置拼：不设 `minDiscountPct`，`providerOrder=[preferred_provider]`，`objective`，`tolerancePct`。
  - 不带 reasoning 参数。
- 首字：第一段 content 或 reasoning 到达前开 `first_output_timeout_ms` 计时，超时就 abort，错误码 `first_output_timeout`（区别于总超时 `timeout`）。思考算输出，跟聊天口径一致。
- 总超时仍 120 秒。
- `max_tokens`：12000 → 24000。带思考后思考也占输出 token，12000 可能被思考吃掉、导致 `length` 截断。档案上限 8000 字约 6000 token，24000 足够。
- 只拿 content 当档案，reasoning 只计字数（日志 `reasoning_chars`），不保存、不输出。
- 响应上限：已读字节上限 256 KiB → 1 MiB（流式外壳加上思考，体积变大；仍有上限防失控）。
- `finish_reason` 必须是 `stop`，流内错误块或没见到 [DONE] 都算 `incomplete`，规则不变。
- 记录 Surplus 请求号（`x-si-request-id`，没有就读 `x-request-id`），只进日志，方便去 Surplus 后台查单。

## 4. 尝试序列（D2，`story-memory/compress-chunk.ts`）

现状：预精简（档案 > 85% 时，1 次）→ 并入（1 次）→ 整份精简（2 次），一块最多 4 次调用。生产数据里预精简成功 2/117，整份精简成功 7/212，基本白花。

改为：

1. **并入**（1 次调用）：不变。
2. 超限后**只精简「一、故事主线」**（1 次调用）：按 `## ` 标题把候选档案切成板块，第一个板块（运营改名也跟着走）连同目标字数（压到一半）单独发给模型，返回后拼回原位，再走完整校验。
3. 还超限就**程序删条目**（0 次调用）：在第一个板块里，按每行的 T 编号从旧到新删整行，直到全文不超过上限。
   - 只删带 (T…) 的条目行，不删标题；
   - 删完还超，说明其他板块本身就超了，按现在一样记 too_long 失败；
   - 日志记删了几行。
4. 去掉预精简。上一步保证了档案不会超过上限，预精简的「腾地方」由第 2、3 步兜底。

一块最多 2 次模型调用（原来 4 次）。其余六个板块不会被程序改动。

## 5. 可靠性

- **超时**：首字 6 秒、总 120 秒，都有 abort；流读取沿用「信号中断时同时 reject」的写法，防止卡死的 body 不响应 abort。
- **重试**：不新增重试，失败交给现有任务退避（2/4/8/16 分钟……，失败中的任务不被新消息清零）。首字超时也走这条，下一次 Surplus 会重新选卖家。
- **幂等与并发**：不变（租约 + `commit_story_memory_version` 的 CAS），删条目在内存里做，提交前照常校验。
- **降级**：任一步失败，旧档案原样保留。
- **容量**：每块调用从最多 4 次降到 2 次，Surplus 价格比 OpenRouter 低，总成本下降。
- **可观测**：见 task.json 的 `meta.logging_integration`。另把 `story_memory.window.planned` 现在被白名单剥掉的字段放出来（fromStart / toStart / targetEnd / coveredEndTurn / totalChars / removedTurns / removedChars / floorBinding），以后能直接从日志算出强制截断留下的空档。

## 6. 发布与恢复

1. PR → dev，development 环境（连 TEST 库）手动跑一次压缩任务，看日志 provider=surplus、首字耗时、档案提交。
2. release → main → Railway 部署（兼容 v3，部署后立刻生效：模型自动换成 Surplus 默认值）。
3. 用 CLI 把生产 `story_memory_config` 发布成新形状：
   - 去掉 `preferred_providers`；
   - `model_id` 改为 `deepseek-v4.1-flash-1017`；
   - 加上 4 个新字段；
   - 其余参数（上限 8000、保底 12 轮、分块 20000 等）不动。

   这一步先给用户看差异，用户同意后再发布。

4. **重新排队卡住的任务**：数据迁移 `20261127_story_memory_retry_cap.sql`，经 db-migrate 工作流先 TEST 后生产，只在新后端部署成功之后执行。
   - 对象：`experience.story_memory_jobs` 里 status 为 pending / failed、last_error 不为空、未删除会话的行。
   - 改法：attempts 清零，next_attempt_at = now()，last_error = NULL，status = pending。running 的行不动。
   - 守卫：要求 `advance_story_memory_window` 已是重试守卫版本（md5 998d73…）。
   - 记录前后行数，不改结构，不需要回滚（最坏情况只是多跑一轮压缩）。
   - 同一迁移里把 `finish_story_memory_job` 的退避封顶 60 分钟（2、4、8、16、32、60…）。用户关心容错：强制截断后压缩不会停，失败只会推迟；封顶后，原因修好时卡住的会话最多一小时内恢复。顺带修掉 attempts ≥ 31 时 power 溢出 integer、收尾报错的潜在问题。
   - 本地 PG17：`bash scripts/test-story-memory-migration.sh`，覆盖重新排队、不动 running、已删会话和正常任务、退避序列、大 attempts 不溢出、重跑跳过。
5. 观察 24 小时，按 prd 验收。

- **回滚**：先在运营平台把配置恢复成 v3 的形状，再回滚后端。旧代码读不了新形状，会回落到默认上限 5000，顺序不能反。没有迁移，不涉及数据库回滚。
- **停止条件**：首字超时超过任务数的 30%，或 Surplus 侧连续报错导致没有任何任务成功，就先把首字上限调到 15 秒（只改配置）；仍不行回滚。

## 7. 前后台互不拖累（用户要求）

现状已经是并行的，这次不改结构，只确认、不退化：

- **聊天不等压缩**：读档案和准备阶段并行，最多多等 50ms，没回来就当本轮没有档案；窗口前移、请求压缩的写入都不等待（`turn.ts`）。
- **压缩不占聊天资源**：worker 是进程内定时任务，每 10 秒领一条、串行跑，一次最多 3 条。上游调用是网络 I/O，流式解析只做字符串累积，CPU 可以忽略。数据库只在领取、提交、收尾时各用一次短连接（语句上限 5 秒）。
- **唯一的相互影响在窗口**：压缩跟不上时，聊天窗口会在高水位之上「等」（最多 7 万字，prompt 变长、变贵），再超就强制截断。这次让压缩稳定成功，就是在减少这种影响。不改水位参数。
- **流式不放大影响**：首字 6 秒、总 120 秒都会 abort 并释放连接，卡住的上游不会占着 worker。
