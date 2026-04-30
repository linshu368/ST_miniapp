'use strict';

/**
 * instruct/instruct-mode.js
 *
 * 1:1 剪线式硬搬自 SillyTavern 1.17.0 `public/scripts/instruct-mode.js`
 * 的纯函数核心。仅迁移 7 个对外 export 函数 + migrate 工具 + 2 个枚举常量；
 * UI/jQuery/状态选择器层（loadInstructMode / selectInstructPreset /
 * autoSelectInstructPreset / updateBindModelTemplatesState / controls
 * 控件映射 / `jQuery(() => ...)` 块）整段砍掉，由 miniAPP 业务层自己
 * 实现 preset 切换 API。
 *
 * 剪线表（与「Step 1 实践计划」第二节一致）：
 *   原 import                                | 替换
 *   ────────────────────────────────────────|──────────────────────────────
 *   '../script.js' substituteParams /        | '../macros/runtime/host.js'
 *     name1 / name2 / extension_prompt_types | + '../macros/runtime/constants.js'
 *   './group-chats.js' selected_group        | '../macros/runtime/host.js'
 *   './openai.js' parseExampleIntoIndividual | './parseExampleIntoIndividual.js'
 *   './power-user.js' power_user             | '../macros/runtime/host.js'
 *   './utils.js' onlyUnique/regexFromString  | '../macros/runtime/utils.js'
 *
 * 砍掉的依赖：online_status / saveSettingsDebounced / context_presets /
 * resetScrollHeight（全部 UI/状态层，不需要）。
 *
 * 与 ST 原版的语义差异：零。函数体保持字节级一致；只改 import 路径。
 *
 * @typedef {import('../instruct.js').InstructSettings} InstructSettings
 * @typedef {import('../instruct.js').ContextSettings} ContextSettings
 */

import { extension_prompt_types } from '../macros/runtime/constants.js';
import {
  name1,
  name2,
  power_user,
  selected_group,
  substituteParams,
} from '../macros/runtime/host.js';
import { onlyUnique } from '../macros/runtime/utils.js';
import { parseExampleIntoIndividual } from './parseExampleIntoIndividual.js';

/**
 * Instruct preset 名字策略三态枚举。
 *
 *   NONE   = 'none'   → 永不在消息前加角色名
 *   FORCE  = 'force'  → 仅在 group chat 或强制 avatar 时加
 *   ALWAYS = 'always' → 总是加
 *
 * @type {{ NONE: 'none', FORCE: 'force', ALWAYS: 'always' }}
 */
export const names_behavior_types = {
  NONE: 'none',
  FORCE: 'force',
  ALWAYS: 'always',
};

/**
 * 在 generation cue 阶段强制使用首条 / 末条 output sequence 的标志。
 *
 *   FIRST = 1 → 优先用 first_output_sequence（首次 AI 回复）
 *   LAST  = 2 → 优先用 last_output_sequence（最后一条 AI 回复）
 *
 * @type {{ FIRST: 1, LAST: 2 }}
 */
export const force_output_sequence = {
  FIRST: 1,
  LAST: 2,
};

/**
 * 把 instruct preset 数据迁移到 evergreen 字段格式。
 * 1:1 移植自 ST `instruct-mode.js:55-105`。原版是 module-private，
 * 我们 export 出来供调用方在导入旧 preset 时主动调用。
 *
 * 迁移规则：
 *   1. `separator_sequence` → `output_suffix`
 *   2. `names` + `names_force_groups` 两个 boolean → `names_behavior` 三态枚举
 *   3. 缺失的新字段补默认值（input_suffix / system_sequence / system_suffix /
 *      user_alignment_message / last_system_sequence / first_input_sequence /
 *      last_input_sequence / skip_examples / system_same_as_user /
 *      names_behavior / sequences_as_stop_strings / story_string_prefix /
 *      story_string_suffix）
 *   4. 删除废弃字段（names / names_force_groups / system_sequence_prefix /
 *      system_sequence_suffix）
 *
 * 调用方应传入 plain object（会被原地修改）。
 *
 * @param {Record<string, unknown>} settings Instruct preset 对象（原地修改）
 * @returns {void}
 */
export function migrateInstructModeSettings(settings) {
  // Separator sequence => Output suffix
  if (settings.separator_sequence !== undefined) {
    settings.output_suffix = settings.separator_sequence || '';
    delete settings.separator_sequence;
  }

  // names, names_force_groups => names_behavior
  if (settings.names !== undefined) {
    settings.names_behavior = settings.names
      ? names_behavior_types.ALWAYS
      : settings.names_force_groups
        ? names_behavior_types.FORCE
        : names_behavior_types.NONE;
    delete settings.names;
    delete settings.names_force_groups;
  }

  /** @type {Record<string, unknown>} */
  const defaults = {
    input_suffix: '',
    system_sequence: '',
    system_suffix: '',
    user_alignment_message: '',
    last_system_sequence: '',
    first_input_sequence: '',
    last_input_sequence: '',
    skip_examples: false,
    system_same_as_user: false,
    names_behavior: names_behavior_types.FORCE,
    sequences_as_stop_strings: true,
    story_string_prefix: '',
    story_string_suffix: '',
  };

  for (let key in defaults) {
    if (settings[key] === undefined) {
      settings[key] = defaults[key];
    }
  }

  const obsoleteFields = [
    'names',
    'names_force_groups',
    'system_sequence_prefix',
    'system_sequence_suffix',
  ];

  for (const field of obsoleteFields) {
    if (Object.hasOwn(settings, field)) {
      delete settings[field];
    }
  }
}

/**
 * 把 instruct mode 的若干 sequence 字段计算成 stop strings 数组，喂给
 * text-completion 后端做生成截断。1:1 移植自 ST `instruct-mode.js:301`。
 *
 * @param {object} [options]
 * @param {InstructSettings|null} [options.customInstruct=null] 显式 instruct
 *   设置；不传时回落到 host 的 power_user.instruct
 * @param {boolean|null} [options.useStopStrings=null] 是否把 chat_start /
 *   example_separator 也算入 stop strings；不传时回落到 power_user.context.use_stop_strings
 * @returns {string[]} stop strings 列表（已去重）
 */
export function getInstructStoppingSequences({
  customInstruct = null,
  useStopStrings = null,
} = {}) {
  const instruct = structuredClone(customInstruct ?? power_user.instruct);

  /**
   * 把一条 sequence 加入 result 数组。要求非空、非纯 whitespace。
   * @param {string} sequence
   * @returns {void}
   */
  function addInstructSequence(sequence) {
    // Cohee: oobabooga's textgen always appends newline before the sequence as a stopping string
    // But it's a problem for Metharme which doesn't use newlines to separate them.
    /** @param {string} s */
    const wrap = (s) => (instruct.wrap ? '\n' + s : s);
    // Sequence must be a non-empty string
    if (typeof sequence === 'string' && sequence.length > 0) {
      // If sequence is just a whitespace or newline - we don't want to make it a stopping string
      // User can always add it as a custom stop string if really needed
      if (sequence.trim().length > 0) {
        const wrappedSequence = wrap(sequence);
        // Need to respect "insert macro" setting
        const stopString = instruct.macro ? substituteParams(wrappedSequence) : wrappedSequence;
        result.push(stopString);
      }
    }
  }

  /** @type {string[]} */
  const result = [];

  // Since preset's don't have "enabled", we assume it's always enabled
  if (customInstruct ?? instruct.enabled) {
    const stop_sequence = instruct.stop_sequence || '';
    const input_sequence = instruct.input_sequence?.replace(/{{name}}/gi, name1) || '';
    const output_sequence = instruct.output_sequence?.replace(/{{name}}/gi, name2) || '';
    const first_output_sequence =
      instruct.first_output_sequence?.replace(/{{name}}/gi, name2) || '';
    const last_output_sequence = instruct.last_output_sequence?.replace(/{{name}}/gi, name2) || '';
    const system_sequence = instruct.system_sequence?.replace(/{{name}}/gi, 'System') || '';
    const last_system_sequence =
      instruct.last_system_sequence?.replace(/{{name}}/gi, 'System') || '';

    const combined_sequence = [stop_sequence];

    if (instruct.sequences_as_stop_strings) {
      combined_sequence.push(
        input_sequence,
        output_sequence,
        first_output_sequence,
        last_output_sequence,
        system_sequence,
        last_system_sequence
      );
    }

    combined_sequence.join('\n').split('\n').filter(onlyUnique).forEach(addInstructSequence);
  }

  if (useStopStrings ?? power_user.context.use_stop_strings) {
    if (power_user.context.chat_start) {
      result.push(`\n${substituteParams(power_user.context.chat_start)}`);
    }

    if (power_user.context.example_separator) {
      result.push(`\n${substituteParams(power_user.context.example_separator)}`);
    }
  }

  return result;
}

/**
 * 把单条聊天消息按 instruct mode 规则格式化（在 prefix / suffix 之间
 * 包装 mes，可选地带 `name:` 前缀）。1:1 移植自 ST `instruct-mode.js:387`。
 *
 * @param {string} name 角色名
 * @param {string} mes 消息正文
 * @param {boolean} isUser 是否是 user 消息
 * @param {boolean} isNarrator 是否是 narrator/system 消息
 * @param {string} forceAvatar 强制 avatar 字符串（影响 names_behavior=FORCE 判定）
 * @param {string} name1 user 名字（与 host.name1 可能不同；ST 调用方有时显式传）
 * @param {string} name2 character 名字
 * @param {boolean|number} forceOutputSequence 强制使用 first/last output sequence 的标志
 * @param {InstructSettings|null} [customInstruct=null] 显式 instruct 设置
 * @returns {string} 格式化后的消息字符串
 */
export function formatInstructModeChat(
  name,
  mes,
  isUser,
  isNarrator,
  forceAvatar,
  name1,
  name2,
  forceOutputSequence,
  customInstruct = null
) {
  const instruct = structuredClone(customInstruct ?? power_user.instruct);
  let includeNames = isNarrator ? false : instruct.names_behavior === names_behavior_types.ALWAYS;

  if (
    !isNarrator &&
    instruct.names_behavior === names_behavior_types.FORCE &&
    ((selected_group && name !== name1) || (forceAvatar && name !== name1))
  ) {
    includeNames = true;
  }

  function getPrefix() {
    if (isNarrator) {
      return instruct.system_same_as_user ? instruct.input_sequence : instruct.system_sequence;
    }

    if (isUser) {
      if (forceOutputSequence === force_output_sequence.FIRST) {
        return instruct.first_input_sequence || instruct.input_sequence;
      }

      if (forceOutputSequence === force_output_sequence.LAST) {
        return instruct.last_input_sequence || instruct.input_sequence;
      }

      return instruct.input_sequence;
    }

    if (forceOutputSequence === force_output_sequence.FIRST) {
      return instruct.first_output_sequence || instruct.output_sequence;
    }

    if (forceOutputSequence === force_output_sequence.LAST) {
      return instruct.last_output_sequence || instruct.output_sequence;
    }

    return instruct.output_sequence;
  }

  function getSuffix() {
    if (isNarrator) {
      return instruct.system_same_as_user ? instruct.input_suffix : instruct.system_suffix;
    }

    if (isUser) {
      return instruct.input_suffix;
    }

    return instruct.output_suffix;
  }

  let prefix = getPrefix() || '';
  let suffix = getSuffix() || '';

  if (instruct.macro) {
    prefix = substituteParams(prefix, { name1Override: name1, name2Override: name2 });
    prefix = prefix.replace(/{{name}}/gi, name || 'System');

    suffix = substituteParams(suffix, { name1Override: name1, name2Override: name2 });
    suffix = suffix.replace(/{{name}}/gi, name || 'System');
  }

  if (!suffix && instruct.wrap) {
    suffix = '\n';
  }

  const separator = instruct.wrap ? '\n' : '';

  // Don't include the name if it's empty
  const textArray =
    includeNames && name ? [prefix, `${name}: ${mes}` + suffix] : [prefix, mes + suffix];
  const text = textArray.filter((x) => x).join(separator);

  return text;
}

/**
 * 1:1 移植自 ST `instruct-mode.js:466`。原代码已 deprecated，几乎是
 * identity 函数；保留是为了 instruct.ts 门面对外签名完整。
 *
 * @param {string} systemPrompt
 * @param {InstructSettings|null} [_customInstruct=null] 占位参数，未被使用
 * @returns {string}
 * @deprecated Currently doesn't do anything useful.
 */
export function formatInstructModeSystemPrompt(systemPrompt, _customInstruct = null) {
  return systemPrompt || '';
}

/**
 * 把整段 story string（character description / personality / scenario 等
 * 拼好的字符串）按 instruct mode 规则前后包裹 `story_string_prefix` /
 * `story_string_suffix`。
 * 1:1 移植自 ST `instruct-mode.js:478`。
 *
 * 行为细节：当 context.story_string_position === IN_CHAT 时，story 会被
 * 视为「内嵌进 chat 流」，由消息级 sequence 包裹，本函数不再添加 prefix/suffix。
 *
 * @param {string} storyString
 * @param {object} [params]
 * @param {ContextSettings|null} [params.customContext=null]
 * @param {InstructSettings|null} [params.customInstruct=null]
 * @returns {string}
 */
export function formatInstructModeStoryString(
  storyString,
  { customContext = null, customInstruct = null } = {}
) {
  if (!storyString) {
    return '';
  }

  const instructSettings = structuredClone(customInstruct ?? power_user.instruct);
  const contextSettings = structuredClone(customContext ?? power_user.context);
  const storyStringPosition =
    contextSettings.story_string_position ?? extension_prompt_types.IN_PROMPT;

  // Only wrap if not in-chat position (it will be wrapped by message sequences instead)
  const applySequences = storyStringPosition !== extension_prompt_types.IN_CHAT;
  const separator = instructSettings.wrap ? '\n' : '';
  if (applySequences && instructSettings.story_string_prefix) {
    // TODO: Replace with a proper 'System' prompt entity name input
    const prefix = substituteParams(instructSettings.story_string_prefix).replace(
      /{{name}}/gi,
      'System'
    );
    storyString = prefix + separator + storyString;
  }

  if (applySequences && instructSettings.story_string_suffix) {
    const suffix = substituteParams(instructSettings.story_string_suffix);
    storyString = storyString + suffix;
  }

  return storyString;
}

/**
 * 把 mes_example 数组按 instruct mode 规则格式化。每个元素是一段
 * 多行字符串（用 `<START>` 分隔块），输出是按 input/output sequence
 * 包裹好的若干段子。1:1 移植自 ST `instruct-mode.js:511`。
 *
 * 注意：本函数直接读 `power_user.instruct` / `power_user.context`，
 * 不接受 customInstruct 参数（与 ST 原版一致）。调用方应通过 setRuntimeCtx
 * 在调用前把 power_user 注入到 host。
 *
 * @param {string[]} mesExamplesArray 原始 mes_example 块数组
 * @param {string} name1 user 名字（影响 user prefix/suffix 的 macro 替换）
 * @param {string} name2 character 名字
 * @returns {string[]} 格式化后的字符串数组（每个元素是一条独立消息）
 */
export function formatInstructModeExamples(mesExamplesArray, name1, name2) {
  const blockHeading = power_user.context.example_separator
    ? `${substituteParams(power_user.context.example_separator)}\n`
    : '';

  if (power_user.instruct.skip_examples) {
    return mesExamplesArray.map((x) => x.replace(/<START>\n/i, blockHeading));
  }

  const includeNames = power_user.instruct.names_behavior === names_behavior_types.ALWAYS;
  // 用 Boolean(...) 强制成 boolean——ST 原版 JS 这里是 `string | boolean`，
  // 但 parseExampleIntoIndividual 第二参数 TS 签名是 boolean。运行时行为
  // 完全等价（ST 也只把它当真值判断用）。
  const includeGroupNames = Boolean(
    selected_group &&
    [names_behavior_types.ALWAYS, names_behavior_types.FORCE].includes(
      power_user.instruct.names_behavior
    )
  );

  let inputPrefix = power_user.instruct.input_sequence || '';
  let outputPrefix = power_user.instruct.output_sequence || '';
  let inputSuffix = power_user.instruct.input_suffix || '';
  let outputSuffix = power_user.instruct.output_suffix || '';

  if (power_user.instruct.macro) {
    inputPrefix = substituteParams(inputPrefix, { name1Override: name1, name2Override: name2 });
    outputPrefix = substituteParams(outputPrefix, { name1Override: name1, name2Override: name2 });
    inputSuffix = substituteParams(inputSuffix, { name1Override: name1, name2Override: name2 });
    outputSuffix = substituteParams(outputSuffix, { name1Override: name1, name2Override: name2 });

    inputPrefix = inputPrefix.replace(/{{name}}/gi, name1);
    outputPrefix = outputPrefix.replace(/{{name}}/gi, name2);
    inputSuffix = inputSuffix.replace(/{{name}}/gi, name1);
    outputSuffix = outputSuffix.replace(/{{name}}/gi, name2);

    if (!inputSuffix && power_user.instruct.wrap) {
      inputSuffix = '\n';
    }

    if (!outputSuffix && power_user.instruct.wrap) {
      outputSuffix = '\n';
    }
  }

  const separator = power_user.instruct.wrap ? '\n' : '';
  /** @type {string[]} */
  const formattedExamples = [];

  for (const item of mesExamplesArray) {
    const cleanedItem = item.replace(/<START>/i, '{Example Dialogue:}').replace(/\r/gm, '');
    const blockExamples = parseExampleIntoIndividual(cleanedItem, includeGroupNames);

    if (blockExamples.length === 0) {
      continue;
    }

    if (blockHeading) {
      formattedExamples.push(blockHeading);
    }

    for (const example of blockExamples) {
      // If group names were included, we don't want to add any additional prefix as it already was applied.
      // Otherwise, if force group/persona names is set, we should override the include names for the user placeholder
      const includeThisName =
        !includeGroupNames &&
        (includeNames ||
          (power_user.instruct.names_behavior === names_behavior_types.FORCE &&
            example.name == 'example_user'));

      const prefix = example.name == 'example_user' ? inputPrefix : outputPrefix;
      const suffix = example.name == 'example_user' ? inputSuffix : outputSuffix;
      const name = example.name == 'example_user' ? name1 : name2;
      const messageContent = includeThisName ? `${name}: ${example.content}` : example.content;
      const formattedMessage = [prefix, messageContent + suffix].filter((x) => x).join(separator);
      formattedExamples.push(formattedMessage);
    }
  }

  if (formattedExamples.length === 0) {
    return mesExamplesArray.map((x) => x.replace(/<START>\n/i, blockHeading));
  }
  return formattedExamples;
}

/**
 * 计算最后一条 generation cue（"AI 接下来该说话了" 那一行 prompt）。
 * 这是 instruct mode 里**最关键**的一行：它决定了 LLM 拿到 prompt 之后
 * 直接续什么——错一个字符整个对话都跑偏。
 * 1:1 移植自 ST `instruct-mode.js:593`。
 *
 * @param {string} name 当前应该回应的角色名
 * @param {boolean} isImpersonate 是否是 user 代笔模式（让 AI 帮 user 说话）
 * @param {string} promptBias 用户在 UI 里手填的 prompt bias（一般是空）
 * @param {string} name1 user 名字
 * @param {string} name2 character 名字
 * @param {boolean} isQuiet 是否是 quiet 生成（不写入 chat 的隐式生成）
 * @param {boolean} isQuietToLoud quiet 生成模式下是否要发声出来
 * @param {InstructSettings|null} [customInstruct=null]
 * @returns {string}
 */
export function formatInstructModePrompt(
  name,
  isImpersonate,
  promptBias,
  name1,
  name2,
  isQuiet,
  isQuietToLoud,
  customInstruct = null
) {
  const instruct = structuredClone(customInstruct ?? power_user.instruct);
  const includeNames =
    name &&
    (instruct.names_behavior === names_behavior_types.ALWAYS ||
      (!!selected_group && instruct.names_behavior === names_behavior_types.FORCE)) &&
    !(isQuiet && !isQuietToLoud);

  function getSequence() {
    // User impersonation prompt
    if (isImpersonate) {
      return instruct.input_sequence;
    }

    // Neutral / system / quiet prompt
    // Use a special quiet instruct sequence if defined, or assistant's output sequence otherwise
    if (isQuiet && !isQuietToLoud) {
      return instruct.last_system_sequence || instruct.output_sequence;
    }

    // Quiet in-character prompt
    if (isQuiet && isQuietToLoud) {
      return instruct.last_output_sequence || instruct.output_sequence;
    }

    // Default AI response
    return instruct.last_output_sequence || instruct.output_sequence;
  }

  let sequence = getSequence() || '';
  let nameFiller = '';

  // A hack for Mistral's formatting that has a normal output sequence ending with a space
  if (
    includeNames &&
    instruct.last_output_sequence &&
    instruct.output_sequence &&
    sequence === instruct.last_output_sequence &&
    /\s$/.test(instruct.output_sequence) &&
    !/\s$/.test(instruct.last_output_sequence)
  ) {
    nameFiller = instruct.output_sequence.slice(-1);
  }

  if (instruct.macro) {
    sequence = substituteParams(sequence, { name1Override: name1, name2Override: name2 });
    sequence = sequence.replace(/{{name}}/gi, name || 'System');
  }

  const separator = instruct.wrap ? '\n' : '';
  let text = includeNames
    ? separator + sequence + separator + nameFiller + `${name}:`
    : separator + sequence;

  // Quiet prompt already has a newline at the end
  if (isQuiet && separator) {
    text = text.slice(separator.length);
  }

  if (!isImpersonate && promptBias) {
    text += includeNames ? promptBias : separator + promptBias.trimStart();
  }

  return (instruct.wrap ? text.trimEnd() : text) + (includeNames ? '' : separator);
}

/**
 * 注册 instruct mode 相关宏（`{{instructStoryStringPrefix}}` /
 * `{{instructInput}}` / `{{instructOutput}}` / `{{systemPrompt}}` 等
 * 19 条），返回 `{ regex, replace }` 对数组，由 macros 引擎兜底替换。
 * 1:1 移植自 ST `instruct-mode.js:673`。
 *
 * 注意：返回的 `replace` 是闭包，它在被宏引擎调用时**实时**读取
 * power_user 的当前状态（live binding 走 host.js），所以同一份返回值
 * 数组在 power_user 变化后行为也跟着变。
 *
 * @param {{ charPrompt?: string }} env macro 引擎传进来的 env 子集
 * @returns {Array<{ regex: RegExp, replace: () => string }>}
 */
export function getInstructMacros(env) {
  /** @type {{ key: string, value: string, enabled: boolean }[]} */
  const instructMacros = [
    // Instruct template macros
    {
      key: 'instructStoryStringPrefix',
      value: power_user.instruct.story_string_prefix,
      enabled: power_user.instruct.enabled,
    },
    {
      key: 'instructStoryStringSuffix',
      value: power_user.instruct.story_string_suffix,
      enabled: power_user.instruct.enabled,
    },
    {
      key: 'instructInput|instructUserPrefix',
      value: power_user.instruct.input_sequence,
      enabled: power_user.instruct.enabled,
    },
    {
      key: 'instructUserSuffix',
      value: power_user.instruct.input_suffix,
      enabled: power_user.instruct.enabled,
    },
    {
      key: 'instructOutput|instructAssistantPrefix',
      value: power_user.instruct.output_sequence,
      enabled: power_user.instruct.enabled,
    },
    {
      key: 'instructSeparator|instructAssistantSuffix',
      value: power_user.instruct.output_suffix,
      enabled: power_user.instruct.enabled,
    },
    {
      key: 'instructSystemPrefix',
      value: power_user.instruct.system_sequence,
      enabled: power_user.instruct.enabled,
    },
    {
      key: 'instructSystemSuffix',
      value: power_user.instruct.system_suffix,
      enabled: power_user.instruct.enabled,
    },
    {
      key: 'instructFirstOutput|instructFirstAssistantPrefix',
      value: power_user.instruct.first_output_sequence || power_user.instruct.output_sequence,
      enabled: power_user.instruct.enabled,
    },
    {
      key: 'instructLastOutput|instructLastAssistantPrefix',
      value: power_user.instruct.last_output_sequence || power_user.instruct.output_sequence,
      enabled: power_user.instruct.enabled,
    },
    {
      key: 'instructStop',
      value: power_user.instruct.stop_sequence,
      enabled: power_user.instruct.enabled,
    },
    {
      key: 'instructUserFiller',
      value: power_user.instruct.user_alignment_message,
      enabled: power_user.instruct.enabled,
    },
    {
      key: 'instructSystemInstructionPrefix',
      value: power_user.instruct.last_system_sequence,
      enabled: power_user.instruct.enabled,
    },
    {
      key: 'instructFirstInput|instructFirstUserPrefix',
      value: power_user.instruct.first_input_sequence || power_user.instruct.input_sequence,
      enabled: power_user.instruct.enabled,
    },
    {
      key: 'instructLastInput|instructLastUserPrefix',
      value: power_user.instruct.last_input_sequence || power_user.instruct.input_sequence,
      enabled: power_user.instruct.enabled,
    },
    // System prompt macros
    {
      key: 'systemPrompt',
      value:
        power_user.prefer_character_prompt && env.charPrompt
          ? env.charPrompt
          : power_user.sysprompt.content,
      enabled: power_user.sysprompt.enabled,
    },
    {
      key: 'defaultSystemPrompt|instructSystem|instructSystemPrompt',
      value: power_user.sysprompt.content,
      enabled: power_user.sysprompt.enabled,
    },
    // Context template macros
    {
      key: 'chatSeparator',
      value: power_user.context.example_separator,
      enabled: true,
    },
    {
      key: 'chatStart',
      value: power_user.context.chat_start,
      enabled: true,
    },
  ];

  /** @type {Array<{ regex: RegExp, replace: () => string }>} */
  const macros = [];

  for (const { key, value, enabled } of instructMacros) {
    const regex = new RegExp(`{{(${key})}}`, 'gi');
    const replace = () => (enabled ? value : '');
    macros.push({ regex, replace });
  }

  return macros;
}
