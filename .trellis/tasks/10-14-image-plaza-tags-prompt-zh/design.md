# 标签开关与种子中文提示词 — 技术设计

> 状态：规划收敛；待用户确认最终摘要后实施。

## 1. 边界与复用

| 层 | 改动 |
| -- | ---- |
| `shared` | `ImagePlazaSnapshotSchema` 增加可选 `prompt_zh`；契约/测试 |
| `database` | 新 migration：种子 `image_plaza_tags_feature_enabled`；纳入 Admin 校验/发布 allowlist（与 `image_plaza_enabled` 同类 boolean） |
| `backend` | `config.ts` 读开关；feed/bootstrap/share 分支；`listWorks` 搜索 OR；翻译脚本 |
| `frontend` | 详情展示 `prompt_zh ?? prompt`；标签 chip 随 API 返回（无业务 tags 则自然只剩「全部」或空行，前端可隐藏空筛选条） |
| `admin` | 元数据/schema 注册该 boolean key（复用现有 enabled 类编辑，不新建菜单页） |

**禁止**：改聊天图链路；在出图 worker 加翻译；覆盖 `snapshot.prompt`；把 `prompt_zh` 写入同款会话的提交 prompt。

### 复用

| 既有 | 用法 |
| ---- | ---- |
| `getImagePlazaRuntimeConfig` / Admin 草稿发布 | 扩展读新 key |
| `requestImagePlazaTags` / `veniceFetch` + `config.imagePlaza` | 翻译脚本复用同一 Venice chat completions 通道与模型配置，**另写** translate helper（system/user 为翻译，不复用打标 prompt） |
| `import-image-plaza-seed.ts` CLI 模式 | dry-run / `--apply` / `--target` / 并发 / logger |
| `ImagePlazaSnapshot` / use-same RPC | `prompt` 权威英文不变 |

### 拒绝

- 新建独立 prompt 表或双 work 实体。
- 通用翻译服务/队列框架。
- 为 UGC 自动译中文。

## 2. 数据与八域

- **配置真相**：`app_core.runtime_config.image_plaza_tags_feature_enabled`（boolean，默认 `true`）。
- **内容真相**：中文译文落在 `experience.image_plaza_works.snapshot.prompt_zh`（JSONB 字段扩展，非新表）。
  - 归属：`experience`（作品快照内容）。
  - 权威写入：test 翻译脚本（本阶段）；未来若导入链路补译可同路径。
  - 不变量：`prompt` = 出图/同款英文；`prompt_zh` = 可选展示/搜索中文；不得用中文覆盖 `prompt`。
  - 长度：与 `IMAGE_PLAZA_PROMPT_MAX_CHARS`（2000）对齐；超长截断策略：翻译结果 trim 后若超限则截断并记 quarantine/计数，不写脏超长进库（或拒绝该条，design 实施选「拒绝并计入 failed」更安全）。
- artifacts：无 prompt，**不**改 artifact 表。
- 无需改 RLS 业务语义；脚本使用现有 service 写路径。

## 3. 数据流

```
[运营] runtime_config.image_plaza_tags_feature_enabled
        ├─ false → feed/bootstrap 不暴露业务 tags；share 跳过 classifyImagePlazaTags
        └─ true  → 现网标签 UI + 分享打标

[脚本 test] works(origin=civitai_seed)
        → snapshot.prompt (en)
        → Venice chat completions (taggingModel)
        → snapshot || { prompt_zh }
        → UPDATE works.snapshot

[Feed 搜索] term → snapshot.prompt_zh ilike OR snapshot.prompt ilike
[详情] UI ← prompt_zh ?? prompt
[同款] createConversation ← snapshot.prompt only → Studio 提交英文
[用户创作] textarea → attempt.prompt → upstream（无翻译）
```

## 4. 可靠性

| 点 | 策略 |
| -- | ---- |
| 翻译超时 | 单条显式 timeout（建议 30–60s）；失败记 failed，不阻断批次 |
| 重试 | 脚本级有限重试仅网络/5xx；成功写库后跳过 |
| 幂等 | `prompt_zh` 非空且非强制 `--force` 则 skip |
| 并发 | 有界（如 2–4）；限速避免打爆 Venice |
| 开关 | 显式 `false` 才关；缺失视为开 |
| 可观测 | 批次数、成功/跳过/失败计数、耗时、`{ err }`；禁 prompt/密钥 |
| 搜索 OR | PostgREST `.or()` 两条件；term 仍 escape + 80 字截断 |

## 5. 契约变更

```ts
// ImagePlazaSnapshotSchema
prompt: z.string().max(2000),
prompt_zh: z.string().max(2000).optional(), // 或 .nullish()；缺省=未译
```

- Feed/详情 DTO 随 snapshot 透出 `prompt_zh`（可给前端展示）。
- 同款路径**禁止**把 `prompt_zh` 写入新 conversation/attempt 的 `prompt`。
- 分享打标仍读 attempt 英文 prompt（用户生成路径）；与 seed 展示场无关。

## 6. 脚本接口（建议）

```
pnpm --filter @miniapp/backend image-plaza:translate-seed-prompts -- \
  [--apply] --target test [--offset N] [--limit N] [--concurrency K] [--force]
```

- 默认 dry-run：统计待译/已有/超长。
- `--apply` + `--target test` 才写库；production 需显式确认旗标（本阶段可不实现 production 分支，直接拒绝）。

## 7. 兼容与回滚

1. 旧客户端忽略未知 snapshot 字段（若有）；新契约 optional 向前兼容。
2. 关 `image_plaza_tags_feature_enabled` 即可停标签 UI 与打标，不影响已有 tags 数据。
3. 回滚译文：可不删 `prompt_zh`；紧急可脚本清空该字段；搜索回退仅英文。
4. 发布顺序：migration（config key）→ shared 契约 → backend（开关+搜索+脚本）→ frontend 详情展示 → test 跑翻译脚本。

## 8. 验证要点

- 单测：开关 false 时 share 不调 tagging mock；搜索 OR；snapshot schema 接受/缺省 `prompt_zh`。
- 人工：test 开关切换；详情中文；同款英文；中文搜索；用户创作原文出图。
