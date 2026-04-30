/**
 * instruct/parseExampleIntoIndividual.js
 *
 * 1:1 剪线式硬搬自 `public/scripts/openai.js:700-758` 的
 * `parseExampleIntoIndividual` 函数。原版属于 ChatCompletion 装配
 * 链的辅助函数，但 instruct-mode.js 也会用它解析 mes_example 块。
 *
 * 剪线决策：
 *   - `getGroupNames` 原 import 自 './group-chats.js'，搬到
 *     `../macros/runtime/host.js` 与其它 host 桁状态共置
 *   - `name1` / `name2` / `selected_group` 同样从 host.js 取 live binding
 *
 * 函数体内一行注释（含粗俗用语）是 ST 原作者的注释，保留以维持
 * "剪线式硬搬，diff 越小越好" 的迁移原则。
 *
 * @typedef {{ role: string, content: string, name: string }} ExampleMessage
 */

import { name1, name2, selected_group, getGroupNames } from '../macros/runtime/host.js';

/**
 * 把 ST 角色卡的 mes_example 块（一段多行字符串，里面用
 * `${name1}:` / `${name2}:` 标记 user/bot 段落）解析成
 * `[{ role, content, name }]` 数组。在 group chat 场景下，
 * 段头如果是 group 成员的名字，也会被识别成 example_assistant。
 *
 * miniAPP 后端目前 `selected_group` 永为 null，groupBotNames 始终
 * 为空，所以 group 分支永远短路；保留代码与 ST 完全一致以便未来
 * 接入 group chat 时无需再改。
 *
 * @param {string} messageExampleString 原始 mes_example 字符串
 * @param {boolean} [appendNamesForGroup=true] group chat 时是否在段落
 *   前追加角色名前缀
 * @returns {ExampleMessage[]}
 */
export function parseExampleIntoIndividual(messageExampleString, appendNamesForGroup = true) {
  const groupBotNames = getGroupNames().map((name) => `${name}:`);

  /** @type {ExampleMessage[]} */
  let result = []; // array of msgs
  let tmp = messageExampleString.split('\n');
  /** @type {string[]} */
  let cur_msg_lines = [];
  let in_user = false;
  let in_bot = false;
  let botName = name2;

  // DRY my cock and balls :)
  /**
   * @param {string} name
   * @param {string} role
   * @param {string} system_name
   */
  function add_msg(name, role, system_name) {
    // join different newlines (we split them by \n and join by \n)
    // remove char name
    // strip to remove extra spaces
    let parsed_msg = cur_msg_lines
      .join('\n')
      .replace(name + ':', '')
      .trim();

    if (
      appendNamesForGroup &&
      selected_group &&
      ['example_user', 'example_assistant'].includes(system_name)
    ) {
      parsed_msg = `${name}: ${parsed_msg}`;
    }

    result.push({ role: role, content: parsed_msg, name: system_name });
    cur_msg_lines = [];
  }
  // skip first line as it'll always be "This is how {bot name} should talk"
  for (let i = 1; i < tmp.length; i++) {
    let cur_str = tmp[i] ?? '';
    // if it's the user message, switch into user mode and out of bot mode
    // yes, repeated code, but I don't care
    if (cur_str.startsWith(name1 + ':')) {
      in_user = true;
      // we were in the bot mode previously, add the message
      if (in_bot) {
        add_msg(botName, 'system', 'example_assistant');
      }
      in_bot = false;
    } else if (
      cur_str.startsWith(name2 + ':') ||
      groupBotNames.some((n) => cur_str.startsWith(n))
    ) {
      if (!cur_str.startsWith(name2 + ':') && groupBotNames.length) {
        botName = cur_str.split(':')[0] ?? botName;
      }

      in_bot = true;
      // we were in the user mode previously, add the message
      if (in_user) {
        add_msg(name1, 'system', 'example_user');
      }
      in_user = false;
    }
    // push the current line into the current message array only after checking for presence of user/bot
    cur_msg_lines.push(cur_str);
  }
  // Special case for last message in a block because we don't have a new message to trigger the switch
  if (in_user) {
    add_msg(name1, 'system', 'example_user');
  } else if (in_bot) {
    add_msg(botName, 'system', 'example_assistant');
  }
  return result;
}
