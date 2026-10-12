/**
 * 普通正文的视觉对齐现有聊天气泡：字号、段落、列表、引用和代码。
 * 用主题变量，不加载字体或图片。按钮和 summary 的 44px 热区写在元素 inline style 上，
 * 这样运营 CSS 盖不过点击区域。
 */
export const BASE_CSS = `
.reply-markdown { font-size: 15px; line-height: 1.75; overflow-wrap: anywhere; }
.reply-markdown p { margin: 0.5em 0; }
.reply-markdown p:first-child { margin-top: 0; }
.reply-markdown p:last-child { margin-bottom: 0; }
.reply-markdown h3 { margin: 0.75em 0 0.25em; font-size: 15px; font-weight: 600; }
.reply-markdown h4 { margin: 0.5em 0 0.25em; font-weight: 600; }
.reply-markdown ul, .reply-markdown ol { margin: 0.5em 0; padding-left: 1.25em; }
.reply-markdown ul { list-style: disc; }
.reply-markdown ol { list-style: decimal; }
.reply-markdown li { margin: 0.125em 0; }
.reply-markdown blockquote { margin: 0.5em 0; padding-left: 0.75em; border-left: 2px solid var(--primary); color: var(--muted-foreground); }
.reply-markdown code { border-radius: 4px; background: var(--muted); padding: 0 0.25em; font-size: 13px; }
.reply-markdown pre { overflow-x: auto; border-radius: 8px; background: var(--muted); padding: 0.75em; }
.reply-markdown pre code { padding: 0; background: transparent; }
.reply-markdown em { color: var(--muted-foreground); }
.reply-markdown button, .reply-markdown summary { touch-action: manipulation; }
.reply-markdown .rp-unit { margin: 14px 0; overflow: hidden; color: light-dark(#2c2925, #f0ebe3); border: 1px solid light-dark(rgb(74 62 49 / 12%), rgb(235 222 204 / 16%)); border-radius: 16px; box-shadow: 0 8px 24px light-dark(rgb(71 56 41 / 5%), rgb(0 0 0 / 16%)); }
.reply-markdown .rp-unit--choices { background: light-dark(#fbf3e7, #28221c); }
.reply-markdown .rp-unit--status { background: light-dark(#eef2eb, #20261f); }
.reply-markdown .rp-unit--memory { background: light-dark(#f3ede7, #28221f); }
.reply-markdown .rp-unit > summary { display: grid; grid-template-columns: minmax(0, 1fr) 24px; gap: 12px; align-items: center; min-height: 64px; padding: 13px 18px; list-style: none; cursor: pointer; }
.reply-markdown .rp-unit > summary::-webkit-details-marker, .reply-markdown .rp-panel-list > details > summary::-webkit-details-marker { display: none; }
.reply-markdown .rp-unit__heading { display: grid; gap: 2px; }
.reply-markdown .rp-unit__heading strong { font-size: 15px; font-weight: 500; }
.reply-markdown .rp-unit__heading small, .reply-markdown .rp-unit__chevron, .reply-markdown .rp-choice__arrow { color: light-dark(#81796f, #aaa196); }
.reply-markdown .rp-unit__chevron { font-size: 20px; text-align: center; transition: transform 180ms ease; }
.reply-markdown .rp-unit[open] > summary .rp-unit__chevron, .reply-markdown .rp-panel-list > details[open] > summary::after { transform: rotate(90deg); }
.reply-markdown .rp-unit__body { padding: 4px 18px 18px; }
.reply-markdown .rp-choice-list, .reply-markdown .rp-panel-list { display: grid; gap: 8px; }
.reply-markdown .rp-choice { display: grid; grid-template-columns: minmax(0, 1fr) 22px; gap: 12px; align-items: center; width: 100%; min-height: 50px; padding: 12px 14px; color: inherit; background: light-dark(#fffaf2, #342b23); border: 1px solid light-dark(rgb(74 62 49 / 10%), rgb(235 222 204 / 12%)); border-radius: 12px; font: inherit; text-align: left; cursor: pointer; }
.reply-markdown .rp-choice:disabled { cursor: default; opacity: 0.55; }
.reply-markdown .rp-choice__arrow { text-align: right; }
.reply-markdown .rp-panel-list > details { overflow: hidden; background: light-dark(rgb(255 255 255 / 42%), rgb(255 255 255 / 4%)); border-radius: 12px; }
.reply-markdown .rp-panel-list > details > summary { display: grid; grid-template-columns: minmax(0, 1fr) 20px; gap: 12px; align-items: center; min-height: 50px; padding: 11px 14px; list-style: none; font-weight: 500; cursor: pointer; }
.reply-markdown .rp-panel-list > details > summary::after { content: "›"; color: light-dark(#81796f, #aaa196); font-size: 18px; text-align: center; transition: transform 180ms ease; }
.reply-markdown .rp-panel-list pre { margin: 0 14px 16px; padding: 14px; overflow: visible; white-space: pre-wrap; color: inherit; background: light-dark(rgb(255 255 255 / 38%), rgb(255 255 255 / 4%)); border: 0; border-radius: 10px; font: inherit; }
.reply-markdown .rp-panel-list code { color: inherit; background: transparent; font: inherit; white-space: pre-wrap; }
.reply-markdown .rp-dialogue { font-weight: 500; }
`.trim();
