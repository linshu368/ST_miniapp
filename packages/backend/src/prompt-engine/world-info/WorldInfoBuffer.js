/**
 * world-info/WorldInfoBuffer.js
 *
 * Step 2.1 — WorldInfoBuffer 迁移。
 * 字节级对齐自 SillyTavern `public/scripts/world-info.js:195–470`。
 *
 * 与原版的唯一结构差异：
 *   1. `getDepth()` 原版读模块级全局 `world_info_depth`，
 *      迁移版改为构造器注入 `settings`（WISettings 对象），
 *      通过 `settings.world_info_depth` 读取，避免硬依赖全局。
 *   2. `matchKeys()` 内部用到的 `parseRegexFromString` / `escapeRegex`
 *      在原版分别来自 world-info.js 自身导出 和 utils.js。
 *      迁移版将两者内联于本文件底部（Step 2.3 的 utils.js 会再次导出，
 *      届时 checkWorldInfo.js 统一 import，本文件不需改动）。
 *   3. `#transformString()` 读 `world_info_case_sensitive` 全局变量，
 *      迁移版改为从 entry 的 `caseSensitive` 字段 fallback 到
 *      `settings.world_info_case_sensitive`（构造器注入）。
 *   4. `matchKeys()` 读 `world_info_match_whole_words`，同上改为 settings。
 *
 * [RISK-2] 三个边界条件必须同时满足才正确（详见 get() 方法内注释）：
 *   1. depth <= #startDepth → 返回空串（MIN_ACTIVATIONS 推进前无内容）
 *   2. #recurseBuffer 仅在 scanState !== MIN_ACTIVATIONS 时才拼入
 *   3. #injectBuffer 始终拼入（与 scanState 无关）
 */

import { scan_state, MAX_SCAN_DEPTH } from './constants.js';

// ─── 内联工具函数（来自 ST utils.js / world-info.js 自身，Step 2.3 再统一导出） ───

/**
 * Escapes special regex characters in a string.
 * 原版来自 `public/scripts/utils.js` 的 `escapeRegex`。
 * @param {string} string
 * @returns {string}
 */
function escapeRegex(string) {
  return string.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

/**
 * Parses a string into a RegExp if it matches the /pattern/flags format.
 * 原版来自 `public/scripts/world-info.js:1859` 的 `parseRegexFromString`。
 * @param {string} input
 * @returns {RegExp|null}
 */
function parseRegexFromString(input) {
  // Extracting the regex pattern and flags
  const delimMatch = input.match(/^\/([\\w\\W]+?)\/([gimsuy]*)$/);
  if (!delimMatch) {
    return null; // Not a valid regex format
  }

  let pattern = delimMatch[1] ?? '';
  const flags = delimMatch[2] ?? '';

  // If we find any unescaped slash delimiter, we also exit out.
  if (pattern.match(/(^|[^\\])\//)) {
    return null;
  }

  // Unescape the slash delimiters
  pattern = pattern.replace('\\/', '/');

  // Then we return the regex. If it fails, it was invalid syntax.
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    return null;
  }
}

// ─── WorldInfoBuffer ────────────────────────────────────────────────────────

/**
 * Manages the text buffers used during a World Info scan pass.
 *
 * 对应 ST `public/scripts/world-info.js:195` 的 `class WorldInfoBuffer`。
 */
export class WorldInfoBuffer {
  /**
   * Map of entries that need to be activated no matter what (external activations).
   * 原版为 static class field；迁移版保持 static，生命周期与 class 一致。
   * @type {Map<string, object>}
   */
  static externalActivations = new Map();

  /**
   * Chat independent data to be scanned (persona / character descriptions etc.)
   * @type {import('./types.js').WIGlobalScanData|null}
   */
  #globalScanData = null;

  /**
   * Array of messages sorted by ascending depth (depth 0 = most recent).
   * @type {string[]}
   */
  #depthBuffer = [];

  /**
   * Array of strings added by recursive scanning.
   * @type {string[]}
   */
  #recurseBuffer = [];

  /**
   * Array of strings added by prompt injections valid for the current scan.
   * @type {string[]}
   */
  #injectBuffer = [];

  /**
   * The skew of the global scan depth. Used in "min activations" mode.
   * @type {number}
   */
  #skew = 0;

  /**
   * The starting depth of the global scan depth.
   * @type {number}
   */
  #startDepth = 0;

  /**
   * WI global settings（迁移版注入，取代原版模块级全局变量）。
   * @type {Required<import('./types.js').WISettings>}
   */
  #settings;

  /**
   * Initialize the buffer with the given messages.
   * @param {string[]} messages          Array of messages (depth 0 = most recent)
   * @param {import('./types.js').WIGlobalScanData} globalScanData  Chat-independent context
   * @param {Required<import('./types.js').WISettings>} settings    WI global settings
   */
  constructor(messages, globalScanData, settings) {
    this.#initDepthBuffer(messages);
    this.#globalScanData = globalScanData;
    this.#settings = settings;
  }

  // ─── 私有方法 ──────────────────────────────────────────────────────────────

  /**
   * Populates the depth buffer with the given messages.
   * @param {string[]} messages
   * @returns {void}
   */
  #initDepthBuffer(messages) {
    for (let depth = 0; depth < MAX_SCAN_DEPTH; depth++) {
      const msg = messages[depth];
      if (msg) {
        this.#depthBuffer[depth] = msg.trim();
      }
      // break if last message is reached
      if (depth === messages.length - 1) {
        break;
      }
    }
  }

  /**
   * Gets a string that respects the case sensitivity setting.
   * @param {string} str
   * @param {import('./types.js').WIEntry} entry
   * @returns {string}
   */
  #transformString(str, entry) {
    // per-entry override → global setting fallback（取代原版读全局变量）
    const caseSensitive = entry.caseSensitive ?? this.#settings.world_info_case_sensitive;
    return caseSensitive ? str : str.toLowerCase();
  }

  // ─── 公开方法 ──────────────────────────────────────────────────────────────

  /**
   * Gets all messages up to the given depth + recursion/inject buffers.
   *
   * [RISK-2] 三个边界条件：
   *   1. depth <= #startDepth → 返回 '' （MIN_ACTIVATIONS 推进前无内容）
   *   2. #recurseBuffer 仅在 scanState !== MIN_ACTIVATIONS 时才拼入
   *   3. #injectBuffer 始终拼入（与 scanState 无关）
   *
   * @param {import('./types.js').WIEntry} entry     The entry being evaluated
   * @param {import('./types.js').ScanState} scanState  Current scan state
   * @returns {string}
   */
  get(entry, scanState) {
    let depth = entry.scanDepth ?? this.getDepth();

    // [RISK-2] 条件 1：depth 未超过 startDepth，没有可扫描的内容
    if (depth <= this.#startDepth) {
      return '';
    }

    if (depth < 0) {
      console.error(`[WI] Invalid WI scan depth ${depth}. Must be >= 0`);
      return '';
    }

    if (depth > MAX_SCAN_DEPTH) {
      console.warn(`[WI] Invalid WI scan depth ${depth}. Truncating to ${MAX_SCAN_DEPTH}`);
      depth = MAX_SCAN_DEPTH;
    }

    const MATCHER = '\x01';
    const JOINER = '\n' + MATCHER;
    let result = MATCHER + this.#depthBuffer.slice(this.#startDepth, depth).join(JOINER);

    // 静态扫描目标（globalScanData 字段）——与 scanState 无关，始终拼入
    if (entry.matchPersonaDescription && this.#globalScanData?.personaDescription) {
      result += JOINER + this.#globalScanData.personaDescription;
    }
    if (entry.matchCharacterDescription && this.#globalScanData?.characterDescription) {
      result += JOINER + this.#globalScanData.characterDescription;
    }
    if (entry.matchCharacterPersonality && this.#globalScanData?.characterPersonality) {
      result += JOINER + this.#globalScanData.characterPersonality;
    }
    if (entry.matchCharacterDepthPrompt && this.#globalScanData?.characterDepthPrompt) {
      result += JOINER + this.#globalScanData.characterDepthPrompt;
    }
    if (entry.matchScenario && this.#globalScanData?.scenario) {
      result += JOINER + this.#globalScanData.scenario;
    }
    if (entry.matchCreatorNotes && this.#globalScanData?.creatorNotes) {
      result += JOINER + this.#globalScanData.creatorNotes;
    }

    // [RISK-2] 条件 3：injectBuffer 始终拼入
    if (this.#injectBuffer.length > 0) {
      result += JOINER + this.#injectBuffer.join(JOINER);
    }

    // [RISK-2] 条件 2：recurseBuffer 仅在非 MIN_ACTIVATIONS 时拼入
    if (this.#recurseBuffer.length > 0 && scanState !== scan_state.MIN_ACTIVATIONS) {
      result += JOINER + this.#recurseBuffer.join(JOINER);
    }

    return result;
  }

  /**
   * Matches the given needle against the haystack, respecting entry settings.
   * @param {string} haystack  The string to search in (pre-built by get())
   * @param {string} needle    The keyword or /regex/ string to match
   * @param {import('./types.js').WIEntry} entry
   * @returns {boolean}
   */
  matchKeys(haystack, needle, entry) {
    // If needle is a /regex/ string, do regex matching (overrides all other options)
    const keyRegex = parseRegexFromString(needle);
    if (keyRegex) {
      return keyRegex.test(haystack);
    }

    // Otherwise, plaintext matching with case/word settings
    haystack = this.#transformString(haystack, entry);
    const transformedString = this.#transformString(needle, entry);

    // per-entry override → global setting fallback（取代原版读全局变量）
    const matchWholeWords = entry.matchWholeWords ?? this.#settings.world_info_match_whole_words;

    if (matchWholeWords) {
      const keyWords = transformedString.split(/\s+/);

      if (keyWords.length > 1) {
        // Multi-word phrase: substring match is sufficient
        return haystack.includes(transformedString);
      } else {
        // Single word: use custom boundaries (include punctuation)
        const regex = new RegExp(`(?:^|\\W)(${escapeRegex(transformedString)})(?:$|\\W)`);
        if (regex.test(haystack)) {
          return true;
        }
      }
    } else {
      return haystack.includes(transformedString);
    }

    return false;
  }

  /**
   * Adds a message to the recursion buffer.
   * Called after a batch of entries are activated to enable recursive scanning.
   * @param {string} message
   */
  addRecurse(message) {
    this.#recurseBuffer.push(message);
  }

  /**
   * Adds an injection string to the inject buffer.
   * Called from extension_prompts that are marked as scannable.
   * @param {string} message
   */
  addInject(message) {
    this.#injectBuffer.push(message);
  }

  /**
   * Checks if the recursion buffer has any content.
   * @returns {boolean}
   */
  hasRecurse() {
    return this.#recurseBuffer.length > 0;
  }

  /**
   * Increments skew to advance the scan range by one message.
   * Called in MIN_ACTIVATIONS mode when not enough entries have been activated.
   */
  advanceScan() {
    this.#skew++;
  }

  /**
   * Returns the effective scan depth (settings depth + current skew).
   * 原版：`return world_info_depth + this.#skew`（读全局变量）。
   * 迁移版：从 this.#settings 读取。
   * @returns {number}
   */
  getDepth() {
    return this.#settings.world_info_depth + this.#skew;
  }

  /**
   * Get the externally activated version of the entry, if any.
   * Used by the `externallyActivated` check in checkWorldInfo.
   * @param {import('./types.js').WIEntry} entry
   * @returns {object|undefined}
   */
  getExternallyActivated(entry) {
    return WorldInfoBuffer.externalActivations.get(`${entry.world}.${entry.uid}`);
  }

  /**
   * Clears all external activations (called at the start of each Generate pass).
   */
  resetExternalEffects() {
    WorldInfoBuffer.externalActivations = new Map();
  }

  /**
   * Gets the match score for the given entry.
   * Used by filterGroupsByScoring() to rank entries within the same inclusion group.
   *
   * 只有正向逻辑（AND_ANY / AND_ALL）计入分组评分；
   * 负向逻辑（NOT_ALL / NOT_ANY）不影响得分。
   *
   * @param {import('./types.js').WIEntry} entry
   * @param {import('./types.js').ScanState} scanState
   * @returns {number}
   */
  getScore(entry, scanState) {
    const bufferState = this.get(entry, scanState);
    let numberOfPrimaryKeys = 0;
    let numberOfSecondaryKeys = 0;
    let primaryScore = 0;
    let secondaryScore = 0;

    // Increment score for every primary key found in the buffer
    if (Array.isArray(entry.key)) {
      numberOfPrimaryKeys = entry.key.length;
      for (const key of entry.key) {
        if (this.matchKeys(bufferState, key, entry)) {
          primaryScore++;
        }
      }
    }

    // Increment score for every secondary key found in the buffer
    if (Array.isArray(entry.keysecondary)) {
      numberOfSecondaryKeys = entry.keysecondary.length;
      for (const key of entry.keysecondary) {
        if (this.matchKeys(bufferState, key, entry)) {
          secondaryScore++;
        }
      }
    }

    // No primary keys → no score
    if (!numberOfPrimaryKeys) {
      return 0;
    }

    // Only positive logic influences the score
    if (numberOfSecondaryKeys > 0) {
      switch (entry.selectiveLogic) {
        // AND_ANY: Add both scores
        case 0: // world_info_logic.AND_ANY
          return primaryScore + secondaryScore;
        // AND_ALL: Add both scores only if all secondary keys matched
        case 3: // world_info_logic.AND_ALL
          return secondaryScore === numberOfSecondaryKeys
            ? primaryScore + secondaryScore
            : primaryScore;
      }
    }

    return primaryScore;
  }
}
