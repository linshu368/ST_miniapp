# 功能模块知识库与归档同步技术设计

## 1. 设计目标与原则

建立一个版本化、可审查、能被后续 Trellis 规划直接读取的“模块当前状态层”。它与现有 spec 的职责分开：

- 现有专题规范回答“代码应该怎么写”。
- 新模块文件回答“这个功能现在是什么、在哪里、如何串起来、有哪些关键约束”。
- 归档任务回答“为什么从旧状态变成当前状态”，只作为证据，不充当当前事实。

归档自动化采用“人工/AI 生成语义，脚本确定性校验和应用”的边界。脚本不在归档时猜业务含义。所有文件变更在 Git 暂存/提交前必须由人工审核最终 diff 并明确确认；同步和归档可以自动修改工作区，但不得自动提交或推送。

## 2. 信息架构

### 2.1 目录

在现有 package/layer 下增加 `modules/`，避免把现状文件与编码规则混在同一级：

```text
.trellis/spec/
├── frontend/app/modules/
│   ├── index.md
│   ├── business/<module-id>.md
│   ├── infrastructure/<module-id>.md
│   └── shared/<module-id>.md
├── backend/app/modules/{index.md,business/,infrastructure/,shared/}
├── admin/app/modules/{...}
├── cs-platform/app/modules/{...}
├── shared/contracts/modules/{...}
└── database/supabase/modules/{index.md,business/,infrastructure/,shared/}
```

各 package 的现有 `index.md` 只新增一个“功能模块现状”链接。另新增 `.trellis/spec/modules-index.md` 作为全局发现入口，列出 package、分类、模块 ID、标题和状态；它由同步器从各模块文件重建，不手工维护第二份描述正文。

### 2.2 模块边界

模块满足以下条件才独立成文件：有明确职责、入口/调用者、实现链和独立变化原因。拆分规则：

- 业务能力按用户或运营可验收功能拆分，例如 `conversation`、`voice-message`、`payment`，不按技术目录机械拆分。
- 基础设施按稳定平台能力拆分，例如 `telegram-auth`、`runtime-config`、`logging`、`api-client`。
- 公共内容仅在被两个及以上业务模块实际复用且有独立约束时进入 `shared`；只服务一个业务的 helper 留在业务模块。
- 跨 package 的同一业务使用相同语义后缀但不同完整 ID，例如 `frontend.business.conversation` 与 `backend.business.conversation`。每份只陈述本包事实，并在“关联模块”互链。
- 一个源文件可被多个模块引用，但必须标注它在该模块中的职责；禁止通过文件唯一归属强行拆错边界。

稳定模块 ID 格式为 `<scope>.<category>.<slug>`，scope 为 `frontend|backend|admin|cs-platform|shared|database`，category 为 `business|infrastructure|shared`，slug 使用 kebab-case。重命名必须显式记录旧/新 ID。

### 2.3 单文件模板

```markdown
---
module_id: backend.business.voice-message
title: 语音消息
scope: backend
category: business
status: active
owners: [backend]
last_verified_task: .trellis/tasks/archive/YYYY-MM/<task>/
last_verified_at: YYYY-MM-DD
---

# 语音消息

## 职责与边界

## 当前状态

## 入口与调用者

## 涉及文件

| 路径 | 职责 |

## 关键实现链路

## 数据、契约与外部依赖

## 关键节点与约束

## 验证方式

## 已知缺口与待核验项

## 关联模块
```

`status` 只允许 `active|partial|deprecated|planned-removal`；尚未实现的规划不创建当前模块文件。路径必须存在，删除操作可在载荷中引用删除证据。`last_verified_task` 在 pre-archive 阶段先写预计归档路径，并由路径规则校验。

## 3. 任务侧契约

### 3.1 规划声明

`task.json.meta.module_impact` 保存小型、稳定、便于列表展示的声明：

```json
{
  "meta": {
    "module_impact": {
      "schema_version": 1,
      "mode": "changes",
      "modules": ["backend.business.voice-message", "shared.business.voice-message"],
      "declared_at": "2026-09-08"
    }
  }
}
```

无影响时：

```json
{
  "schema_version": 1,
  "mode": "no_module_change",
  "reason": "仅修正文档错别字，不改变模块实现或约束"
}
```

启用日前创建的任务可用 `mode: legacy_exempt`，必须填写 reason；新任务禁止该值。创建任务模板和 workflow 要提示规划者声明模块，并将对应 `modules/index.md` 与模块文件加入 implement/check 上下文。

### 3.2 完成载荷

任务目录新增 `module-updates.json`。它保存完整目标 Markdown，而不是模糊 patch；这样可预测、可审核、可做摘要校验：

```json
{
  "schema_version": 1,
  "task": "09-08-example",
  "base_commit": "<40-char sha>",
  "updates": [
    {
      "operation": "update",
      "module_id": "backend.business.voice-message",
      "target": ".trellis/spec/backend/app/modules/business/voice-message.md",
      "expected_sha256": "<同步前文件摘要>",
      "evidence": [
        "packages/backend/src/routes/voice.ts",
        "packages/backend/src/features/voice/generate.test.ts"
      ],
      "content": "---\nmodule_id: ...\n"
    }
  ]
}
```

操作语义：

- `create`：目标不得存在，content 必填。
- `update`：目标必须存在且摘要等于 `expected_sha256`，content 必填。
- `rename`：额外提供 `from_module_id`、`from_target`、`expected_sha256`；新目标不得存在。
- `delete`：content 禁止，必须提供旧摘要、`replacement_module_id` 或 `deletion_reason`，且 evidence 证明实现删除/替换。
- `no_module_change` 不创建更新项，但 task 声明必须有非空理由。

载荷中的 content 必须通过 frontmatter、章节、模块 ID 与目标路径一致性校验。索引不在载荷中，由同步器确定性重建。

## 4. 同步器与归档事务

### 4.1 组件边界

新增项目级 Python 模块（建议 `.trellis/scripts/module_knowledge.py`）提供：

```text
check <task>       只读校验声明、载荷、模块文件、路径覆盖和索引漂移
apply <task>       在锁内校验并原子应用，生成 rollback manifest
rollback <manifest> 恢复 apply 前字节内容，仅供 archive 内失败补偿
rebuild-index      从模块 frontmatter 确定性重建索引
baseline-check     全量检查重复 ID、坏链接、缺章节、孤儿索引
```

`task_store.cmd_archive` 只增加薄集成，不把模块解析逻辑塞入通用函数。建议抽出项目 pre-archive adapter；若当前 Trellis 不支持阻断式 pre-hook，则直接调用本仓库模块并用 feature config 控制。

### 4.2 正确顺序

当前实现先写 completed、移动、提交，再执行非阻断 `after_archive`，不满足要求。目标顺序：

1. 解析真实 task，确认未归档；计算预计 archive 路径。
2. 获取 `.trellis/.runtime/module-sync.lock` 排他锁；锁带 PID/时间，超时后失败，不自动破坏未知活锁。
3. `check` 全部通过：声明与载荷匹配、目标在 allowlist、摘要未漂移、证据路径安全、Git diff/relatedFiles 未发现未声明 package 模块影响。
4. `apply` 写入同目录临时文件并 `os.replace`，删除/重命名先备份到 runtime rollback manifest；重建全局和 package 索引。
5. 再写 `task.json.status=completed/completedAt`，清 session，移动任务目录。
6. 释放同步锁并输出审核包：最终路径清单、diff/摘要、验证结果、建议提交分组；归档命令到此结束，禁止自动 stage/commit/push。
7. 人工审核最终内容并明确确认后，提交阶段重新校验文件摘要；摘要或文件集合变化则确认失效并返回审核。
8. 仅在确认仍有效时执行显式 `git add <allowlist>` 和 `git commit`，使归档任务与模块更新进入同一逻辑提交。该动作不得由 archive/hook/session 自动触发。
9. commit 失败只保留已审核的工作区/暂存区状态并给出恢复命令，不自动重试或改写内容；成功后可执行通知 hook。任何 `git push` 都需独立人工授权，commit 确认不授权 push。

实现时应把“工作区可逆变更”和“人工确认后的 Git commit”作为强制边界写成测试。过渡期一律使用 `archive --no-commit` 且关闭 `session_auto_commit`；不得以兼容旧行为为理由保留任何自动提交路径。

### 4.3 人工确认契约

审核包至少包含：任务名、模块操作、所有新增/修改/删除路径、最终 diff 或可定位摘要、验证命令与结果、拟提交分组、内容摘要。确认记录绑定该摘要和路径集合，仅接受明确的“确认提交”语义。

- 确认之前禁止 `git add`，避免暂存区与审核内容不透明；读取 `git diff`、`git status` 是允许的。
- 确认后、提交前重新计算摘要；任何文件变化、验证结果过期或新增未识别文件都要求重新审核。
- commit 与 push 分离授权；系统永不自动 push。
- `task.py archive`、`add_session.py`、safe commit helper、lifecycle hook 和未来新增 Trellis 命令都纳入静态/回归检查，避免旁路。

### 4.4 漏报检测

模块文件是语义映射，不能只靠路径 glob。基线阶段生成 `.trellis/spec/module-map.json`，只包含模块 ID、模块文件和代码路径模式，不含业务描述。check 使用：

- `base_commit..HEAD` 已提交 diff；
- 当前工作树 diff（仅提示归档前不应有未提交产品改动）；
- task `relatedFiles`；
- module map 的路径模式；

发现命中模块不在声明中时阻断并列出候选；一个路径命中多个模块时要求规划者明确选择。新增路径没有映射时，如果位于 `packages/*` 或 migrations，要求显式加入现有/新模块或给出 no-impact 理由。

## 5. 基线建立与新任务使用

### 5.1 基线步骤

1. 按 package 分批扫描页面/route、feature、components/hooks/helpers、contracts、repositories、migrations 和测试。
2. 先列模块清单和边界，不直接批量生成正文；评审业务/基建/shared 分类和跨包互链。
3. 每批生成模块文件，逐项核对路径存在、调用链与测试证据；未知项标 `待核验`。
4. 运行 baseline-check，package owner 抽查关键模块；合并后再启用归档阻断。

建议顺序：shared + database → backend → frontend → admin → cs-platform。原因是消费端模块依赖契约、数据和 API 事实。

### 5.2 规划时发现

- `get_context.py --mode packages` 输出每个 scope 的 `modules/index.md`。
- 任务创建/brainstorm 提示先在全局索引按关键词/路径查模块，再读命中的模块文件。
- `task.py add-context` 继续承载注入：index 用于发现，具体模块文件用于实现/check。
- 未找到模块时执行源码调研并声明 create；不能把缺失知识当作功能不存在。

## 6. 可靠性、安全与可观测性

| 维度      | 处理                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------- |
| 超时      | 锁等待有界；无网络调用，不需要 HTTP timeout。                                                       |
| 重试      | 不自动重试语义/摘要冲突；用户修正后重跑。原子 replace 的瞬时文件占用可做极有限重试。                |
| 幂等      | 目标内容摘要已等于 content 时视为成功；重复 archive 仍由“已归档”规则拒绝。                          |
| 并发      | 仓库级文件锁 + expected sha 乐观并发，防止两个任务覆盖同一模块。                                    |
| 事务      | 预校验、临时文件、原子替换、rollback manifest；Git 提交在人工审核确认后独立执行。                   |
| 降级      | 同步不可用时阻断归档；仅允许有审计的 legacy 豁免，不静默跳过。                                      |
| 补偿      | 恢复旧字节、旧路径、task 状态/目录；保留失败 manifest 和明确命令。                                  |
| 限流/容量 | 本地 CLI 无业务限流；限制单载荷大小、单文件大小和更新数，防止误塞大数据。                           |
| 可观测性  | 输出 task、模块 ID、operation、target、结果和耗时；审核阶段展示 diff，普通日志不打印 content。      |
| 安全      | resolve 后必须位于允许的 modules 目录；拒绝 `..`、symlink 越界、绝对路径、secret 模式和异常大正文。 |

## 7. 演进、发布与恢复

1. **observe**：只提供 baseline-check/check，CI 告警不阻断；完成全量基线人工审核。
2. **prepare**：新任务模板要求 module impact，archive 对缺失声明告警；存量任务允许 legacy_exempt。
3. **enforce-new**：以任务 `createdAt` 和配置启用日期为界，新任务归档阻断；旧任务显式豁免；所有任务均执行人工提交门禁。
4. **enforce-all**：稳定观察后取消默认豁免；删除漂移的旧汇总内容或改为链接。

停止条件：误删、模块内容丢失、归档不可恢复、并发覆盖、索引大面积漂移。立即关闭 enforce 开关，保留 check，使用 rollback manifest/Git restore 恢复，再 forward-fix；不改写已归档历史。

## 8. 最小充分方案与拒绝项

新增的长期概念只有：`modules/` Markdown、模块 ID、task module impact、`module-updates.json`、一个同步脚本、归档薄集成和统一人工提交门禁。拒绝：外部服务、数据库、embedding、运行时 AI、每文件 ownership 强约束、通用插件框架。这样保留可演进性，同时把归档正确性所需的校验、锁、幂等、审核和恢复做完整。
