/**
 * world-info/constants.js
 *
 * Step 2 — World Info 扫描层的枚举常量。
 * 字节级对齐自 SillyTavern 1.17.0 `public/scripts/world-info.js`。
 *
 * 使用 .js + JSDoc（而非 .ts），与 macros/runtime/constants.js 同档，
 * 确保 world-info/world-info.js 核心层可直接 import 而无需任何 TS 编译器桥接。
 *
 * 枚举清单：
 *   scan_state              — 扫描状态机（NONE/INITIAL/RECURSION/MIN_ACTIVATIONS）
 *   world_info_position     — 条目插入位置（before/after/ANTop/.../outlet）
 *   wi_anchor_position      — EM 桶子位置（before/after）
 *   world_info_logic        — 二级关键词匹配逻辑（AND_ANY/NOT_ALL/NOT_ANY/AND_ALL）
 *   world_info_insertion_strategy — 多书合并排序策略（evenly/character_first/global_first）
 *   extension_prompt_roles  — atDepth 条目的角色枚举（mirrored from script.js）
 *
 * 额外常量：
 *   DEFAULT_DEPTH / DEFAULT_WEIGHT / MAX_SCAN_DEPTH / KNOWN_DECORATORS
 */

/**
 * @enum {number} 扫描状态机。
 * 对应 `public/scripts/world-info.js:39` 的 `scan_state`。
 *
 *   NONE           = 0  → 停止扫描
 *   INITIAL        = 1  → 初始状态（第一轮）
 *   RECURSION      = 2  → 递归触发的轮次
 *   MIN_ACTIVATIONS= 3  → 最小激活数未满，继续推进 depth
 */
export const scan_state = {
  NONE: 0,
  INITIAL: 1,
  RECURSION: 2,
  MIN_ACTIVATIONS: 3,
};

/**
 * @enum {number} 条目插入位置（分桶依据）。
 * 对应 `public/scripts/world-info.js:851` 的 `world_info_position`。
 *
 *   before   = 0  → WIBeforeEntries（角色卡之前）
 *   after    = 1  → WIAfterEntries（角色卡之后）
 *   ANTop    = 2  → ANTopEntries（Author's Note 上方）
 *   ANBottom = 3  → ANBottomEntries（Author's Note 下方）
 *   atDepth  = 4  → WIDepthEntries（按深度插入聊天历史）
 *   EMTop    = 5  → EMEntries position=before（示例块上方）
 *   EMBottom = 6  → EMEntries position=after（示例块下方）
 *   outlet   = 7  → WIOutletEntries（命名 outlet 插槽）
 */
export const world_info_position = {
  before: 0,
  after: 1,
  ANTop: 2,
  ANBottom: 3,
  atDepth: 4,
  EMTop: 5,
  EMBottom: 6,
  outlet: 7,
};

/**
 * @enum {number} EM（示例块）锚点子位置。
 * 对应 `public/scripts/world-info.js:862` 的 `wi_anchor_position`。
 */
export const wi_anchor_position = {
  before: 0,
  after: 1,
};

/**
 * @enum {number} 二级关键词匹配逻辑。
 * 对应 `public/scripts/world-info.js:29` 的 `world_info_logic`。
 *
 *   AND_ANY = 0  → 二级关键词中任意一个匹配即满足（默认）
 *   NOT_ALL = 1  → 二级关键词全部不匹配才满足
 *   NOT_ANY = 2  → 二级关键词任意一个不匹配即满足
 *   AND_ALL = 3  → 二级关键词全部匹配才满足
 */
export const world_info_logic = {
  AND_ANY: 0,
  NOT_ALL: 1,
  NOT_ANY: 2,
  AND_ALL: 3,
};

/**
 * @enum {number} 多书合并的排序/优先级策略。
 * 对应 `public/scripts/world-info.js:23` 的 `world_info_insertion_strategy`。
 *
 *   evenly          = 0  → 全局书与角色书按 order 统一排序
 *   character_first = 1  → 角色书条目优先（同 order 时排前）
 *   global_first    = 2  → 全局书条目优先（同 order 时排前）
 */
export const world_info_insertion_strategy = {
  evenly: 0,
  character_first: 1,
  global_first: 2,
};

/**
 * @enum {number} atDepth 条目的角色枚举。
 * 对应 `public/script.js` 的 `extension_prompt_roles`。
 * 用于 WIDepthEntries 的 `role` 字段以及 setExtensionPrompt 的 role 参数。
 *
 *   SYSTEM    = 0
 *   USER      = 1
 *   ASSISTANT = 2
 */
export const extension_prompt_roles = {
  SYSTEM: 0,
  USER: 1,
  ASSISTANT: 2,
};

// ─── 额外常量 ───────────────────────────────────────────────────────────────

/** atDepth 条目缺省的插入深度（消息数）。对应 ST `DEFAULT_DEPTH = 4`。 */
export const DEFAULT_DEPTH = 4;

/** 条目缺省的分组权重。对应 ST `DEFAULT_WEIGHT = 100`。 */
export const DEFAULT_WEIGHT = 100;

/**
 * depthBuffer 的最大长度上限。
 * 对应 ST `MAX_SCAN_DEPTH = 1000`。
 */
export const MAX_SCAN_DEPTH = 1000;

/**
 * 已知的 decorator 字符串列表。
 * 对应 ST `KNOWN_DECORATORS = ['@@activate', '@@dont_activate']`。
 * @type {string[]}
 */
export const KNOWN_DECORATORS = ['@@activate', '@@dont_activate'];
