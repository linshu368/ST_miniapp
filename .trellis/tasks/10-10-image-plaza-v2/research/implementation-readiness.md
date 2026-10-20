# 实施启动核验（2026-10-12）

## 授权与基线

- 用户于 2026-10-12 明确要求“开始实现 10-10-image-plaza-v2”，替代此前“先不实施”的暂停指令。
- 当前分支为 `feat_image_park`；PR 目标按仓库规则使用 `dev`。
- `implement.jsonl` / `check.jsonl` 已通过 `task.py validate`。

## Anime 模型映射

- 产品侧稳定业务 ID：`anime-wai`。
- Venice 官方模型页的 API 示例在 2026-10-12 核验时仍使用 provider model id `wai-Illustrious`：
  `https://venice.ai/models/wai-illustrious`。
- 实现只在已发布图片模型目录中保存映射 `anime-wai -> wai-Illustrious`；Frontend/shared 用户 DTO 不暴露 provider secret，也不把 provider ID 当稳定业务 ID。
- 模型目录缺失、映射为空或 provider 返回不支持时 fail closed；不回落到 Venice 默认模型，避免错误模型产生费用。

## Venice 接口核验

- 官方文档（2026-10-12 核验）：T2I 使用 `POST /api/v1/image/generate`，成功形状包含
  `id`、base64 `images[]` 与 `timing`；I2I/edit 使用实验性
  `POST /api/v1/image/edit`，输入图可为 base64 或 URL。
- Qwen Image 家族只接受 `aspect_ratio`，传 `width`/`height` 会返回 400；分辨率档模型按
  `aspect_ratio + resolution` 传参，像素模型才传 `width + height`。具体能力必须来自已发布目录，不能用一套字段猜测所有模型。
- Venice native generate 支持最多 4 variants，但本期刷新是独立 attempt；每次 provider 请求仍只取单张，避免部分成功与计费歧义。
- provider 返回 base64 必须先做解码上限、MIME/魔数和尺寸校验，再写受控 Storage 路径；prompt、base64、图片 URL 和 provider key 不进入日志。
- 外部调用使用明确超时。provider dispatch 后超时属于结果未知，不向同一 provider 自动重投；只允许用户显式刷新创建新 attempt。
- 参考图不得由客户端提交任意 URL。公开契约只接受当前用户有权访问的 artifact/upload ID，由 Backend 解析为受控 Storage 对象后再调用上游。

## 八域归属终审

| 对象                                       | Schema                                          | 业务不变量 / 权威写入方                                                  | 生命周期与消费者                        | 跨 schema 依赖                              |
| ------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------- |
| `image_plaza_conversations`                | `experience`                                    | 一条独立图片创作会话属于一个 MiniApp 用户；Backend 写                    | 随创作功能保留，Frontend/Backend 读写   | FK → `app_core.users`                       |
| `image_plaza_messages`                     | `experience`                                    | 会话内用户提示与生成组顺序不可串会话；Backend 写                         | 会话历史；Frontend/Backend              | FK → conversation                           |
| `image_plaza_attempts`                     | `experience`                                    | 每次提交/刷新独立 attempt；终态与具体 artifact、报价快照绑定；worker 写  | 审计和恢复保留；Backend worker/Frontend | FK → message/user；结算函数访问 billing     |
| `image_plaza_works`                        | `experience`                                    | ready artifact 的公开作品投影；分享成功最多生成一条公开记录；分享 RPC 写 | 软删，不因功能关闭破坏性删除；广场/详情 | FK → attempt/user；分享函数访问 billing     |
| `image_plaza_likes`                        | `miniapp_features`                              | 每用户每作品最多一个点赞；用户动作写                                     | 可随广场功能下线删除；广场消费者        | FK → experience work/app_core user          |
| `image_plaza_share_rewards`                | `billing`                                       | 同一实扣 ledger/作品最多返一次，比例与金额快照不可变；分享 RPC 写        | 账务审计长期保留                        | FK → wallet ledger、experience attempt/work |
| 图片模型/弹窗/标签草稿与发布记录           | `admin.config_drafts` / `admin.config_releases` | 运营草稿、发布、回滚由既有 Admin RPC 权威写                              | 沿用版本化生命周期；Admin               | 发布写入 app_core runtime config            |
| 正式图片模型目录、分享弹窗、标签、返利比例 | `app_core.runtime_config`                       | 线上唯一正式配置；Admin 发布或技术改库写                                 | 跨应用长期配置；Backend 读取            | Admin 发布 RPC                              |
| 首次分享完成事实                           | `app_core.miniapp_user_settings` 扩展字段       | 仅首个成功分享事务从 false 置 true                                       | 账号生命周期；Backend/Frontend          | 分享 RPC                                    |

### 权限、容量与恢复

- 新业务表启用 RLS，并撤销 `PUBLIC/anon/authenticated` 直接访问；仅 `service_role/postgres` 访问，客户端一律经 Backend。
- 广场用 `(published_at, id)` 稳定游标；点赞唯一约束和分享/返利唯一约束承担并发正确性。
- attempt claim 使用有限 lease 与 `FOR UPDATE SKIP LOCKED`；provider dispatch 后的模糊超时不自动重投。
- 事务只覆盖 ready 结算或 share+reward 的最小写集；外部 HTTP/Storage 不放进数据库事务。
- migration 使用 `5s lock_timeout` / 有界 statement timeout，前置 shape 不满足即停止；探索环境先执行，生产另行确认。
- 回滚优先关闭 `image_plaza_enabled`、停止新 claim、回退应用；账务、attempt、作品历史不删除，schema 缺陷 forward-fix。

## 最小充分实现

- 使用一个独立 shared 契约文件、一个独立 Backend feature/route 域、一个 Frontend API 域与现有 Admin managed-config 框架。
- 不建立通用工作流、第二套钱包、第二套 Admin 发布框架、Redis 队列或跨应用 import。
- 图片上游复用纯技术 HTTP/Storage 能力，但不调用聊天图片业务 handler、attempt repository 或 settle RPC。
