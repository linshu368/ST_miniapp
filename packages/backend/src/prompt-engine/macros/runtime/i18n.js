/**
 * runtime/i18n.js
 *
 * Identity translator. ST's `t` is a tagged-template + plain-string
 * helper that resolves keys against the user's locale dictionary. On
 * the backend we don't localise diagnostic strings (they're consumed
 * by logs / tests), so we just return the input as-is and accept
 * either call style.
 *
 * @param {TemplateStringsArray|string} strings
 * @param  {...any} values
 * @returns {string}
 */
export function t(strings, ...values) {
  if (typeof strings === 'string') return strings;
  if (Array.isArray(strings)) {
    let out = '';
    for (let i = 0; i < strings.length; i++) {
      out += strings[i];
      if (i < values.length) out += String(values[i]);
    }
    return out;
  }
  return String(strings);
}
