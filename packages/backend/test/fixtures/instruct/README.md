# Instruct Engine Fixtures (Step 1 baseline)

本目录是 Step 1 instruct 格式化迁移的**冻结基线**，承担和 `../macros/`
完全相同的契约：用同一份 case 集合分别在 ST 原版和 miniAPP 后端跑出
两份 baseline JSON，**字节级 diff** 决定 Step 1 是否闭环。

> **冻结基线** = 一旦 caseId 提交，永不重命名、永不重排、永不修改原
> case 的 `input`。新场景只能在末尾追加新 caseId。

## 目录结构

```
packages/backend/test/fixtures/instruct/
├── README.md                  ← you are here
├── schema/
│   ├── case.schema.json       ← case 文件 schema（discriminated union by target）
│   └── baseline.schema.json   ← runner 输出 schema
├── cases/                     ← 34 个 case（19 手写 + 15 fuzz）
│   ├── index.json             ← 索引（决定 runner 加载顺序）
│   ├── instruct-001-...       ← 手写 case，覆盖 7 个 target 主路径与已知边界
│   ├── ...
│   ├── instruct-019-...
│   ├── instruct-fuzz-001-...  ← fuzz case，由 scripts/_lib/instruct-fuzz-gen.mjs 生成
│   ├── ...
│   └── instruct-fuzz-015-...
└── baselines/                 ← runner 输出（Step 1.7 / 1.8 之后落地）
    ├── sillytavern-original-instruct-YYYYMMDD-HHmm.json   ← 真值（ST 浏览器跑出来）
    └── miniapp-instruct-YYYYMMDD-HHmm.json                ← 候选（miniAPP node 跑出来）
```

## Case schema：两层结构

每个 case 文件由 `target` 字段决定形状。Schema 在顶层用 `allOf if/then`
强约束 `input.args` 必须匹配该 target：

```jsonc
{
  "caseId": "instruct-NNN-short-name",
  "description": "...",
  "tags": ["chat", "smoke"],
  "target": "formatInstructChat" | ... | "getInstructMacros",
  "input": {
    // ① 公共 ctx 区（每个 case 必填全集；instruct 的 25 字段一个都不少）
    "instruct": { /* InstructSettings 全集 */ },
    "context":  { /* ContextSettings 全 5 字段 */ },
    "sysprompt": { "enabled": false, "content": "" },
    "ctx": {
      "name1": "...",
      "name2": "...",
      "selectedGroup": null,
      "groups": [],
      "characters": []
    },

    // ② per-target args 区（schema 里 oneOf 强约束）
    "args": { /* 形状由 target 决定 */ }
  }
}
```

之所以**强制每个 case 都填 instruct/context 全字段**，是为了避免出现
「输出依赖了 schema-level default」这种隐性耦合——一旦默认值变了
baseline 就会失稳，难定位。每个 case 都自给自足，input 长但稳。

## Target 表（7 个 instruct.ts 门面入口）

| target                         | args 关键字段                                                       | 返回 type     |
| ------------------------------ | ------------------------------------------------------------------- | ------------- |
| `formatInstructChat`           | `name, mes, isUser, isNarrator, forceAvatar?, forceOutputSequence?` | `string`      |
| `formatInstructStoryString`    | `storyString`                                                       | `string`      |
| `formatInstructExamples`       | `mesExamplesArray: string[]`                                        | `string[]`    |
| `formatInstructPrompt`         | `name, isImpersonate, promptBias?, isQuiet?, isQuietToLoud?`        | `string`      |
| `formatInstructSystemPrompt`   | `systemPrompt`                                                      | `string`      |
| `getInstructStoppingSequences` | `useStopStrings?: boolean \| null`                                  | `string[]`    |
| `getInstructMacros`            | `preferCharacterPrompt?, charPrompt?`                               | `macro-array` |

`macro-array` 形态在 baseline 里**归一化**成 `NormalizedMacro[]`：

```jsonc
{
  "regexSource": "{{(instructInput|instructUserPrefix)}}",
  "regexFlags": "gi",
  "replacement": "INPUT_SEQ", // 闭包 replace() 调用一次的字面量结果
}
```

## Case 覆盖矩阵

### 手写 case（19 条）

| caseId 段 | target 函数                  | 数量 | 覆盖意图                                                                                    |
| --------- | ---------------------------- | ---- | ------------------------------------------------------------------------------------------- |
| 001 - 005 | formatInstructChat           | 5    | user 普通 / narrator / force-first-output / names-always / macro=true 嵌套 substituteParams |
| 006 - 007 | formatInstructStoryString    | 2    | IN_PROMPT 套 prefix/suffix / IN_CHAT 短路                                                   |
| 008 - 010 | formatInstructExamples       | 3    | skip_examples 短路 / 正常块 / 空块 fallback（line 575-577）                                 |
| 011 - 015 | formatInstructPrompt         | 5    | impersonate / quiet / quiet-to-loud / Mistral name filler / 带 promptBias trim              |
| 016       | formatInstructSystemPrompt   | 1    | identity（deprecated）                                                                      |
| 017 - 018 | getInstructStoppingSequences | 2    | enabled=false 短路 / 全开（含 wrap+macro+context.use_stop_strings）                         |
| 019       | getInstructMacros            | 1    | 全 19 条宏跑一遍（含 prefer_character_prompt 路径）                                         |

### Fuzz case（15 条）

由 `scripts/_lib/instruct-fuzz-gen.mjs` 数据驱动生成，**永远幂等**：再次运行
脚本应该产生 byte-identical 文件。每条 fuzz 都用「最小 instruct 设置」
表达一个边界假设（emoji/CJK/反斜杠/空 mes/wrap-fallback 等），与手写
case 形成正交补充。

新增 fuzz case 的流程：

1. 在 `instruct-fuzz-gen.mjs` 的 `SCENARIOS` 数组**末尾**追加
2. `node scripts/_lib/instruct-fuzz-gen.mjs` → 生成新 caseId 文件
3. 不要改数组中间的位置或顺序——会动 caseId 编号导致 baseline 失效

CI/工程纪律：跑 `node scripts/_lib/instruct-fuzz-gen.mjs --check` 应永远
exit 0；非 0 表示 generator 数组与磁盘文件 drift。

## 跑 baseline 的具体命令

### Step 1.7 — ST 真值 baseline（在 ST 浏览器端，一次性）

```bash
# 1) 同步 case + adapter 到 ST 运行时
cd packages/backend
node scripts/sync-baseline-runner.mjs --step instruct
#   ↑ 自动识别 test/fixtures/instruct/cases/index.json 的存在

# 2) 启动 ST 运行时
cd /Users/qj/python_project/SillyTavern_runtime
npm install   # 仅首次
npm start

# 3) 浏览器打开 http://localhost:8000，等 ST 加载完成
#    打开 devtools console，粘贴：
import('/baseline-runner/adapters/instruct.js').then(m => m.run())

# 4) 浏览器自动下载：
#    sillytavern-original-instruct-YYYYMMDD-HHmm.json
#    把它移到：
#    packages/backend/test/fixtures/instruct/baselines/
```

下载下来的文件就是 Step 1 的**永久真值**。即使 ST 上游更改 instruct 行为，
本项目仍 pin 在这个版本。

### Step 1.8 — miniAPP 候选 baseline + diff

```bash
cd packages/backend
pnpm instruct:baseline   # 仅跑 candidate，输出 miniapp-instruct-*.json
pnpm instruct:diff       # 仅 diff，默认取 baselines/ 里最新的两份
pnpm instruct:verify     # 跑 candidate + diff，一次到位
```

`instruct:verify` 退出码 0 = Step 1 byte-exact 闭环；非 0 = 至少一条 hard
mismatch，按 stderr 提示逐个修。

Diff 工具按 `output.meta.outputType` 分支：

| outputType    | 比较方式                                                                          |
| ------------- | --------------------------------------------------------------------------------- |
| `string`      | `output.text` 字节级                                                              |
| `string[]`    | `output.meta.outputValue` 长度 + 逐元素字节级                                     |
| `macro-array` | `output.meta.outputValue` 长度 + 逐条 `regexSource/regexFlags/replacement` 三元组 |

## Don'ts

- ❌ 不要 rename 已 commit 的 caseId（破坏历史 baseline）
- ❌ 不要修改已 commit case 的 `input`（要变就建新 caseId）
- ❌ 不要在 `SCENARIOS` 数组中间插入新 fuzz scenario（永远末尾追加）
- ❌ 不要手工编辑 baseline JSON 文件（必须 runner 出品）
- ❌ 不要在 case 里依赖 schema 默认值偷懒（必须每字段 explicit）
