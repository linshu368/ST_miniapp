/**
 * Shared baseline-runner harness.
 *
 * Generic plumbing reused across every prompt-engine migration step
 * (Step 0 macros, Step 1 instruct, Step 2 world-info, ...).
 *
 * This file is canonical here in the miniAPP repo. The sync script copies it
 * into a running SillyTavern install at /baseline-runner/harness.js where it
 * is loaded as an ESM module from the browser console.
 *
 * Per-step adapters live in ./adapters/<step>.js and only need to provide:
 *   - setupOnce()    : called once before all cases (e.g. flip feature flags)
 *   - runOneCase(c)  : per-case logic; returns { text, meta }
 *   - teardownOnce() : called once after all cases (restore globals)
 *
 * Then call runStep(stepName, hooks) from the adapter's run() entry.
 *
 * Conventions:
 *   - Cases are served from /baseline-runner/fixtures/<stepName>/cases/index.json + each entry.
 *   - Output is downloaded as sillytavern-original-<stepName>-YYYYMMDD-HHmm.json.
 *   - Determinism mocks (Math.random, moment.now) are managed by withDeterministicEnv().
 */

import { seedrandom, moment } from '/lib.js';

const ENGINE_LABEL = 'sillytavern-original';
const SCHEMA_VERSION = '1.0';

/**
 * Top-level runner. Loads all cases for a step, runs each through the adapter
 * with deterministic mocks applied, and downloads a baseline JSON.
 *
 * @param {string} stepName - e.g. 'macros'.
 * @param {object} hooks
 * @param {() => (void | Promise<void>)} [hooks.setupOnce]
 * @param {(caseObj: any) => Promise<{ text: string, meta: object }>} hooks.runOneCase
 * @param {() => (void | Promise<void>)} [hooks.teardownOnce]
 * @param {string} [hooks.notes]
 * @returns {Promise<object>} The baseline payload (also downloaded as JSON).
 */
export async function runStep(stepName, hooks) {
  if (!stepName) throw new Error('runStep: stepName required');
  if (typeof hooks?.runOneCase !== 'function')
    throw new Error('runStep: hooks.runOneCase is required');

  console.group(`[baseline-runner] step=${stepName}`);
  const startedAt = new Date();

  const cases = await loadCases(stepName);
  console.info(`[baseline-runner] loaded ${cases.length} case(s)`);

  if (typeof hooks.setupOnce === 'function') {
    await hooks.setupOnce();
  }

  const results = [];
  try {
    for (const c of cases) {
      const result = await runOneSafe(c, hooks.runOneCase);
      results.push({
        caseId: c.caseId,
        input: c.input,
        output: result,
      });
      const status = result.meta.error ? 'ERROR' : 'OK';
      console.info(`[baseline-runner] ${status.padEnd(5)} ${c.caseId}`);
    }
  } finally {
    if (typeof hooks.teardownOnce === 'function') {
      try {
        await hooks.teardownOnce();
      } catch (e) {
        console.error('[baseline-runner] teardownOnce failed', e);
      }
    }
  }

  const payload = {
    schemaVersion: SCHEMA_VERSION,
    runMeta: {
      runAt: startedAt.toISOString(),
      engine: ENGINE_LABEL,
      stVersion: detectStVersion(),
      userAgent: navigator?.userAgent ?? '',
      notes: hooks.notes ?? '',
      stepName,
    },
    results,
  };

  const filename = makeBaselineFilename(stepName, startedAt);
  downloadJSON(filename, payload);
  console.info(`[baseline-runner] downloaded ${filename}`);
  console.groupEnd();

  // Stash on window for manual inspection / re-download.
  window.__lastBaselinePayload = payload;
  window.__lastBaselineFilename = filename;
  return payload;
}

/**
 * Loads case index + each case JSON for a step.
 *
 * @param {string} stepName
 * @returns {Promise<Array<{ caseId: string, description: string, tags?: string[], input: object }>>}
 */
export async function loadCases(stepName) {
  const indexUrl = `/baseline-runner/fixtures/${stepName}/cases/index.json`;
  const indexResp = await fetch(indexUrl);
  if (!indexResp.ok) {
    throw new Error(
      `Failed to load case index at ${indexUrl}. Did you run scripts/sync-baseline-runner.mjs?`
    );
  }
  const index = await indexResp.json();
  if (!Array.isArray(index?.cases))
    throw new Error(`Invalid index.json (no .cases array): ${indexUrl}`);

  const out = [];
  for (const filename of index.cases) {
    const url = `/baseline-runner/fixtures/${stepName}/cases/${filename}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Failed to load case ${url}`);
    out.push(await resp.json());
  }
  return out;
}

/**
 * Wraps fn() so that for its duration:
 *   - Math.random is replaced by a seeded generator (when seed provided).
 *   - moment.now returns the fixed timestamp (when isoNow provided).
 *   - moment.locale is pinned to 'en' for stable {{date}}/{{weekday}} output.
 * Restores all of the above in finally(), even on exception.
 *
 * @template T
 * @param {{ seed?: string|null, isoNow?: string|null }} env
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<T>}
 */
export async function withDeterministicEnv({ seed, isoNow }, fn) {
  const origRandom = Math.random;
  const origMomentNow = moment.now;
  const origLocale = moment.locale();

  try {
    if (seed) {
      // global:true replaces Math.random in place. droll uses Math.random internally.
      seedrandom(seed, { global: true });
    }
    if (isoNow) {
      const fixedMs = Date.parse(isoNow);
      if (Number.isNaN(fixedMs)) throw new Error(`Invalid isoNow: ${isoNow}`);
      moment.now = () => fixedMs;
    }
    moment.locale('en');
    return await fn();
  } finally {
    Math.random = origRandom;
    moment.now = origMomentNow;
    moment.locale(origLocale);
  }
}

/**
 * Captures console.warn / console.error during fn() into a string array.
 * Useful for collecting MacroDiagnostics warnings.
 *
 * @template T
 * @param {() => Promise<T>|T} fn
 * @returns {Promise<{ result: T, warnings: string[] }>}
 */
export async function captureConsole(fn) {
  /** @type {string[]} */
  const warnings = [];
  const origWarn = console.warn;
  const origError = console.error;

  const sink =
    (level) =>
    (...args) => {
      try {
        warnings.push(`[${level}] ` + args.map(stringifyForLog).join(' '));
      } catch {
        /* swallow */
      }
    };

  console.warn = sink('warn');
  console.error = sink('error');
  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.warn = origWarn;
    console.error = origError;
  }
}

/**
 * Recursively converts an object into a JSON-safe form.
 * - Functions are dropped.
 * - Lazy getters are resolved (Object.assign trick).
 * - Cycles are broken with "[Circular]".
 *
 * @param {unknown} value
 * @param {WeakSet<object>} [seen]
 * @returns {unknown}
 */
export function snapshotJsonSafe(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'function') return undefined;
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((v) => snapshotJsonSafe(v, seen));
  }

  const out = {};
  for (const key of Object.keys(value)) {
    let v;
    try {
      v = value[key];
    } catch (e) {
      v = `[Throws: ${e?.message ?? e}]`;
    }
    const safe = snapshotJsonSafe(v, seen);
    if (safe !== undefined) out[key] = safe;
  }
  return out;
}

/**
 * Triggers a browser download of a JSON payload.
 * @param {string} filename
 * @param {unknown} payload
 */
export function downloadJSON(filename, payload) {
  const json = JSON.stringify(payload, null, 2);
  const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 1000);
}

// ─── Internals ──────────────────────────────────────────────────────────────

async function runOneSafe(caseObj, runOneCase) {
  try {
    const out = await runOneCase(caseObj);
    if (typeof out?.text !== 'string' || typeof out?.meta !== 'object') {
      throw new Error('runOneCase must return { text: string, meta: object }');
    }
    return {
      text: out.text,
      meta: {
        macrosUsed: Array.isArray(out.meta.macrosUsed) ? out.meta.macrosUsed : [],
        warnings: Array.isArray(out.meta.warnings) ? out.meta.warnings : [],
        envSnapshot: out.meta.envSnapshot ?? {},
        error: null,
      },
    };
  } catch (e) {
    console.error(`[baseline-runner] case ${caseObj.caseId} threw:`, e);
    return {
      text: '',
      meta: {
        macrosUsed: [],
        warnings: [],
        envSnapshot: {},
        error: e?.stack ?? String(e),
      },
    };
  }
}

function detectStVersion() {
  try {
    const el = document.querySelector('#version_display');
    const text = el?.textContent?.trim();
    if (text) return text;
  } catch {
    /* ignore */
  }
  return 'unknown';
}

function makeBaselineFilename(stepName, date) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const mi = pad(date.getMinutes());
  return `${ENGINE_LABEL}-${stepName}-${yyyy}${mm}${dd}-${hh}${mi}.json`;
}

function stringifyForLog(v) {
  if (v instanceof Error) return v.stack ?? v.message;
  if (typeof v === 'object') {
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  }
  return String(v);
}
