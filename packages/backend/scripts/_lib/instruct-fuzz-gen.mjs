#!/usr/bin/env node
/**
 * Step 1 — instruct fuzz case 生成器（一次性脚本）
 *
 * 设计原则：
 *   ① 输出 case 文件**永远冻结**——一次生成、永远 commit。再次跑本脚本
 *      要么完全幂等（产物字节级一致），要么追加新 case（不改老 case）。
 *   ② 完全 deterministic：所有 (target, flags, sequences, args) 组合都
 *      手工列在 SCENARIOS 数组里，没有 PRNG 抽样——这样未来无论是谁
 *      在哪台机器上跑，文件内容都是同一份。
 *   ③ 每条 fuzz case 都用「最小 instruct 设置」表达一个边界假设；与
 *      手写 case 形成正交补充（手写 case 验证主路径，fuzz case 验证
 *      奇怪输入 + flag 组合）。
 *
 * Usage:
 *   node scripts/_lib/instruct-fuzz-gen.mjs           # 写文件
 *   node scripts/_lib/instruct-fuzz-gen.mjs --check   # 仅校验，不写
 *
 * 增加新 fuzz case 的流程（约定）：
 *   1. 在 SCENARIOS 数组**末尾**追加一条 ScenarioSpec
 *   2. 跑一次本脚本：产物的现有 fuzz-001 ~ fuzz-NN 文件保持不变，
 *      新增 fuzz-(N+1) 落地
 *   3. 同步更新 cases/index.json
 *   4. 不要在数组中间插入或调整顺序——会动 caseId 序号导致 baseline
 *      失效
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = resolve(__dirname, '../../test/fixtures/instruct/cases');

// ─── 默认骨架（与 case.schema.json required 字段对齐） ──────────────────────

const DEFAULT_INSTRUCT = {
  enabled: true,
  wrap: false,
  macro: false,
  names_behavior: 'none',
  input_sequence: '',
  input_suffix: '',
  output_sequence: '',
  output_suffix: '',
  system_sequence: '',
  system_suffix: '',
  last_system_sequence: '',
  first_input_sequence: '',
  last_input_sequence: '',
  first_output_sequence: '',
  last_output_sequence: '',
  stop_sequence: '',
  story_string_prefix: '',
  story_string_suffix: '',
  user_alignment_message: '',
  system_same_as_user: false,
  sequences_as_stop_strings: true,
  activation_regex: '',
  bind_to_context: false,
  skip_examples: false,
};

const DEFAULT_CONTEXT = {
  preset: 'fuzz',
  story_string_position: 0,
  chat_start: '',
  example_separator: '',
  use_stop_strings: false,
};

const DEFAULT_SYSPROMPT = { enabled: false, content: '' };

const DEFAULT_CTX = {
  name1: 'Bob',
  name2: 'Alice',
  selectedGroup: null,
  groups: [],
  characters: [],
};

// ─── 场景定义：15 条手工挑选的 (flags × sequences × args) 组合 ─────────────

/**
 * @typedef {Object} ScenarioSpec
 * @property {string} shortName  case 名后缀（kebab-case）
 * @property {string} description 一句话讲清「这条 fuzz 在覆盖什么边界」
 * @property {string[]} tags
 * @property {'formatInstructChat'|'formatInstructPrompt'} target
 * @property {Partial<typeof DEFAULT_INSTRUCT>} instruct
 * @property {Partial<typeof DEFAULT_CONTEXT>} [context]
 * @property {Partial<typeof DEFAULT_CTX>} [ctx]
 * @property {object} args
 */

/** @type {ScenarioSpec[]} */
const SCENARIOS = [
  // ── chat：5 条 ───────────────────────────────────────────────────────────
  {
    shortName: 'chat-emoji-sequences',
    description:
      'wrap=true + emoji 在 sequence 里 + names=none + user normal。验证非 ASCII 字符在 prefix/suffix 不被截。',
    tags: ['fuzz', 'chat', 'emoji'],
    target: 'formatInstructChat',
    instruct: {
      wrap: true,
      names_behavior: 'none',
      input_sequence: '🟢 ',
      input_suffix: ' ❌',
      output_sequence: '🔵 ',
      output_suffix: ' ✅',
    },
    args: {
      name: 'Bob',
      mes: 'hi',
      isUser: true,
      isNarrator: false,
      forceAvatar: '',
      forceOutputSequence: null,
    },
  },
  {
    shortName: 'chat-macro-cn-name',
    description:
      'macro=true + 中文 user 名 + name1Override 经 substituteParams 替换 {{user}}/{{name}}。验证中文不被 ascii 路径误编码。',
    tags: ['fuzz', 'chat', 'macro', 'cjk'],
    target: 'formatInstructChat',
    instruct: {
      wrap: false,
      macro: true,
      names_behavior: 'none',
      input_sequence: '<{{user}}/{{name}}> ',
      input_suffix: ' </{{user}}>',
      output_sequence: '<{{char}}> ',
      output_suffix: ' </{{char}}>',
    },
    ctx: { name1: '宋砚', name2: '凌雪' },
    args: {
      name: '宋砚',
      mes: '今天怎么样？',
      isUser: true,
      isNarrator: false,
      forceAvatar: '',
      forceOutputSequence: null,
    },
  },
  {
    shortName: 'chat-narrator-system-same-as-user',
    description:
      'isNarrator=true + system_same_as_user=true → narrator 走 input_sequence/input_suffix。验证 ST line 397 / 425 二个分支同时切换。',
    tags: ['fuzz', 'chat', 'narrator', 'system_same_as_user'],
    target: 'formatInstructChat',
    instruct: {
      wrap: true,
      names_behavior: 'always',
      input_sequence: '[INST] ',
      input_suffix: ' [/INST]',
      output_sequence: '',
      output_suffix: '</s>',
      system_sequence: '<<NEVER-USED-SYS>>',
      system_suffix: '<<NEVER-USED-SYS-SFX>>',
      system_same_as_user: true,
    },
    args: {
      name: 'System',
      mes: 'narrator line',
      isUser: false,
      isNarrator: true,
      forceAvatar: '',
      forceOutputSequence: null,
    },
  },
  {
    shortName: 'chat-force-last-output',
    description:
      'forceOutputSequence=LAST(2) → 用 last_output_sequence 优先，回落 output_sequence。给一个明确不同的 last_output_sequence。',
    tags: ['fuzz', 'chat', 'force-output', 'last'],
    target: 'formatInstructChat',
    instruct: {
      wrap: true,
      names_behavior: 'none',
      input_sequence: '<|user|>\n',
      input_suffix: '<|end|>',
      output_sequence: '<|asst|>\n',
      output_suffix: '<|end|>',
      last_output_sequence: '<|asst-final|>\n',
    },
    args: {
      name: 'Alice',
      mes: 'final reply',
      isUser: false,
      isNarrator: false,
      forceAvatar: '',
      forceOutputSequence: 2,
    },
  },
  {
    shortName: 'chat-backslash-quotes-in-seq',
    description:
      '反斜杠 / 引号 / 控制符在 sequence 里。验证 JSON 反序列化后 sequence 字符不被破坏。',
    tags: ['fuzz', 'chat', 'escape'],
    target: 'formatInstructChat',
    instruct: {
      wrap: false,
      names_behavior: 'none',
      input_sequence: '\\"u\\": ',
      input_suffix: '\\n',
      output_sequence: '\\"a\\": ',
      output_suffix: '\\n',
    },
    args: {
      name: 'Bob',
      mes: 'hello "world" \\path',
      isUser: true,
      isNarrator: false,
      forceAvatar: '',
      forceOutputSequence: null,
    },
  },

  // ── prompt：8 条 ─────────────────────────────────────────────────────────
  {
    shortName: 'prompt-impersonate-emoji',
    description:
      'isImpersonate=true + emoji input_sequence。验证 impersonate 路径下 emoji prefix 不被截。',
    tags: ['fuzz', 'prompt', 'impersonate', 'emoji'],
    target: 'formatInstructPrompt',
    instruct: {
      wrap: true,
      names_behavior: 'always',
      input_sequence: '🟢user🟢\n',
      input_suffix: '<|end|>',
      output_sequence: '🔵asst🔵\n',
      output_suffix: '<|end|>',
    },
    args: {
      name: 'Bob',
      isImpersonate: true,
      promptBias: '',
      isQuiet: false,
      isQuietToLoud: false,
    },
  },
  {
    shortName: 'prompt-macro-in-sequence',
    description:
      'macro=true + sequence 含 {{user}}/{{char}}/{{name}} → substituteParams 展开。验证 instruct 里多个 macro 同时存在的展开次序。',
    tags: ['fuzz', 'prompt', 'macro'],
    target: 'formatInstructPrompt',
    instruct: {
      wrap: false,
      macro: true,
      names_behavior: 'none',
      input_sequence: '<U:{{user}}>\n',
      input_suffix: '</U:{{user}}>',
      output_sequence: '<C:{{char}}/N:{{name}}>\n',
      output_suffix: '</C:{{char}}>',
      last_output_sequence: '<C:{{char}}-LAST/N:{{name}}>\n',
    },
    ctx: { name1: 'Bob', name2: 'Alice' },
    args: {
      name: 'Alice',
      isImpersonate: false,
      promptBias: '',
      isQuiet: false,
      isQuietToLoud: false,
    },
  },
  {
    shortName: 'prompt-quiet-fallback-output',
    description:
      'isQuiet=true + isQuietToLoud=false + last_system_sequence 为空 → 回落 output_sequence（ST line 605-607 第二分支）。验证 fallback 路径与「拿 last_system_sequence」分支区分。',
    tags: ['fuzz', 'prompt', 'quiet', 'fallback'],
    target: 'formatInstructPrompt',
    instruct: {
      wrap: true,
      names_behavior: 'always',
      input_sequence: '<|u|>\n',
      input_suffix: '<|end|>',
      output_sequence: '<|a|>\n',
      output_suffix: '<|end|>',
      last_system_sequence: '',
    },
    args: {
      name: 'Alice',
      isImpersonate: false,
      promptBias: '',
      isQuiet: true,
      isQuietToLoud: false,
    },
  },
  {
    shortName: 'prompt-quiet-to-loud-fallback',
    description:
      'isQuiet=true + isQuietToLoud=true + last_output_sequence 为空 → 回落 output_sequence（ST line 610-611）。',
    tags: ['fuzz', 'prompt', 'quiet-to-loud', 'fallback'],
    target: 'formatInstructPrompt',
    instruct: {
      wrap: true,
      names_behavior: 'always',
      input_sequence: '<|u|>\n',
      input_suffix: '<|end|>',
      output_sequence: '<|a|>\n',
      output_suffix: '<|end|>',
      last_output_sequence: '',
    },
    args: {
      name: 'Alice',
      isImpersonate: false,
      promptBias: '',
      isQuiet: true,
      isQuietToLoud: true,
    },
  },
  {
    shortName: 'prompt-long-bias-with-newlines',
    description:
      '非 impersonate + 多行 promptBias（含开头 \\n\\t 空白）+ includeNames=false → bias.trimStart() 路径。验证多行 trim 行为。',
    tags: ['fuzz', 'prompt', 'bias', 'multiline'],
    target: 'formatInstructPrompt',
    instruct: {
      wrap: true,
      names_behavior: 'none',
      input_sequence: '[INST] ',
      input_suffix: ' [/INST]',
      output_sequence: '[OUT] ',
      output_suffix: '</s>',
    },
    args: {
      name: 'Alice',
      isImpersonate: false,
      promptBias: '\n\t  be cinematic\nuse vivid imagery\nstay in character',
      isQuiet: false,
      isQuietToLoud: false,
    },
  },
  {
    shortName: 'prompt-mistral-filler-with-macro',
    description:
      'Mistral name filler 边界（output_sequence 末尾空格 + last_output_sequence 不带空格 + includeNames=true）+ macro=true。验证 nameFiller 在 substituteParams 之前/之后的次序。',
    tags: ['fuzz', 'prompt', 'mistral', 'macro'],
    target: 'formatInstructPrompt',
    instruct: {
      wrap: false,
      macro: true,
      names_behavior: 'always',
      input_sequence: '[INST]{{user}} ',
      input_suffix: ' [/INST]',
      output_sequence: '[OUT]{{char}} ',
      output_suffix: '</s>',
      last_output_sequence: '[LAST_OUT]{{char}}',
    },
    ctx: { name1: 'Bob', name2: 'Alice' },
    args: {
      name: 'Alice',
      isImpersonate: false,
      promptBias: '',
      isQuiet: false,
      isQuietToLoud: false,
    },
  },
  {
    shortName: 'prompt-multiline-sequence',
    description:
      '多行 sequence（含 \\n + Tab + 中间空行）。验证 instruct.wrap=true 时这些行内 separator 不被二次插入。',
    tags: ['fuzz', 'prompt', 'multiline-sequence'],
    target: 'formatInstructPrompt',
    instruct: {
      wrap: true,
      names_behavior: 'none',
      input_sequence: '<|user|>\n\t<sub-tag>\n',
      input_suffix: '\n</sub-tag>\n<|end|>',
      output_sequence: '<|asst|>\n\t<asst-sub>\n',
      output_suffix: '\n</asst-sub>\n<|end|>',
    },
    args: {
      name: 'Alice',
      isImpersonate: false,
      promptBias: '',
      isQuiet: false,
      isQuietToLoud: false,
    },
  },
  {
    shortName: 'prompt-empty-name-no-include',
    description:
      'name="" + names_behavior=always → includeNames 退化（ST line 595 取 `name && (...)`，name 为 falsy 时整体 false）。验证「空 name 强制不加 names」边界。',
    tags: ['fuzz', 'prompt', 'empty-name'],
    target: 'formatInstructPrompt',
    instruct: {
      wrap: true,
      names_behavior: 'always',
      input_sequence: '[INST] ',
      input_suffix: ' [/INST]',
      output_sequence: '[OUT] ',
      output_suffix: '</s>',
    },
    args: { name: '', isImpersonate: false, promptBias: '', isQuiet: false, isQuietToLoud: false },
  },

  // ── chat：再 2 条收尾 ──────────────────────────────────────────────────
  {
    shortName: 'chat-empty-mes',
    description:
      '空 mes + names=always → textArray 第二项变成 `name: + suffix`，filter(x=>x) 不会把它过滤（因为非空字符串）。验证 ST line 453 三元 + filter 边界。',
    tags: ['fuzz', 'chat', 'empty-mes'],
    target: 'formatInstructChat',
    instruct: {
      wrap: true,
      names_behavior: 'always',
      input_sequence: '<|u|>\n',
      input_suffix: '<|end|>',
      output_sequence: '<|a|>\n',
      output_suffix: '<|end|>',
    },
    args: {
      name: 'Bob',
      mes: '',
      isUser: true,
      isNarrator: false,
      forceAvatar: '',
      forceOutputSequence: null,
    },
  },
  {
    shortName: 'chat-wrap-with-empty-suffix',
    description:
      'wrap=true + suffix 为空 → ST line 446-448 把 suffix 强制成 \\n。验证「wrap-fallback suffix」自动注入。',
    tags: ['fuzz', 'chat', 'wrap-fallback'],
    target: 'formatInstructChat',
    instruct: {
      wrap: true,
      names_behavior: 'none',
      input_sequence: '[U] ',
      input_suffix: '',
      output_sequence: '[A] ',
      output_suffix: '',
    },
    args: {
      name: 'Alice',
      mes: 'reply',
      isUser: false,
      isNarrator: false,
      forceAvatar: '',
      forceOutputSequence: null,
    },
  },
];

// ─── 渲染：把 ScenarioSpec 转成完整 case JSON ────────────────────────────────

/**
 * @param {ScenarioSpec} spec
 * @param {number} index 1-based
 */
function renderCase(spec, index) {
  const num = String(index).padStart(3, '0');
  const caseId = `instruct-fuzz-${num}-${spec.shortName}`;
  return {
    caseId,
    description: spec.description,
    tags: spec.tags,
    target: spec.target,
    input: {
      instruct: { ...DEFAULT_INSTRUCT, ...spec.instruct },
      context: { ...DEFAULT_CONTEXT, ...(spec.context ?? {}) },
      sysprompt: { ...DEFAULT_SYSPROMPT },
      ctx: { ...DEFAULT_CTX, ...(spec.ctx ?? {}) },
      args: spec.args,
    },
  };
}

// ─── Driver ─────────────────────────────────────────────────────────────────

async function main() {
  const checkOnly = process.argv.includes('--check');
  if (!existsSync(CASES_DIR)) {
    await mkdir(CASES_DIR, { recursive: true });
  }

  let written = 0;
  let unchanged = 0;
  let mismatches = 0;

  for (let i = 0; i < SCENARIOS.length; i++) {
    const spec = /** @type {ScenarioSpec} */ (SCENARIOS[i]);
    const caseObj = renderCase(spec, i + 1);
    const filename = `${caseObj.caseId}.json`;
    const path = resolve(CASES_DIR, filename);
    const json = JSON.stringify(caseObj, null, 2) + '\n';

    if (existsSync(path)) {
      const existing = await readFile(path, 'utf8');
      if (existing === json) {
        unchanged++;
        continue;
      }
      if (checkOnly) {
        mismatches++;
        console.error(`[check] DRIFT ${filename}`);
        continue;
      }
      await writeFile(path, json, 'utf8');
      written++;
      console.log(`[gen] UPDATE ${filename}`);
    } else {
      if (checkOnly) {
        mismatches++;
        console.error(`[check] MISSING ${filename}`);
        continue;
      }
      await writeFile(path, json, 'utf8');
      written++;
      console.log(`[gen] WRITE  ${filename}`);
    }
  }

  if (checkOnly) {
    if (mismatches > 0) {
      console.error(`\n[check] FAIL: ${mismatches} fuzz file(s) out of sync with generator.`);
      process.exit(1);
    }
    console.log(`\n[check] OK: ${SCENARIOS.length} fuzz file(s) match generator output.`);
    return;
  }

  console.log(`\n[gen] done. ${written} written, ${unchanged} unchanged.`);
  console.log(`[gen] total scenarios: ${SCENARIOS.length}`);
}

main().catch((e) => {
  console.error('[instruct-fuzz-gen] fatal:', e);
  process.exit(1);
});
