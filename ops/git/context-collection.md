# Review 源码采集规则与兜底机制

> 面向 `ops/git/review.sh` 的 AI 代码审查流水线：如何把「架构文档 + 源码 + diff」
> 组装成单次输入，同时把总量控制在 **10 万 token** 以内。
> 最近校准：2026-07-14（tiktoken cl100k 基线）。核心清单或包结构变动后，
> 请按本文「维护」一节重新实测并更新数字。

---

## 1. 单次输入的四块结构

`review.sh` 组装给大模型的单次输入由四块拼成（经 `fill-prompt.py` 填入模板）：

| 块                      | 来源                                   | 性质                       | token 量级                                    |
| ----------------------- | -------------------------------------- | -------------------------- | --------------------------------------------- |
| 提示词模板              | `prompts/diff_review.md`（或飞书远端） | 准固定（改动频繁但量稳定） | ~数 k                                         |
| ARCHITECTURE.md         | `docs/ARCHITECTURE.md`                 | **固定**                   | ~16.5k                                        |
| 固定块（核心源码）      | `collect-context.sh` 固定清单          | **固定**                   | ~36k（含 `<file>` 包裹与说明头；裸文件 ~34k） |
| 变量块（diff 圈定源码） | `collect-context.sh` 按 diff 圈定      | **变量**（受预算约束）     | 剩余预算                                      |
| diff 本体               | `collect-diff.sh`                      | 变量                       | 视 PR 而定                                    |

**设计取舍**：整包 dump 源码在 token 维度约 150k+，单独就超 10 万。因此放弃「全量上下文」，
改为「固定核心块（当地图/契约） + 只投喂 diff 触达的源码切片」，用 ARCHITECTURE.md 补全
未投喂模块的职责认知。

---

## 2. 固定块（核心源码）

每次审查恒定投喂，实测 ~36k token。入选标准：**必须是判定依据/行为真相/接线总表，
且稳定少变**；大实现体一律不进（被 diff 触达时自然作为变量块进来）。

### A. 契约层全量 —— 判定「绕过契约/重复定义协议字段」（架构铁律 2/4/5）的源头

- `packages/bridge-protocol/src/**`（envelope / 两段握手 / 7 actions / 13 events / 错误码）
- `packages/shared/src/**`（12 个 REST 契约 + `deriveStHandle` + DB 环境隔离配置）

### B. 载荷配置 —— 声明式行为真相，不读它无法判断改动是否正确

- `packages/sync-engine/registry.yaml`（provision/watcher 同步规则）
- `packages/backend/prisma/schema.prisma`（所有 Repository 改动的对照物）
- `packages/frontend/next.config.mjs`（方案 Y rewrites，路由分发事故高发区）

### C. 接线/编排骨架 —— 「什么被注册到了哪里」的全局地图，替代整包源码

- backend：`app.ts`（路由注册总表）、`platform/config.ts`（env 全貌）
- st-extension：`entry.ts`（15 patches/7 handlers 注册表）、`bridge-server.ts`、
  `handshake.ts`、`mirror-state.ts`、`forwarders/index.ts`（实际转发的 11 个事件——
  对照协议 13 个正是契约漂移审查点）
- frontend：`app/providers.tsx`（iframe 常驻挂载点）、`lib/bridge/{index,platform-action,hooks,singleton,state-machine}.ts`（`platformAction()` API 门面 + 状态机语义）、`stores/st-mirror.ts`
- sync-engine：`lib/config.ts`（env 校验）、`provisioner/index.ts`（order 10/20/30/100 编排骨架）

> **明确不进固定块**：bridge-client 看门狗实现、provisioner 的 writer/merger、
> llm-proxy 实现、15 个 patches 本体、各 Repository、全部 UI 组件、支付/钱包/CS/许愿
> 等纯自研 REST 实现。它们靠「被 diff 触达 → 变量块」或「ARCHITECTURE.md 描述」覆盖。

---

## 3. 变量块（diff 圈定源码）：相关性排序 + 预算截断

由 `select-context-files.py` 处理。输入是 `git diff <base>...HEAD --numstat`，
产出「diff 触达文件的全文」（diff 只有 hunks，全文补齐上下文）。

### 3.1 相关性优先级（投喂顺序）

1. **churn 降序**（added + deleted 改动行数）：改得越多越是本次 diff 的核心，
   审查越依赖其全文——「与 diff 强相关」最直接的度量。
2. **churn 相同 → 文件体积升序**：同等相关性下优先小文件，同预算内多容纳几个。

即使总量未超预算，也**始终按此顺序排列**（强相关排前面）。

### 3.2 预算截断（＝大 diff 降级）

```
变量预算 = REVIEW_TOKEN_LIMIT - RESERVED - 固定块tokens - REVIEW_TOKEN_MARGIN
其中 RESERVED = 提示词模板 + ARCHITECTURE.md + diff 三块 token（由 review.sh 估算传入）
```

按优先级从高到低累加；一旦某文件加入会超预算，**该文件及其后所有更低优先级文件
全部丢弃**——即「从相关性最小的开始砍」。这样保证组装后单次输入 ≤ `REVIEW_TOKEN_LIMIT`。

---

## 4. 兜底 / 护栏机制汇总

| 机制                     | 位置                                 | 作用                                                                                                           |
| ------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| **预算截断**             | `select-context-files.py`            | 变量块超预算时按相关性从末尾砍，保证总量 ≤ 上限                                                                |
| **单文件体积上限**       | `REVIEW_MAX_FILE_TOKENS`（默认 30k） | 超大单文件（多为生成物）不投全文、仅靠 diff 呈现（`oversize`），不占预算、不触发相关性截断                     |
| **include/exclude 过滤** | `select-context-files.py` 正则       | 只收 `packages/ops` 下源码与配置；排除 vendor/node_modules/dist/测试/`.d.ts`/锁文件/`ops/st-extensions` 生成物 |
| **固定块去重**           | `collect-context.sh` + selector      | 触达文件若已在固定块则不重复投喂                                                                               |
| **已删除文件跳过**       | selector                             | 删除文件只在 diff 呈现，不尝试读全文                                                                           |
| **token 估算降级**       | `estimate_tokens.py`                 | 无 tiktoken 时降级为 CJK 感知字符启发式（误差 ±10%），CI 无依赖也能跑                                          |
| **安全余量**             | `REVIEW_TOKEN_MARGIN`（默认 3k）     | 吸收估算误差，避免逼近硬上限                                                                                   |
| **被砍清单回显**         | `collect-context.sh`                 | 上下文里列出被砍文件（reason/token/churn），并提示 AI「未包含≠不存在，缺失细节标注需人工核对而非臆测」         |

> **已知边界**：若最相关的单个文件本身就接近/超过预算，它仍会被保留（就是审查对象），
> 此时总量可能逼近上限——极端单文件大改的固有情况，无法两全。

---

## 5. 相关文件

| 文件                      | 职责                                                                      |
| ------------------------- | ------------------------------------------------------------------------- |
| `review.sh`               | 编排入口：采集四块 → 估算 RESERVED → 调 collect-context → 填模板 → 调 API |
| `collect-context.sh`      | 产出源码上下文：固定块（bash 清单）+ 变量块（委托 selector）              |
| `collect-diff.sh`         | 产出 diff 本体（自带 pathspec 排除 vendor/docs/锁文件/二进制）            |
| `select-context-files.py` | 变量块相关性排序 + 预算截断 + 护栏                                        |
| `estimate_tokens.py`      | 共用 token 估算（tiktoken 优先，字符启发式兜底）                          |
| `fill-prompt.py`          | 把四块填入提示词模板                                                      |

---

## 6. 用法与调参

```bash
# 默认对比 main
bash ops/git/review.sh
# 指定基准分支
bash ops/git/review.sh dev

# 仅看采集出的源码上下文（固定块 + 圈定）
git diff <base>...HEAD --numstat > /tmp/ns.txt
bash ops/git/collect-context.sh /tmp/ns.txt

# 落盘中间产物（含 changed-files / src-code / git-diff / system-prompt）
REVIEW_ARTIFACT_DIR=/tmp/review-debug bash ops/git/review.sh
```

可调 env：

| env                      | 默认     | 说明                                        |
| ------------------------ | -------- | ------------------------------------------- |
| `REVIEW_TOKEN_LIMIT`     | 100000   | 单次输入硬上限                              |
| `REVIEW_TOKEN_MARGIN`    | 3000     | 估算误差安全余量                            |
| `REVIEW_MAX_FILE_TOKENS` | 30000    | 单个圈定文件全文上限                        |
| `REVIEW_RESERVED_TOKENS` | 0        | 模板+文档+diff 已占用（review.sh 自动传入） |
| `REVIEW_REPO_ROOT`       | 脚本推导 | 采集的仓库根                                |

---

## 7. 维护

- **核心清单变动**（增删固定块文件）后：重新实测固定块 token 并更新
  `collect-context.sh` 头注释与本文第 1/2 节的数字。快速实测：
  ```bash
  bash ops/git/collect-context.sh > /tmp/core.txt
  python3 ops/git/estimate_tokens.py /tmp/core.txt
  ```
- **token 估算基线**：tiktoken 是 GPT 分词器，Claude 分词器略有差异但同数量级；
  中文占比高时实际 token 更重。预算已留 3k 余量吸收误差。
- 冷启动 debug 埋点等「临时保留」代码若清理，注意其是否在固定块清单中，需同步更新。
