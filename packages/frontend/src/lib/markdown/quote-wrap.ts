// 6 种语言引号 → <q> 包裹
// 复刻自 SillyTavern script.js:1859-1885
// 排除代码块和样式块,避免在 ``` 内部误伤
const QUOTE_REGEX =
  /<style>[\s\S]*?<\/style>|```[\s\S]*?```|~~~[\s\S]*?~~~|``[\s\S]*?``|`[\s\S]*?`|(".*?")|(“.*?”)|(«.*?»)|(「.*?」)|(『.*?』)|(＂.*?＂)/gim;

export function wrapQuotes(text: string): string {
  return text.replace(QUOTE_REGEX, (match, p1, p2, p3, p4, p5, p6) => {
    if (p1) return `<q>"${p1.slice(1, -1)}"</q>`;
    if (p2) return `<q>“${p2.slice(1, -1)}”</q>`;
    if (p3) return `<q>«${p3.slice(1, -1)}»</q>`;
    if (p4) return `<q>「${p4.slice(1, -1)}」</q>`;
    if (p5) return `<q>『${p5.slice(1, -1)}』</q>`;
    if (p6) return `<q>＂${p6.slice(1, -1)}＂</q>`;
    return match;
  });
}
