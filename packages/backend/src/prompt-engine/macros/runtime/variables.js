/**
 * runtime/variables.js
 *
 * Replacement for the `ctx.variables` API that ST exposes via
 * `SillyTavern.getContext().variables.{local,global}.{set,get,del,...}`.
 *
 * The variable-macros definition file calls these methods directly
 * (e.g. `ctx.variables.local.set(name, value)`); we expose the same
 * shape so the file edits are minimal.
 *
 * Storage model (matches ST 1.17.0):
 *   - LOCAL  → `chat_metadata.variables[name]` (lazily created as {})
 *   - GLOBAL → a module-private dict that is swapped via setGlobalStore()
 *             by the substituteParams façade.
 *
 * Function semantics are byte-equivalent to ST's variables.js
 * (`getLocalVariable`, `setLocalVariable`, `addLocalVariable`, …).
 * We don't replicate the `args.index` / JSON sub-keying behaviour
 * because none of the 9 baseline cases use it; that's a Step 1 follow-up.
 */

import { chat_metadata } from './host.js';

/** @type {Record<string, any>} */
let _globalStore = {};

/**
 * Replace the global-variable backing store. Called by the TS façade
 * to inject the caller-supplied `globalVariables` from ctx.
 *
 * @param {Record<string, any>} store
 * @returns {Record<string, any>} The previous store (so the façade can
 *     restore it afterwards).
 */
export function setGlobalStore(store) {
  const prev = _globalStore;
  _globalStore = store ?? {};
  return prev;
}

// ─── Local: chat_metadata.variables[name] ───────────────────────────────────

/** @returns {Record<string, any>} */
function ensureLocalStore() {
  if (!chat_metadata.variables) {
    chat_metadata.variables = {};
  }
  return chat_metadata.variables;
}

/**
 * @param {*} value
 * @returns {string|number}
 */
function coerceVariableRead(value) {
  return value?.trim?.() === '' || isNaN(Number(value)) ? value || '' : Number(value);
}

/** @param {string} name @returns {string|number} */
function getLocal(name) {
  const store = ensureLocalStore();
  return coerceVariableRead(store[name]);
}

/** @param {string} name @param {*} value @returns {*} */
function setLocal(name, value) {
  if (!name) throw new Error('Variable name cannot be empty or undefined.');
  ensureLocalStore()[name] = value;
  return value;
}

/** @param {string} name @returns {boolean} */
function hasLocal(name) {
  return !!chat_metadata.variables && chat_metadata.variables[name] !== undefined;
}

/** @param {string} name @returns {string} */
function delLocal(name) {
  if (!hasLocal(name)) return '';
  delete chat_metadata.variables[name];
  return '';
}

/** @param {string} name @param {*} value @returns {string|number} */
function addLocal(name, value) {
  const currentValue = getLocal(name) || 0;
  try {
    const parsedValue = JSON.parse(/** @type {string} */ (currentValue));
    if (Array.isArray(parsedValue)) {
      parsedValue.push(value);
      setLocal(name, JSON.stringify(parsedValue));
      return parsedValue;
    }
  } catch {
    /* ignore */
  }
  const increment = Number(value);
  if (isNaN(increment) || isNaN(Number(currentValue))) {
    const stringValue = String(currentValue || '') + value;
    setLocal(name, stringValue);
    return stringValue;
  }
  const newValue = Number(currentValue) + increment;
  if (isNaN(newValue)) return '';
  setLocal(name, newValue);
  return newValue;
}

/** @param {string} name @returns {string|number} */
function incLocal(name) {
  return addLocal(name, 1);
}
/** @param {string} name @returns {string|number} */
function decLocal(name) {
  return addLocal(name, -1);
}

// ─── Global: _globalStore[name] ─────────────────────────────────────────────

/** @param {string} name @returns {string|number} */
function getGlobal(name) {
  return coerceVariableRead(_globalStore[name]);
}

/** @param {string} name @param {*} value @returns {*} */
function setGlobal(name, value) {
  if (!name) throw new Error('Variable name cannot be empty or undefined.');
  _globalStore[name] = value;
  return value;
}

/** @param {string} name @returns {boolean} */
function hasGlobal(name) {
  return _globalStore[name] !== undefined;
}

/** @param {string} name @returns {string} */
function delGlobal(name) {
  if (!hasGlobal(name)) return '';
  delete _globalStore[name];
  return '';
}

/** @param {string} name @param {*} value @returns {string|number} */
function addGlobal(name, value) {
  const currentValue = getGlobal(name) || 0;
  try {
    const parsedValue = JSON.parse(/** @type {string} */ (currentValue));
    if (Array.isArray(parsedValue)) {
      parsedValue.push(value);
      setGlobal(name, JSON.stringify(parsedValue));
      return parsedValue;
    }
  } catch {
    /* ignore */
  }
  const increment = Number(value);
  if (isNaN(increment) || isNaN(Number(currentValue))) {
    const stringValue = String(currentValue || '') + value;
    setGlobal(name, stringValue);
    return stringValue;
  }
  const newValue = Number(currentValue) + increment;
  if (isNaN(newValue)) return '';
  setGlobal(name, newValue);
  return newValue;
}

/** @param {string} name @returns {string|number} */
function incGlobal(name) {
  return addGlobal(name, 1);
}
/** @param {string} name @returns {string|number} */
function decGlobal(name) {
  return addGlobal(name, -1);
}

// ─── Public API: shape mirrors SillyTavern.getContext().variables ───────────

export const variables = {
  local: {
    get: getLocal,
    set: setLocal,
    del: delLocal,
    add: addLocal,
    inc: incLocal,
    dec: decLocal,
    has: hasLocal,
  },
  global: {
    get: getGlobal,
    set: setGlobal,
    del: delGlobal,
    add: addGlobal,
    inc: incGlobal,
    dec: decGlobal,
    has: hasGlobal,
  },
};
