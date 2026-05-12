/**
 * world-info/WorldInfoTimedEffects.js
 *
 * Step 2.2 — WorldInfoTimedEffects 迁移。
 * 字节级对齐自 SillyTavern `public/scripts/world-info.js:475–789`。
 *
 * 与原版的唯一结构差异：
 *   1. `chat_metadata.timedWorldInfo` 全局持久化存储 → 改为：
 *      - 构造器第四参数 `options.timedWorldInfo` 注入初始状态（可选，默认 null）。
 *      - `options.onTimedEffectsUpdate` 回调，每次持久化写入后调用；
 *        为空时静默忽略，fixture 不需要 mock 任何存储层。
 *      - 类内部以 `#timedWorldInfo` 持有该状态的引用并原地 mutate，
 *        语义与原版一致。
 *   2. `isDryRun = true` 时跳过 sticky/cooldown 的所有持久化写入（与原版一致）；
 *      `delay` 效果的读取始终执行（不受 isDryRun 影响，与原版一致）。
 *
 * Done criteria（Step 2.2）:
 *   - isEffectActive('sticky', entry)  对空 effects 状态返回 false
 *   - isEffectActive('cooldown', entry) 对空 effects 状态返回 false
 *   - isEffectActive('delay', entry)   对空 effects 状态返回 false
 */

// ─── WorldInfoTimedEffects ───────────────────────────────────────────────────

/**
 * Manages timed effects (sticky / cooldown / delay) for World Info entries.
 *
 * 对应 ST `public/scripts/world-info.js:475` 的 `class WorldInfoTimedEffects`。
 */
export class WorldInfoTimedEffects {
  /**
   * Array of chat messages.
   * @type {string[]}
   */
  #chat = [];

  /**
   * Array of WI scan entries.
   * @type {import('./types.js').WIScanEntry[]}
   */
  #entries = [];

  /**
   * Is this a dry run?
   * @type {boolean}
   */
  #isDryRun = false;

  /**
   * Persistent timed-effects state (replaces `chat_metadata.timedWorldInfo`).
   * Owned and mutated in-place by this class.
   * @type {{ sticky: Record<string, import('./types.js').WITimedEffect>, cooldown: Record<string, import('./types.js').WITimedEffect> }}
   */
  #timedWorldInfo;

  /**
   * Callback invoked after any persistent write to #timedWorldInfo.
   * Called with the current state so callers can persist it externally.
   * @type {((effects: object) => void) | null}
   */
  #onTimedEffectsUpdate;

  /**
   * Buffer for active timed effects in the current evaluation pass.
   * @type {Record<import('./types.js').TimedEffectType, import('./types.js').WIScanEntry[]>}
   */
  #buffer = {
    sticky: [],
    cooldown: [],
    delay: [],
  };

  /**
   * Callbacks for effect types ending.
   * @type {Record<import('./types.js').TimedEffectType, (entry: import('./types.js').WIScanEntry) => void>}
   */
  #onEnded = {
    /**
     * Callback for when a sticky entry ends.
     * Sets an entry on cooldown immediately if it has a cooldown.
     * @param {import('./types.js').WIScanEntry} entry Entry that ended sticky
     */
    sticky: (entry) => {
      if (!entry.cooldown) {
        return;
      }

      const key = this.#getEntryKey(entry);
      const effect = this.#getEntryTimedEffect('cooldown', entry, true);
      this.#timedWorldInfo.cooldown[key] = effect;
      this.#notifyUpdate();
      console.log(
        `[WI] Adding cooldown entry ${key} on ended sticky: start=${effect.start}, end=${effect.end}, protected=${effect.protected}`
      );
      // Set the cooldown immediately for this evaluation
      this.#buffer.cooldown.push(entry);
    },

    /**
     * Callback for when a cooldown entry ends.
     * No-op, essentially.
     * @param {import('./types.js').WIScanEntry} entry Entry that ended cooldown
     */
    cooldown: (entry) => {
      console.debug('[WI] Cooldown ended for entry', entry.uid);
    },

    delay: () => {},
  };

  /**
   * Initialize the timed effects with the given messages.
   *
   * @param {string[]} chat          Array of chat messages (depth 0 = most recent)
   * @param {import('./types.js').WIScanEntry[]} entries  Array of sorted WI entries
   * @param {boolean} isDryRun       Whether the operation is a dry run
   * @param {object} [options]       Optional overrides
   * @param {object|null} [options.timedWorldInfo]
   *   Initial persistent state（对应 `chat_metadata.timedWorldInfo`）。
   *   传 null 时类内部初始化为空状态。
   * @param {((effects: object) => void)|null} [options.onTimedEffectsUpdate]
   *   每次持久化写入后的回调。为 null 时静默忽略（fixture 模式）。
   */
  constructor(
    chat,
    entries,
    isDryRun = false,
    { timedWorldInfo = null, onTimedEffectsUpdate = null } = {}
  ) {
    this.#chat = chat;
    this.#entries = entries;
    this.#isDryRun = isDryRun;
    this.#onTimedEffectsUpdate = onTimedEffectsUpdate;
    this.#timedWorldInfo = timedWorldInfo ?? {};
    this.#ensureTimedWorldInfo();
  }

  // ─── 私有方法 ──────────────────────────────────────────────────────────────

  /**
   * Verify correct structure of the timed-effects state.
   * 对应原版 `#ensureChatMetadata()`，但操作 #timedWorldInfo 而非 chat_metadata。
   */
  #ensureTimedWorldInfo() {
    ['sticky', 'cooldown'].forEach((type) => {
      // Ensure the property exists and is an object
      if (!this.#timedWorldInfo[type] || typeof this.#timedWorldInfo[type] !== 'object') {
        this.#timedWorldInfo[type] = {};
      }

      // Clean up invalid entries
      Object.entries(this.#timedWorldInfo[type]).forEach(([key, value]) => {
        if (!value || typeof value !== 'object') {
          delete this.#timedWorldInfo[type][key];
        }
      });
    });
  }

  /**
   * Notifies the caller that the persistent state has changed.
   * No-op if no callback was provided.
   */
  #notifyUpdate() {
    if (typeof this.#onTimedEffectsUpdate === 'function') {
      this.#onTimedEffectsUpdate(this.#timedWorldInfo);
    }
  }

  /**
   * Gets a hash for a WI entry.
   * @param {import('./types.js').WIScanEntry} entry WI entry
   * @returns {number} Entry hash
   */
  #getEntryHash(entry) {
    return entry.hash;
  }

  /**
   * Gets a unique-ish key for a WI entry.
   * @param {import('./types.js').WIScanEntry} entry WI entry
   * @returns {string} String key for the entry
   */
  #getEntryKey(entry) {
    return `${entry.world}.${entry.uid}`;
  }

  /**
   * Gets a timed effect record for a WI entry.
   * @param {import('./types.js').TimedEffectType} type Type of timed effect
   * @param {import('./types.js').WIScanEntry} entry WI entry
   * @param {boolean} isProtected If the effect should be protected
   * @returns {import('./types.js').WITimedEffect} Timed effect for the entry
   */
  #getEntryTimedEffect(type, entry, isProtected) {
    return {
      hash: this.#getEntryHash(entry),
      start: this.#chat.length,
      end: this.#chat.length + Number(entry[type]),
      protected: !!isProtected,
    };
  }

  /**
   * Processes entries for a given type of timed effect (sticky / cooldown).
   * @param {import('./types.js').TimedEffectType} type Identifier for the type of timed effect
   * @param {import('./types.js').WIScanEntry[]} buffer Buffer to store active entries
   * @param {(entry: import('./types.js').WIScanEntry) => void} onEnded Callback for when a timed effect ends
   */
  #checkTimedEffectOfType(type, buffer, onEnded) {
    /** @type {[string, import('./types.js').WITimedEffect][]} */
    const effects = Object.entries(this.#timedWorldInfo[type]);
    for (const [key, value] of effects) {
      console.log(`[WI] Processing ${type} entry ${key}`, value);
      const entry = this.#entries.find((x) => String(this.#getEntryHash(x)) === String(value.hash));

      if (this.#chat.length <= Number(value.start) && !value.protected) {
        console.log(
          `[WI] Removing ${type} entry ${key} from timedWorldInfo: chat not advanced`,
          value
        );
        delete this.#timedWorldInfo[type][key];
        this.#notifyUpdate();
        continue;
      }

      // Missing entries (they could be from another character's lorebook)
      if (!entry) {
        if (this.#chat.length >= Number(value.end)) {
          console.log(
            `[WI] Removing ${type} entry from timedWorldInfo: entry not found and interval passed`,
            entry
          );
          delete this.#timedWorldInfo[type][key];
          this.#notifyUpdate();
        }
        continue;
      }

      // Ignore invalid entries (not configured for timed effects)
      if (!entry[type]) {
        console.log(`[WI] Removing ${type} entry from timedWorldInfo: entry not ${type}`, entry);
        delete this.#timedWorldInfo[type][key];
        this.#notifyUpdate();
        continue;
      }

      if (this.#chat.length >= Number(value.end)) {
        console.log(
          `[WI] Removing ${type} entry from timedWorldInfo: ${type} interval passed`,
          entry
        );
        delete this.#timedWorldInfo[type][key];
        this.#notifyUpdate();
        if (typeof onEnded === 'function') {
          onEnded(entry);
        }
        continue;
      }

      buffer.push(entry);
      console.log(`[WI] Timed effect "${type}" applied to entry`, entry);
    }
  }

  /**
   * Processes entries for the "delay" timed effect.
   * delay 是纯读计算（不写持久化），与 isDryRun 无关，始终执行。
   * @param {import('./types.js').WIScanEntry[]} buffer Buffer to store delayed entries
   */
  #checkDelayEffect(buffer) {
    for (const entry of this.#entries) {
      if (!entry.delay) {
        continue;
      }

      if (this.#chat.length < entry.delay) {
        buffer.push(entry);
        console.log('[WI] Timed effect "delay" applied to entry', entry);
      }
    }
  }

  /**
   * Sets a timed effect of a given type for a single entry (sticky or cooldown).
   * @param {import('./types.js').TimedEffectType} type Type of timed effect
   * @param {import('./types.js').WIScanEntry} entry WI entry to check
   */
  #setTimedEffectOfType(type, entry) {
    // Skip if entry does not have the type (sticky or cooldown)
    if (!entry[type]) {
      return;
    }

    const key = this.#getEntryKey(entry);

    if (!this.#timedWorldInfo[type][key]) {
      const effect = this.#getEntryTimedEffect(type, entry, false);
      this.#timedWorldInfo[type][key] = effect;
      this.#notifyUpdate();

      console.log(
        `[WI] Adding ${type} entry ${key}: start=${effect.start}, end=${effect.end}, protected=${effect.protected}`
      );
    }
  }

  // ─── 公开方法 ──────────────────────────────────────────────────────────────

  /**
   * Checks for timed effects on chat messages.
   * 扫描开始前调用（在 checkWorldInfo 主循环之前）。
   *
   * sticky/cooldown 的持久化读写仅在 !isDryRun 时执行；
   * delay 的计算始终执行（纯读，无副作用）。
   */
  checkTimedEffects() {
    if (!this.#isDryRun) {
      this.#checkTimedEffectOfType('sticky', this.#buffer.sticky, this.#onEnded.sticky.bind(this));
      this.#checkTimedEffectOfType(
        'cooldown',
        this.#buffer.cooldown,
        this.#onEnded.cooldown.bind(this)
      );
    }
    this.#checkDelayEffect(this.#buffer.delay);
  }

  /**
   * Gets raw timed effect metadatum for a WI entry.
   * @param {import('./types.js').TimedEffectType} type Type of timed effect
   * @param {import('./types.js').WIScanEntry} entry WI entry
   * @returns {import('./types.js').WITimedEffect|null} Timed effect record, or null
   */
  getEffectMetadata(type, entry) {
    if (!this.isValidEffectType(type)) {
      return null;
    }

    const key = this.#getEntryKey(entry);
    return this.#timedWorldInfo[type]?.[key] ?? null;
  }

  /**
   * Sets timed effects on chat messages for all activated entries.
   * 扫描结束后调用（在 checkWorldInfo 主循环退出后）。
   * isDryRun 时直接返回（与原版一致）。
   *
   * @param {import('./types.js').WIScanEntry[]} activatedEntries Entries that were activated
   */
  setTimedEffects(activatedEntries) {
    if (this.#isDryRun) return;
    for (const entry of activatedEntries) {
      this.#setTimedEffectOfType('sticky', entry);
      this.#setTimedEffectOfType('cooldown', entry);
    }
  }

  /**
   * Force set or unset a timed effect for a WI entry.
   * isDryRun 时对非 delay 效果直接返回（与原版一致）。
   *
   * @param {import('./types.js').TimedEffectType} type Type of timed effect
   * @param {import('./types.js').WIScanEntry} entry WI entry
   * @param {boolean} newState The desired state of the effect
   */
  setTimedEffect(type, entry, newState) {
    if (!this.isValidEffectType(type)) {
      return;
    }
    if (this.#isDryRun && type !== 'delay') {
      return;
    }

    const key = this.#getEntryKey(entry);
    delete this.#timedWorldInfo[type][key];

    if (newState) {
      const effect = this.#getEntryTimedEffect(type, entry, false);
      this.#timedWorldInfo[type][key] = effect;
      console.log(
        `[WI] Adding ${type} entry ${key}: start=${effect.start}, end=${effect.end}, protected=${effect.protected}`
      );
    }

    this.#notifyUpdate();
  }

  /**
   * Check if the string is a valid timed effect type.
   * @param {string} type Name of the timed effect
   * @returns {boolean} Is recognized type
   */
  isValidEffectType(type) {
    return (
      typeof type === 'string' &&
      ['sticky', 'cooldown', 'delay'].includes(type.trim().toLowerCase())
    );
  }

  /**
   * Check if the current entry has an active timed effect of the given type.
   * 查询 #buffer（已在本轮 checkTimedEffects() 中填充）。
   *
   * @param {import('./types.js').TimedEffectType} type Type of timed effect
   * @param {import('./types.js').WIScanEntry} entry WI entry to check
   * @returns {boolean} True if the entry is active for this effect type
   */
  isEffectActive(type, entry) {
    if (!this.isValidEffectType(type)) {
      return false;
    }

    return (
      this.#buffer[type]?.some((x) => this.#getEntryHash(x) === this.#getEntryHash(entry)) ?? false
    );
  }

  /**
   * Clean up the in-memory buffer (called at the end of each Generate pass).
   * 与原版 cleanUp() 完全一致。
   */
  cleanUp() {
    for (const buffer of Object.values(this.#buffer)) {
      buffer.splice(0, buffer.length);
    }
  }
}
