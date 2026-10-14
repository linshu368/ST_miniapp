/** v2 富回复的默认视觉样式。它们属于各自规则草稿，而不是渲染器公共皮肤。 */
const UNIT = String.raw`.rp-unit { color-scheme: light dark; margin: 14px 0; overflow: hidden; color: light-dark(#2c2925, #f0ebe3); border: 1px solid light-dark(rgb(74 62 49 / 12%), rgb(235 222 204 / 16%)); border-radius: 16px; box-shadow: 0 8px 24px light-dark(rgb(71 56 41 / 5%), rgb(0 0 0 / 16%)); }
.rp-unit > summary { display: grid; grid-template-columns: minmax(0, 1fr) 24px; gap: 12px; align-items: center; min-height: 64px; padding: 13px 18px; list-style: none; cursor: pointer; }
.rp-unit > summary::-webkit-details-marker { display: none; }
.rp-unit__heading { display: grid; gap: 2px; }
.rp-unit__heading strong { font-size: 15px; font-weight: 500; }
.rp-unit__heading small { color: light-dark(#81796f, #aaa196); font-size: 12px; font-weight: 400; }
.rp-unit__chevron { color: light-dark(#81796f, #aaa196); font-size: 20px; text-align: center; transition: transform 180ms ease; }
.rp-unit[open] > summary .rp-unit__chevron { transform: rotate(90deg); }
.rp-unit__body { padding: 4px 18px 18px; }`;

const PANEL = String.raw`.rp-panel-list { display: grid; gap: 8px; }
.rp-panel-list > details { overflow: hidden; background: light-dark(rgb(255 255 255 / 42%), rgb(255 255 255 / 4%)); border-radius: 12px; }
.rp-panel-list > details > summary { display: grid; grid-template-columns: minmax(0, 1fr) 20px; gap: 12px; align-items: center; min-height: 50px; padding: 11px 14px; list-style: none; font-weight: 500; cursor: pointer; }
.rp-panel-list > details > summary::-webkit-details-marker { display: none; }
.rp-panel-list > details > summary::after { content: "›"; color: light-dark(#81796f, #aaa196); font-size: 18px; text-align: center; transition: transform 180ms ease; }
.rp-panel-list > details[open] > summary::after { transform: rotate(90deg); }
.rp-panel-list pre { margin: 0 14px 16px; padding: 14px; overflow: visible; white-space: pre-wrap; color: inherit; background: light-dark(rgb(255 255 255 / 38%), rgb(255 255 255 / 4%)); border: 0; border-radius: 10px; font: inherit; }
.rp-panel-list code { color: inherit; background: transparent; font: inherit; white-space: pre-wrap; }`;

const MOBILE_UNIT = String.raw`@media (max-width: 500px) { .rp-unit > summary { padding: 12px 14px; } .rp-unit__body { padding: 4px 14px 14px; } }`;

export const RICH_REPLY_RULE_STYLES = {
  choice: `${UNIT}
.rp-unit--choices { background: light-dark(#fbf3e7, #28221c); }
.rp-choice-list { display: grid; gap: 8px; }
.rp-choice { display: grid; grid-template-columns: minmax(0, 1fr) 22px; gap: 12px; align-items: center; width: 100%; min-height: 50px; padding: 12px 14px; color: inherit; background: light-dark(#fffaf2, #342b23); border: 1px solid light-dark(rgb(74 62 49 / 10%), rgb(235 222 204 / 12%)); border-radius: 12px; font: inherit; text-align: left; cursor: pointer; transition: transform 160ms ease, background 160ms ease; }
.rp-choice:hover { transform: translateY(-1px); background: light-dark(#fffdf8, #3a3027); }
.rp-choice:disabled { cursor: default; opacity: 0.55; transform: none; }
.rp-choice__arrow { color: light-dark(#81796f, #aaa196); text-align: right; }
${MOBILE_UNIT}
@media (max-width: 500px) { .rp-choice { padding: 12px; } }`,
  status: `${UNIT}
.rp-unit--status { background: light-dark(#eef2eb, #20261f); }
${PANEL}
${MOBILE_UNIT}`,
  memory: `${UNIT}
.rp-unit--memory { background: light-dark(#f3ede7, #28221f); }
${PANEL}
.rp-memory-list pre { border-left: 2px solid light-dark(#d9bd96, #8f6f50); border-radius: 2px 10px 10px 2px; }
${MOBILE_UNIT}`,
  dialogue: String.raw`.rp-dialogue { padding: 0 0.06em; color: inherit; font-weight: 500; background: linear-gradient(transparent 62%, light-dark(rgb(217 189 150 / 48%), rgb(143 111 80 / 42%)) 62%); -webkit-box-decoration-break: clone; box-decoration-break: clone; }`,
} as const;

/** v1 artifacts had no per-rule styles, so preserve their already-published appearance. */
export const LEGACY_RICH_REPLY_CSS = Object.values(RICH_REPLY_RULE_STYLES)
  .join('\n')
  .replace(/(^|\n)(?!@)([^\n{]+)\{/g, '$1.reply-markdown $2{');
