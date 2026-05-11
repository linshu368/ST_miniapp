/**
 * world-info/types.ts
 *
 * Step 2 — World Info 扫描层的全部 TypeScript 接口定义。
 *
 * 设计原则：
 *   - 本文件只被 TS 层（world-info.ts 门面 + test 层）import。
 *     world-info/world-info.js 核心层是纯 .js，不 import 本文件。
 *   - 字段命名与 ST 原版 `newWorldInfoEntryDefinition`（world-info.js:3022）
 *     保持 1:1 对齐，避免任何 camelCase 转换。
 *   - 所有接口均附默认值注释，方便调用方构造最小 fixture。
 */

// ─── 枚举类型别名（从 constants.js 镜像过来，供 TS 类型系统使用） ────────────

/** 扫描状态机值域：0=NONE / 1=INITIAL / 2=RECURSION / 3=MIN_ACTIVATIONS */
export type ScanState = 0 | 1 | 2 | 3;

/** 条目插入位置值域：0–7，对应 world_info_position 枚举 */
export type WIPosition = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** 二级关键词逻辑值域：0=AND_ANY / 1=NOT_ALL / 2=NOT_ANY / 3=AND_ALL */
export type WILogic = 0 | 1 | 2 | 3;

/** 角色枚举值域：0=SYSTEM / 1=USER / 2=ASSISTANT */
export type ExtensionPromptRole = 0 | 1 | 2;

/** 时序效果类型 */
export type TimedEffectType = 'sticky' | 'cooldown' | 'delay';

// ─── WI 条目完整字段（对齐 newWorldInfoEntryDefinition） ─────────────────────

/**
 * 单条 World Info 条目的完整字段定义。
 * 字段顺序与 ST `newWorldInfoEntryDefinition`（world-info.js:3022）一致，
 * 迁移时以此为准，防止遗漏字段。
 */
export interface WIEntry {
  /** 条目所属书名（getSortedEntries 注入，原版无此字段） */
  world: string;
  /** 条目唯一 ID（数字键，loadWorldInfo 时从 data.entries 的 key 注入） */
  uid: number;

  // ── 触发键 ──────────────────────────────────────────────────────────────
  /** 一级关键词数组（字符串或 /regex/ 格式）。默认 [] */
  key: string[];
  /** 二级关键词数组。默认 [] */
  keysecondary: string[];
  /** 二级关键词匹配逻辑。默认 0（AND_ANY） */
  selectiveLogic: WILogic;
  /** 是否启用二级关键词（selective mode）。默认 true */
  selective: boolean;

  // ── 内容 ────────────────────────────────────────────────────────────────
  /** 激活后注入 prompt 的文本（可含 {{macro}}）。默认 '' */
  content: string;
  /** 备注（不注入 prompt，仅编辑器展示）。默认 '' */
  comment: string;

  // ── 激活控制 ────────────────────────────────────────────────────────────
  /** 是否禁用。默认 false */
  disable: boolean;
  /** 是否强制激活（constant）。默认 false */
  constant: boolean;
  /** 是否向量化触发（ST 云功能，迁移版忽略）。默认 false */
  vectorized: boolean;
  /** 激活概率 0–100。默认 100 */
  probability: number;
  /** 是否启用概率检查。默认 true */
  useProbability: boolean;

  // ── 排序与预算 ───────────────────────────────────────────────────────────
  /** 排序权重，数字越大越靠后处理（分桶时 unshift → 最终越靠前）。默认 100 */
  order: number;
  /** 是否忽略 token 预算限制。默认 false */
  ignoreBudget: boolean;

  // ── 插入位置 ─────────────────────────────────────────────────────────────
  /** 插入位置枚举值（0–7）。默认 0（before） */
  position: WIPosition;
  /** atDepth 模式的插入深度（消息数）。默认 4（DEFAULT_DEPTH） */
  depth: number;
  /** outlet 模式的插槽名称。默认 '' */
  outletName: string;
  /** atDepth 模式的角色（0=SYSTEM/1=USER/2=ASSISTANT）。默认 0 */
  role: ExtensionPromptRole;

  // ── 递归控制 ─────────────────────────────────────────────────────────────
  /** 是否从递归扫描中排除（被激活后不加入 recurseBuffer）。默认 false */
  excludeRecursion: boolean;
  /** 是否阻止自身触发递归（content 不被后续扫描匹配）。默认 false */
  preventRecursion: boolean;
  /**
   * 延迟到第 N 轮递归才激活（0=无延迟，>=1=第 N 轮 RECURSION 才考虑）。
   * 默认 0
   */
  delayUntilRecursion: number;

  // ── 扫描覆盖（per-entry 覆盖全局设置，null=继承全局） ───────────────────
  /** per-entry 扫描深度覆盖，null=继承全局 world_info_depth */
  scanDepth: number | null;
  /** per-entry 大小写敏感覆盖，null=继承全局 */
  caseSensitive: boolean | null;
  /** per-entry 全词匹配覆盖，null=继承全局 */
  matchWholeWords: boolean | null;
  /** per-entry 分组评分覆盖，null=继承全局 */
  useGroupScoring: boolean | null;

  // ── 静态扫描目标开关 ─────────────────────────────────────────────────────
  /** 是否扫描 persona description。默认 false */
  matchPersonaDescription: boolean;
  /** 是否扫描 character description。默认 false */
  matchCharacterDescription: boolean;
  /** 是否扫描 character personality。默认 false */
  matchCharacterPersonality: boolean;
  /** 是否扫描 character depth prompt（角色备注）。默认 false */
  matchCharacterDepthPrompt: boolean;
  /** 是否扫描 scenario。默认 false */
  matchScenario: boolean;
  /** 是否扫描 creator notes。默认 false */
  matchCreatorNotes: boolean;

  // ── 分组 ─────────────────────────────────────────────────────────────────
  /** inclusion group 名称（同组竞争，留最高评分）。默认 '' */
  group: string;
  /** 是否允许本条目覆盖同组的 sticky 条目。默认 false */
  groupOverride: boolean;
  /** 分组评分权重。默认 100（DEFAULT_WEIGHT） */
  groupWeight: number;

  // ── 时序效果 ─────────────────────────────────────────────────────────────
  /** 激活后持续粘性 N 轮（null=不启用）。默认 null */
  sticky: number | null;
  /** 激活后冷却 N 轮（null=不启用）。默认 null */
  cooldown: number | null;
  /** 聊天长度小于 N 时压制激活（null=不启用）。默认 null */
  delay: number | null;

  // ── 角色过滤 ─────────────────────────────────────────────────────────────
  /** 允许激活的角色名白名单（空=无限制）。默认 [] */
  characterFilterNames: string[];
  /** 允许激活的角色 tag 白名单。默认 [] */
  characterFilterTags: string[];
  /** 为 true 时翻转为黑名单逻辑。默认 false */
  characterFilterExclude: boolean;

  // ── 生成触发器 ───────────────────────────────────────────────────────────
  /** 限制本条目仅在特定生成类型时激活（空=全类型）。默认 [] */
  triggers: string[];

  // ── 其他 ─────────────────────────────────────────────────────────────────
  /** UI 关联的 automation ID（迁移版忽略，保留字段）。默认 '' */
  automationId: string;
  /** 是否显示 memo（编辑器 UI，迁移版忽略）。默认 false */
  addMemo: boolean;

  // ── 运行时注入字段（getSortedEntries 计算后附加，原版无此字段定义） ──────
  /** decorator 解析结果（@@activate / @@dont_activate）。运行时注入 */
  decorators?: string[];
  /** 条目内容的哈希值（用于时序效果匹配）。运行时注入 */
  hash?: number;
}

// ─── WI 全局扫描数据（与聊天历史分开传入的静态文本） ────────────────────────

/**
 * 与聊天历史无关的静态扫描数据，对应 ST `WIGlobalScanData`（world-info.js:100）。
 * 这些字段由调用方（Generate 主流水线）从角色卡 + persona 中提取并传入。
 */
export interface WIGlobalScanData {
  /** 生成触发类型，如 'normal' / 'continue' / 'impersonate' 等。默认 'normal' */
  trigger: string;
  /** 用户 persona description */
  personaDescription: string;
  /** 角色 description */
  characterDescription: string;
  /** 角色 personality */
  characterPersonality: string;
  /** 角色 depth prompt（角色备注/character notes） */
  characterDepthPrompt: string;
  /** scenario */
  scenario: string;
  /** creator notes */
  creatorNotes: string;
}

// ─── WI 全局配置（打包自原版十几个全局变量） ────────────────────────────────

/**
 * World Info 扫描的全局配置，对应 ST `world-info.js` 顶层的散装全局变量。
 * 迁移版统一打包为此接口，调用方显式传入，不读模块级全局。
 *
 * 所有字段均可选，未传时在内部使用默认值（与 ST 原版默认值一致）。
 */
export interface WISettings {
  /**
   * 扫描的消息深度（从最新消息往前看 N 条）。
   * 对应 ST `world_info_depth`。默认 2
   */
  world_info_depth?: number;
  /**
   * 最少激活条目数（> 0 时触发 MIN_ACTIVATIONS 状态机）。
   * 对应 ST `world_info_min_activations`。默认 0
   */
  world_info_min_activations?: number;
  /**
   * MIN_ACTIVATIONS 状态下扫描的最大消息深度（0=不限）。
   * 对应 ST `world_info_min_activations_depth_max`。默认 0
   */
  world_info_min_activations_depth_max?: number;
  /**
   * Token 预算（占 maxContext 的百分比，0–100）。
   * 对应 ST `world_info_budget`。默认 25
   */
  world_info_budget?: number;
  /**
   * Token 预算绝对上限（0=不限）。
   * 对应 ST `world_info_budget_cap`。默认 0
   */
  world_info_budget_cap?: number;
  /**
   * 是否在 atDepth 插入时包含 name1/name2 头。
   * 对应 ST `world_info_include_names`。默认 true
   */
  world_info_include_names?: boolean;
  /**
   * 是否启用递归扫描（激活条目的 content 再次扫描触发更多条目）。
   * 对应 ST `world_info_recursive`。默认 false
   */
  world_info_recursive?: boolean;
  /**
   * 超出预算时是否弹出警告（迁移版忽略，保留字段）。
   * 对应 ST `world_info_overflow_alert`。默认 false
   */
  world_info_overflow_alert?: boolean;
  /**
   * 是否大小写敏感（全局默认，可被 entry.caseSensitive 覆盖）。
   * 对应 ST `world_info_case_sensitive`。默认 false
   */
  world_info_case_sensitive?: boolean;
  /**
   * 是否全词匹配（全局默认，可被 entry.matchWholeWords 覆盖）。
   * 对应 ST `world_info_match_whole_words`。默认 false
   */
  world_info_match_whole_words?: boolean;
  /**
   * 是否使用分组评分（全局默认，可被 entry.useGroupScoring 覆盖）。
   * 对应 ST `world_info_use_group_scoring`。默认 false
   */
  world_info_use_group_scoring?: boolean;
  /**
   * 多书合并时的条目排序策略（0=evenly/1=character_first/2=global_first）。
   * 对应 ST `world_info_character_strategy`。默认 1（character_first）
   */
  world_info_character_strategy?: number;
  /**
   * 最大递归步数（0=无限）。
   * 对应 ST `world_info_max_recursion_steps`。默认 0
   */
  world_info_max_recursion_steps?: number;
}

// ─── 四类 Lore 数据源 ────────────────────────────────────────────────────────

/**
 * 调用方传入的四类 lore 数据，对应 ST getSortedEntries() 内部加载的四个来源。
 * 迁移版改为调用方直接提供，不走文件 I/O。
 */
export interface WILoreData {
  /** 全局世界书条目列表（selected_world_info 中所有书的条目合集） */
  globalLore: WIEntry[];
  /** 角色绑定的世界书条目列表（extensions.world + charLore.extraBooks） */
  characterLore: WIEntry[];
  /** 聊天绑定的世界书条目列表（chat_metadata['world_info']） */
  chatLore: WIEntry[];
  /** Persona 绑定的世界书条目列表（persona_description_lorebook） */
  personaLore: WIEntry[];
}

// ─── 扫描函数需要的运行时 ctx（宏展开所需） ──────────────────────────────────

/**
 * World Info 门面需要的运行时上下文，用于在 checkWorldInfo 内部
 * 调用 substituteParams 展开 entry.content / key 中的 {{macro}}。
 *
 * 字段是 SubstituteCtx 的子集，只暴露 WI 实际会读的部分。
 * 调用方一次构造，门面负责 setRuntimeCtx / resetRuntimeCtx。
 */
export interface WICtx {
  /** {{user}} 对应的用户名。默认 '' */
  name1?: string;
  /** {{char}} 对应的角色名。默认 '' */
  name2?: string;
  /** 聊天历史（宏 {{lastMessage}} 等需要）。默认 [] */
  chat?: unknown[];
  /** 聊天元数据（变量、scenario 等）。默认 {} */
  chatMetadata?: Record<string, unknown>;
  /** 当前角色卡列表（{{description}} 等需要）。默认 [] */
  characters?: unknown[];
  /** 当前角色在 characters 数组中的索引（-1=无）。默认 -1 */
  thisChid?: number;
  /** 全局变量存储（{{getglobalvar}}/{{setglobalvar}}）。默认 {} */
  globalVariables?: Record<string, unknown>;
  /** main_api 类型字符串（宏 {{model}} 等需要）。默认 '' */
  mainApi?: string;
}

// ─── 输出分桶结果 ────────────────────────────────────────────────────────────

/**
 * atDepth 桶的单个条目组（同 depth + role 的条目合并进同一个 entries[]）。
 * 对应 ST checkWorldInfo 返回值里的 WIDepthEntries 数组元素。
 */
export interface WIDepthEntry {
  /** 插入深度（消息数，从最新消息算起）*/
  depth: number;
  /** 角色（0=SYSTEM/1=USER/2=ASSISTANT）*/
  role: ExtensionPromptRole;
  /** 该深度+角色下所有条目内容的有序数组（unshift 插入，低 order 在前）*/
  entries: string[];
}

/**
 * EM（示例块）桶的单个条目。
 * 对应 ST checkWorldInfo 返回值里的 EMEntries 数组元素。
 */
export interface WIEMEntry {
  /** 插入在示例块的前（0）还是后（1）*/
  position: 0 | 1;
  /** 条目内容 */
  content: string;
}

/**
 * getWorldInfoPrompt() 的完整返回值。
 * 字段与 ST `WIPromptResult` typedef（world-info.js:149）1:1 对齐，
 * 字段名保持原版（不做 camelCase 转换）。
 *
 * 注意：ST 原版还返回 `allActivatedEntries: Set<any>`，
 * 迁移版同样包含，供调试和后续步骤（Author's Note 整合）使用。
 */
export interface WIPromptResult {
  /** 合并后的"角色卡之前"文本（WIBeforeEntries.join('\n')）*/
  worldInfoBefore: string;
  /** 合并后的"角色卡之后"文本（WIAfterEntries.join('\n')）*/
  worldInfoAfter: string;
  /** 示例块锚点条目列表（EMTop → position:0，EMBottom → position:1）*/
  worldInfoExamples: WIEMEntry[];
  /** 按深度+角色分组的 atDepth 条目列表 */
  worldInfoDepth: WIDepthEntry[];
  /** Author's Note 上方条目内容列表（ANTop）*/
  anBefore: string[];
  /** Author's Note 下方条目内容列表（ANBottom）*/
  anAfter: string[];
  /** outlet 插槽映射 { outletName: string[] } */
  outletEntries: Record<string, string[]>;
  /** 本次扫描所有激活条目的集合（调试 / 后续步骤用）*/
  allActivatedEntries: Set<WIEntry>;
}

// ─── 时序效果持久化结构 ───────────────────────────────────────────────────────

/**
 * 单条时序效果的持久化记录。
 * 对应 ST `WITimedEffect` typedef（world-info.js:136）。
 */
export interface WITimedEffect {
  /** 触发该效果的条目 hash */
  hash: number;
  /** 效果开始时的聊天消息索引 */
  start: number;
  /** 效果结束时的聊天消息索引 */
  end: number;
  /** 受保护的效果（聊天未推进时不移除）*/
  protected: boolean;
}
