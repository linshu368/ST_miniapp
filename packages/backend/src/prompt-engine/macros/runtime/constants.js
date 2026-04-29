/**
 * runtime/constants.js
 *
 * Subset of `public/scripts/constants.js`. Only fields referenced by
 * the macro engine + definitions are mirrored.
 *
 * The macro that touches this is `{{outlet}}` → `inject_ids.CUSTOM_WI_OUTLET(key)`.
 * The other inject_ids entries are kept for future Step 2 (World Info)
 * integration even though Step 0 doesn't read them.
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
