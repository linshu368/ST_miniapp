/**
 * runtime/constants.js
 *
 * Subset of `public/script.js` + `public/scripts/constants.js` that
 * the prompt-engine subtree imports. Only enums actually referenced
 * by ported code are mirrored; we extend this file as new steps land.
 *
 * Step 0 — inject_ids (originally `public/scripts/constants.js`):
 *   the macro that touches this is `{{outlet}}` →
 *   `inject_ids.CUSTOM_WI_OUTLET(key)`. The other inject_ids entries
 *   are kept for future Step 2 (World Info) integration even though
 *   Step 0 doesn't read them.
 *
 * Step 1 — extension_prompt_types (originally `public/script.js:499`):
 *   `formatInstructModeStoryString` reads `extension_prompt_types.IN_PROMPT`
 *   and `IN_CHAT` to decide whether to wrap the story string with
 *   instruct prefix/suffix sequences. The full enum is mirrored here
 *   (NONE/IN_PROMPT/IN_CHAT/BEFORE_PROMPT) so Step 2/3 can reuse it
 *   without further edits to this file.
 */

export const inject_ids = {
  STORY_STRING: '__STORY_STRING__',
  QUIET_PROMPT: 'QUIET_PROMPT',
  DEPTH_PROMPT: 'DEPTH_PROMPT',
  DEPTH_PROMPT_INDEX: (index) => `DEPTH_PROMPT_${index}`,
  CUSTOM_WI_DEPTH: 'customDepthWI',
  CUSTOM_WI_DEPTH_ROLE: (depth, role) => `customDepthWI_${depth}_${role}`,
  CUSTOM_WI_OUTLET: (key) => `customWIOutlet_${key}`,
};

/**
 * @enum {number} Extension prompt insertion positions.
 * Mirrors `public/script.js:499` byte-for-byte.
 *
 *   NONE          = -1  → disabled (no injection)
 *   IN_PROMPT     =  0  → inserted into the static story string region
 *                          (default for Author's Note "Before/After Char Defs")
 *   IN_CHAT       =  1  → inserted depth-anchored inside the chat history
 *                          (used by Persona depth, Author's Note "@D" mode,
 *                           World Info depth entries, etc.)
 *   BEFORE_PROMPT =  2  → inserted before the story string region
 *                          (used by some preset chains)
 */
export const extension_prompt_types = {
  NONE: -1,
  IN_PROMPT: 0,
  IN_CHAT: 1,
  BEFORE_PROMPT: 2,
};
