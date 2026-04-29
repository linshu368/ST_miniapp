/**
 * runtime/utils.js
 *
 * Subset of `public/scripts/utils.js` used by the macro engine. Direct
 * 1:1 port (function bodies are byte-identical to ST 1.17.0); only
 * imports change. We don't need DOM or jQuery utilities here.
 *
 * Functions ported:
 *   - getStringHash      (used by MacroEnvBuilder + {{pick}})
 *   - isFalseBoolean     (used by {{if}} and MacroRegistry)
 *   - isTrueBoolean      (used by MacroRegistry)
 *   - escapeRegex        (kept for parity even though Step 0 doesn't hit it)
 *   - timestampToMoment  (used by {{idleDuration}})
 */

import { moment } from './lib.js';

/**
 * cyrb53 (c) 2018 bryc — public domain.
 * 53-bit string hash; used as the seed for {{pick}} and as MacroEnv.contentHash.
 *
 * @param {string} str
 * @param {number} [seed=0]
 * @returns {number}
 */
export function getStringHash(str, seed = 0) {
  if (typeof str !== 'string') {
    return 0;
  }

  let h1 = 0xdeadbeef ^ seed,
    h2 = 0x41c6ce57 ^ seed;
  for (let i = 0, ch; i < str.length; i++) {
    ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }

  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);

  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * @param {string} arg
 * @returns {boolean}
 */
export function isTrueBoolean(arg) {
  return ['on', 'true', '1'].includes(arg?.trim()?.toLowerCase());
}

/**
 * @param {string} arg
 * @returns {boolean}
 */
export function isFalseBoolean(arg) {
  return ['off', 'false', '0'].includes(arg?.trim()?.toLowerCase());
}

/**
 * @param {string} string
 * @returns {string}
 */
export function escapeRegex(string) {
  return string.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

const dateCache = new Map();

/**
 * Cached moment() factory. Same semantics as ST 1.17.0: returns
 * `moment.invalid()` for unrecognised input, never throws.
 *
 * Note: locale is not pinned here — callers that need deterministic
 * formatting must do `moment.locale('en')` upstream (the substituteParams
 * façade does this).
 *
 * @param {*} timestamp
 * @returns {import('moment').Moment}
 */
export function timestampToMoment(timestamp) {
  if (dateCache.has(timestamp)) {
    return dateCache.get(timestamp);
  }

  const iso8601 = parseTimestamp(timestamp);
  const objMoment = iso8601 ? moment(iso8601) : moment.invalid();

  dateCache.set(timestamp, objMoment);
  return objMoment;
}

/**
 * @param {*} timestamp
 * @returns {string|undefined}
 */
function parseTimestamp(timestamp) {
  if (!timestamp) return;

  if (timestamp instanceof Date) {
    return timestamp.toISOString();
  }

  if (typeof timestamp === 'number' || /^\d+$/.test(timestamp)) {
    const unixTime = Number(timestamp);
    const isValid = Number.isFinite(unixTime) && !Number.isNaN(unixTime) && unixTime >= 0;
    if (!isValid) return;
    return new Date(unixTime).toISOString();
  }

  if (moment(timestamp, moment.ISO_8601, true).isValid()) {
    return timestamp;
  }

  let dtFmt = [];

  const convertFromMeridiemBased = (_, month, day, year, hour, minute, meridiem) => {
    const monthNum = moment().month(month).format('MM');
    const hour24 =
      meridiem.toLowerCase() === 'pm' ? (parseInt(hour, 10) % 12) + 12 : parseInt(hour, 10) % 12;
    return `${year}-${monthNum}-${day.padStart(2, '0')}T${hour24.toString().padStart(2, '0')}:${minute.padStart(2, '0')}:00`;
  };
  dtFmt.push({
    callback: convertFromMeridiemBased,
    pattern: /(\w+)\s(\d{1,2}),\s(\d{4})\s(\d{1,2}):(\d{1,2})(am|pm)/i,
  });

  const convertFromHumanized = (_, year, month, day, hour, min, sec, ms) => {
    ms = typeof ms !== 'undefined' ? `.${ms.padStart(3, '0')}` : '';
    return `${year.padStart(4, '0')}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour.padStart(2, '0')}:${min.padStart(2, '0')}:${sec.padStart(2, '0')}${ms}Z`;
  };
  dtFmt.push({
    callback: convertFromHumanized,
    pattern: /(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s(\d{1,3})ms/,
  });
  dtFmt.push({
    callback: convertFromHumanized,
    pattern: /(\d{4})-(\d{1,2})-(\d{1,2})@(\d{1,2})h(\d{1,2})m(\d{1,2})s/,
  });
  dtFmt.push({
    callback: convertFromHumanized,
    pattern: /(\d{4})-(\d{1,2})-(\d{1,2}) @(\d{1,2})h (\d{1,2})m (\d{1,2})s (\d{1,3})ms/,
  });

  for (const x of dtFmt) {
    let rgxMatch = timestamp.match(x.pattern);
    if (!rgxMatch) continue;
    return x.callback(...rgxMatch);
  }

  return;
}
