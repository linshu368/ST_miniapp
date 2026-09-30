const UNSAFE_CSS =
  /url\s*\(|@import|@font-face|expression\s*\(|javascript:|https?:|data:|<\/|@namespace|@charset/i;

/** serialize 之后再扫一遍。命中就整段回退，不把半份样式插进页面。 */
export function isSafeCss(css: string): boolean {
  return !UNSAFE_CSS.test(css);
}
