# 图片生成链路复用与可靠性调研

## 检索范围

- Frontend：`app/chat/[characterId]/page.tsx`、`components/chat/*`、`lib/api/conversations.ts`、`lib/api/voice.ts`。
- Backend：`routes/voice.ts`、`features/voice/*`、`features/generation/*`、`CharacterCardRepository`、`ChatMessageAudioRepository`、`chat-voice-storage.ts`、`platform/config.ts`、`platform/runtime-config.ts`、`app.ts`。
- Shared/Database：`src/api/voice.ts`、conversation/wallet/envelope 契约、`app_core.characters.character_persona_and_style` 迁移、语音表迁移、生成/钱包扣费 RPC 与语音计费回退历史。
- 外部参考：`shengtu_pipeline.py` 与 `视觉分镜师prompt.txt` 的分镜写稿、翻译和 Grok/Liaobots 生图流程。

## 复用结论

| 能力                         | 决策                                | 理由                                                                       |
| ---------------------------- | ----------------------------------- | -------------------------------------------------------------------------- |
| 消息旁支产物                 | 复用模式，不复用 audio 表           | 图片同样绑定具体 assistant message；媒体字段与生命周期不同，应建独立表     |
| 202 + 会话批量查询           | 复用                                | 已解决离页恢复与按 pending 轮询，前端认知成本最低                          |
| React Query key/map/条件轮询 | 扩展复用                            | 新建 image domain hook，不能把图片塞入 voice 类型                          |
| Storage helper               | 抽取小型通用私有原语或平行薄 helper | 路径、MIME、大小校验不同；不要过早建通用媒体框架                           |
| generation 出口              | 扩展                                | 分镜写稿、翻译和 Grok 出图都属于模型生成；直接在 image feature fetch 会违反唯一出口 |
| 语音写稿两段式               | 复用产品/编排口径，谨慎抽取实现      | 图片默认路径先分镜写中文短文，自定义路径跳过分镜写稿；可复用 DeepSeek transport、deadline/错误映射，不能复用 TTS 标签、台词抽取和朗读清洗 |
| 语音 300 字限制              | 复用约束模式，不复用数值            | 图片 prompt 上限为 200 字，应新增 shared 常量并在前端、route、送模型前共用；不按 token、不静默截断 |
| 角色卡 `character_persona_and_style` | 扩展读取现有字段                    | 110 migration 已新增字段；图片分镜需要按当前会话角色读取，不进入前端契约     |
| 外部分镜师 prompt            | 采纳为图片写稿系统提示词            | 作为 backend 非 secret prompt 资源版本化；不复制外部文件里的任何密钥默认值   |
| Grok/Liaobots provider       | 新增单一 provider adapter           | 使用 `LIAOBOTS_AUTH`、`LIAOBOTS_BASE`、`GROK_MODEL`；Grok URL 只供 backend 下载后转存 |
| 对话免费额度                 | 不复用                              | PRD 明确图片消耗星尘，不走角色免费聊天轮次                                 |
| 语音成功后扣费 RPC 模式      | 复用事务语义                        | Storage 成功后，扣钱包、ledger、ready 必须原子且幂等                       |
| 语音 fire-and-forget         | 不复用                              | 图片更慢，离页和进程重启要求持久任务恢复；当前模式会留下 pending           |
| 新增 BullMQ/独立 worker      | 不采用                              | 现有 PostgreSQL 足以承载初版低吞吐队列，引入新状态源和部署单元属于过度设计 |

## 故障模型摘要

- **上游前失败**：校验、ownership、余额预检失败，不创建或不推进生成，不扣费。
- **角色锚点缺失**：`character_persona_and_style` 为空时不能伪造核心外貌；按评审策略禁用该角色图片或使用明确兜底。
- **自定义路径误入分镜写稿**：用户修改后的中文短文若再次送分镜师，会违反“用户改什么就画什么”；以 `prompt_source` 分支和接口日志摘要校验阻断。
- **翻译失败**：默认/自定义都不能跳过翻译直接把中文送 Grok；记录 `image_translation_failed`，不扣费。
- **Grok 明确失败**：记录 failed，不扣费；429/5xx 不默认重试图片 POST，避免重复产图和供应商成本。
- **Grok 模糊超时**：无法确认是否已生成时标 `failed_unknown`，禁止自动重投；用户可新建 attempt。
- **上传失败**：可在内存结果仍有效且总 deadline 内做一次安全上传重试；最终失败不扣费。
- **扣费时余额被其他请求用掉**：删除已上传对象（失败则记录 orphan cleanup），attempt 标余额竞争失败，不展示、不扣费。
- **DB 收口重放**：以 attempt id 为 charge key，RPC 幂等返回 already_charged/current；不能重复扣款。
- **进程重启**：pending 任务可重领；已经进入 provider 模糊区的任务不自动重投，避免重复；ready/failed 为终态。
- **并发确认**：客户端 disabled 只是体验，数据库 partial unique/租约/RPC 才是正确性保障。

## 容量与观测

- 初版一 attempt 一张 1024×1536 WebP/JPEG，限制解码后字节数，禁止 base64 入库。
- runner 使用小批量、有限并发和租约；数据库扫描依赖 `(status, next_attempt_at)` 索引。
- 日志只记 ID、阶段、耗时、尺寸、字节数、provider request id、状态与错误码，不记中文短文、英文 prompt、对话全文或 Grok 原始 URL。
- 初版 provider 是 Grok/Liaobots；`shengtu_pipeline.py` 里的 Replicate/Z 降级不纳入当前容量与观测口径。
