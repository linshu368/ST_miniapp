# Review 源码采集规则与兜底机制

> 面向 `ops/git/review.sh` 的 AI 代码审查流水线：如何把「架构文档 + 源码 + diff」
> 组装成单次输入，同时把总量控制在 **10 万 token** 以内。
> 最近校准：2026-08-12（tiktoken cl100k 基线）。核心清单或包结构变动后，
> 请按本文「维护」一节重新实测并更新数字。
>
> **2026-08-12 变更**：采集口径改为**只服务自研引擎链路**。ST 相关源码
> （`bridge-protocol` / `st-extension` / `sync-engine` / `db-types` 四个包、
> ST 专用契约与运维目录）整体移出固定块，并从变量块的候选里排除——该链路正在被
> 自研 prompt 引擎替换（`docs/ST_remove.md`），给一条待删链路付固定成本不划算。
> 腾出的额度让给自研对话链路的接缝（engine / generation / conversations）。
> **相关性排序 + 预算截断的核心机制未变**；粒度上刻意留了一档例外，见 §3.3。

---

## 1. 单次输入的四块结构

`review.sh` 组装给大模型的单次输入由四块拼成（经 `fill-prompt.py` 填入模板）：

| 块                      | 来源                                   | 性质                       | token 量级                                      |
| ----------------------- | -------------------------------------- | -------------------------- | ----------------------------------------------- |
| 提示词模板              | `prompts/diff_review.md`（或飞书远端） | 准固定（改动频繁但量稳定） | ~数 k                                           |
| ARCHITECTURE.md         | `docs/ARCHITECTURE.md`                 | **固定**                   | ~10k（去 ST 重写后，原 ~16.5k）                 |
| 固定块（核心源码）      | `collect-context.sh` 固定清单          | **固定**                   | ~35k（含 `<file>` 包裹与说明头；裸文件 ~34.6k） |
| 变量块（diff 圈定源码） | `collect-context.sh` 按 diff 圈定      | **变量**（受预算约束）     | 剩余预算                                        |
| diff 本体               | `collect-diff.sh`                      | 变量                       | 视 PR 而定                                      |

**设计取舍**：整包 dump 源码在 token 维度约 150k+，单独就超 10 万。因此放弃「全量上下文」，
改为「固定核心块（当地图/契约） + 只投喂 diff 触达的源码切片」，用 ARCHITECTURE.md 补全
未投喂模块的职责认知。

---

## 2. 固定块（核心源码）

每次审查恒定投喂，实测 ~35k token（35 文件 / 3899 行）。入选标准：**必须是
判定依据/行为真相/接线总表，且稳定少变**；大实现体一律不进（被 diff 触达时
自然作为变量块进来）。

### A. 契约层全量 —— 判定「绕过契约/在包内私定对外数据形状」（架构铁律 1/4）的源头

- `packages/shared/src/**`（17 个 REST 契约、日志与遥测约定、DB 环境隔离配置、dev-fixtures）
- 其中 ST 专用契约按路径排除：`st-bridge/`（ST handle 派生）、`platform-presets.ts`
  （ST 预设 payload → `oai_settings` 映射）、`api/st-session.ts`、`api/chats.ts`（ST recent 列表）

### B. 载荷配置 —— 声明式行为真相，不读它无法判断改动是否正确

- `packages/backend/prisma/schema.prisma`（所有 Repository 改动的对照物）
- `packages/frontend/next.config.mjs`（rewrites 路由分发，事故高发区）

### C. 接线/编排骨架 —— 「什么被注册到了哪里」的全局地图，替代整包源码

- backend 全局：`app.ts`（路由注册总表）、`platform/config.ts`（env 全貌）、
  `middleware/auth.ts`（用户侧鉴权口径，判定新路由有没有挂鉴权）
- 自研对话链路（本项目当前唯一的业务执行引擎）：
  - `features/engine/types.ts` —— 引擎接缝（`EngineInput` / `EngineOutput`）
  - `features/engine/prompt-engine.ts` —— prompt 最终形状，49 行，改坏它整站输出跟着变
  - `features/generation/types.ts` + `features/generation/index.ts` —— **唯一生成/计费出口**
    的接缝与出口总表；判定「新路径有没有绕过计费」靠它
  - `features/conversations/generate.ts` —— 一轮生成的编排骨架（预建轮次 → 组 prompt →
    生成 → 收口），M1/M2/M3a 三处接缝合拢的地方
- frontend：`app/providers.tsx`（全局 Provider 挂载点）、`lib/api/client.ts`
  （唯一 REST/SSE 客户端门面，对应前端铁律「不在组件里 fetch」）

> **明确不进固定块**：`features/generation/execute.ts` 等实现体、各 Repository、
> 路由 handler 本体、全部 UI 组件、支付/钱包/CS/许愿/运营后台等业务实现。
> 它们靠「被 diff 触达 → 变量块」或「ARCHITECTURE.md 描述」覆盖。

> **ST 相关一律不进固定块**：`bridge-protocol`、`st-extension`、`sync-engine`、
> `db-types` 四个包，以及 `registry.yaml`、前端 bridge 体系（`lib/bridge/`、
> `stores/st-mirror.ts`）。理由是这条链路正在被替换、不再接受新特性，恒定投喂
> 只会挤占自研链路的预算。它们仍会出现在 diff 里，审查照常能看到改了什么。

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

### 3.3 ST 源码在变量块里的处理（分两档，刻意不一刀切）

| 范围                                                                                                                             | 处理                           | 理由                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------- |
| 整包只服务 ST 的四个包（`bridge-protocol` / `st-extension` / `sync-engine` / `db-types`）+ `ops/{st-extensions,sillytavern,s6}/` | **不进候选**，只在 diff 里出现 | 整包在删除清单上，不再接受新特性；投喂全文纯属浪费预算                                       |
| 活在 `frontend` / `backend` 里的 ST 专用文件（`lib/bridge/`、`routes/{bridge,chats,llm-proxy}.ts`、`middleware/stProxy.ts` 等）  | **照常按相关性投喂全文**       | 切换完成前它们仍承载生产流量，真被 diff 改到就是在改线上行为，这时候少给上下文只会让审查更差 |

第二档会随 ST 清退自然消失（文件删除后 selector 本来就跳过）。若想把第二档也一并
排除，改 `select-context-files.py` 的 `EXCLUDE_RE` 加一条路径即可。

---

## 4. 兜底 / 护栏机制汇总

| 机制                     | 位置                                 | 作用                                                                                                                          |
| ------------------------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| **预算截断**             | `select-context-files.py`            | 变量块超预算时按相关性从末尾砍，保证总量 ≤ 上限                                                                               |
| **单文件体积上限**       | `REVIEW_MAX_FILE_TOKENS`（默认 30k） | 超大单文件（多为生成物）不投全文、仅靠 diff 呈现（`oversize`），不占预算、不触发相关性截断                                    |
| **include/exclude 过滤** | `select-context-files.py` 正则       | 只收 `packages/ops` 下源码与配置；排除 vendor/node_modules/dist/测试/`.d.ts`/锁文件，以及 ST 四个包与 ST 专用运维目录（§3.3） |
| **固定块去重**           | `collect-context.sh` + selector      | 触达文件若已在固定块则不重复投喂                                                                                              |
| **已删除文件跳过**       | selector                             | 删除文件只在 diff 呈现，不尝试读全文                                                                                          |
| **token 估算降级**       | `estimate_tokens.py`                 | 无 tiktoken 时降级为 CJK 感知字符启发式（误差 ±10%），CI 无依赖也能跑                                                         |
| **安全余量**             | `REVIEW_TOKEN_MARGIN`（默认 3k）     | 吸收估算误差，避免逼近硬上限                                                                                                  |
| **被砍清单回显**         | `collect-context.sh`                 | 上下文里列出被砍文件（reason/token/churn），并提示 AI「未包含≠不存在，缺失细节标注需人工核对而非臆测」                        |

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
- **`shared` 契约层是固定块里增长最快的部分**（12 → 17 个契约文件），2026-08-12
  去掉 ST 之后总量仍在 ~35k：省下的额度被新增契约吃掉了。新增对外契约时留意这条曲线，
  必要时把低频契约（如 simulation）也移出固定块。
- **ST 清退落地时**（`docs/ST_remove.md` §四 的删除清单执行后）三件事一起做：
  1. 固定块里按路径排除的几条 `-not -path`、`EXCLUDE_RE` 里的四个包都成了死规则，可删；
     不删也不会出错。
  2. §3.3 第二档（`lib/bridge/`、`routes/{bridge,chats,llm-proxy}.ts` 等）随文件删除自然消失。
  3. **提示词模板 `prompts/diff_review.md` 需要重写**：它的「通道 A/B 判定」、「ST 原生代码
     不可修改」铁律、bridge-client / bridge-server / provisioning 三个审查域描述的都是
     已退场的链路，届时应改为自研引擎链路的审查域（prompt 组装、生成与计费出口、
     会话轮次与重生成语义、SSE 收口）。本轮刻意未动，避免在 ST 仍承载生产流量时
     让审查规则与代码脱节。
