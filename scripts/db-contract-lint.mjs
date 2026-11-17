#!/usr/bin/env node
/**
 * 数据库契约检查（只警告，不阻断）。
 *
 * 把本次新增或修改的 migration 与 docs/db/registry.yaml 对照，按 docs/db/CONTRACT.md §7
 * 输出警告。项目所有者定的强度是"中等"：违规只在 PR 上提示，退出码恒为 0；违反契约时
 * 需在 PR 描述里写理由。
 *
 * 用法：
 *   node scripts/db-contract-lint.mjs --base <git-sha>   # CI：只查相对 base 新增/修改的 migration
 *   node scripts/db-contract-lint.mjs <file.sql> ...     # 指定文件
 *   node scripts/db-contract-lint.mjs                    # 本地：查契约生效日（含）之后命名的 migration
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
const migrationsDir = join(repoRoot, 'packages', 'shared', 'migrations');
const registryPath = join(repoRoot, 'docs', 'db', 'registry.yaml');
const CONTRACT_EFFECTIVE_PREFIX = '20261117';

const VENDOR_NAMES =
  /(openrouter|venice|surplus|grafana|telegram|deepseek|civitai|bunny|ttzf|vexutopia)/;
const MONEY_COLUMN = /(_credits$|_cents$|^price_|discount)/;
const JOB_COLUMN =
  /(^lease_|^next_attempt_at$|^next_retry_at$|^attempts$|_attempts$|^attempt_count$|^last_error$)/;
const VAGUE_COLUMN = /^(metadata|extra|data|info|payload)$/;
const CONSTRAINT_WORDS = new Set([
  'constraint',
  'primary',
  'unique',
  'check',
  'foreign',
  'exclude',
  'like',
]);
const INACTIVE_STATUSES = new Set(['drop', 'moving']);

/** Replace comments with same-length whitespace so offsets still map to source lines. */
export function blankComments(sql) {
  const keepNewlines = (text) => text.replace(/[^\n]/g, ' ');
  return sql.replace(/\/\*[\s\S]*?\*\//g, keepNewlines).replace(/--[^\n]*/g, keepNewlines);
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function unquote(name) {
  return name.replace(/"/g, '');
}

/** Index of the parenthesis closing the one at `open`, or -1. */
function matchParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Split on commas that are not nested inside parentheses. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') depth -= 1;
    else if (text[i] === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

export function loadRegistry(path = registryPath) {
  const doc = parseYaml(readFileSync(path, 'utf8'));
  const inflow = new Map();
  for (const entry of Object.values(doc.tables ?? {})) {
    for (const move of entry.move ?? []) {
      const cols = inflow.get(move.to) ?? new Set();
      for (const col of move.cols ?? []) cols.add(col);
      inflow.set(move.to, cols);
    }
  }
  return { schemas: doc.schemas ?? {}, tables: doc.tables ?? {}, inflow };
}

function columnWarnings(table, column, registry) {
  const [schema, name] = table.split('.');
  const entry = registry.tables[table];
  const out = [];
  if (schema !== 'billing' && MONEY_COLUMN.test(column) && !/_(charge|ledger)_id$/.test(column)) {
    out.push(
      `${table}.${column} 像价格/金额字段：钱只进 billing，业务表只存 *_charge_id / *_ledger_id（CONTRACT §3）`
    );
  }
  if (!name.endsWith('_jobs') && JOB_COLUMN.test(column)) {
    out.push(`${table}.${column} 像租约/重试字段：放 *_jobs 表（CONTRACT §2.1）`);
  }
  if (schema !== 'ops' && /_ms$/.test(column) && !entry?.billing_input) {
    out.push(
      `${table}.${column} 像测速字段：观测数据只进 ops；若被计费/交付判定读取，在 registry 标 billing_input（CONTRACT §1.2）`
    );
  }
  if (VAGUE_COLUMN.test(column)) {
    out.push(
      `${table}.${column} 列名不说明用途：jsonb 用 *_snapshot / raw_* / *_detail（CONTRACT §2.3）`
    );
  }
  return out;
}

function lintCreateTable(table, body, registry) {
  const [schema, name] = table.split('.');
  const entry = registry.tables[table];
  const out = [];
  if (!entry) out.push(`新表 ${table} 未在 docs/db/registry.yaml 登记（CONTRACT §2.2）`);
  if (VENDOR_NAMES.test(name))
    out.push(`新表 ${table} 名称含供应商/产品名，供应商写进 provider 列（CONTRACT §4）`);
  if (entry?.nature === 'M' && schema !== 'billing')
    out.push(`${table} 登记为 M（钱），但不在 billing`);
  if (entry?.nature === 'O' && schema !== 'ops') out.push(`${table} 登记为 O（观测），但不在 ops`);
  if (entry?.nature === 'J' && !name.endsWith('_jobs'))
    out.push(`${table} 登记为 J（任务），表名应以 _jobs 结尾`);
  for (const item of splitTopLevel(body)) {
    const column = unquote(item.trim().split(/\s+/)[0] ?? '').toLowerCase();
    if (column && !CONSTRAINT_WORDS.has(column))
      out.push(...columnWarnings(table, column, registry));
  }
  return out;
}

function lintAddColumn(table, column, registry) {
  const entry = registry.tables[table];
  const out = [];
  if (!entry) out.push(`给未登记的表 ${table} 加列 ${column}：先在 registry 登记该表`);
  const plannedInflow = registry.inflow.get(table)?.has(column);
  if (entry && (entry.status === 'frozen' || entry.status === 'moving') && !plannedInflow) {
    out.push(
      `${table} 在 registry 中为 ${entry.status}，不加列；新字段走旁表或子表（CONTRACT §2.1）`
    );
  }
  out.push(...columnWarnings(table, column, registry));
  return out;
}

function qualified(raw) {
  const name = unquote(raw).toLowerCase();
  return name.includes('.') ? name : `?.${name}`;
}

/** Lint one migration's SQL text; returns [{ line, message }]. */
/** 同一文件里「先 SET SCHEMA 再 RENAME」算一步：沿 RENAME 链找到最终表名。 */
function followRenames(text, table) {
  let current = table;
  for (let i = 0; i < 5; i += 1) {
    const [schema, name] = current.split('.');
    const m = text.match(
      new RegExp(
        `alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?"?${schema}"?\\."?${name}"?\\s+rename\\s+to\\s+"?(\\w+)"?`,
        'i'
      )
    );
    if (!m) break;
    current = `${schema}.${m[1].toLowerCase()}`;
  }
  return current;
}

export function lintSql(sql, registry) {
  const text = blankComments(sql);
  const warnings = [];
  const push = (index, messages) =>
    messages.forEach((message) => warnings.push({ line: lineOf(text, index), message }));
  const ident = '("?[\\w]+"?(?:\\."?[\\w]+"?)?)';

  for (const m of text.matchAll(
    new RegExp(`create\\s+schema\\s+(?:if\\s+not\\s+exists\\s+)?"?(\\w+)"?`, 'gi')
  )) {
    if (!registry.schemas[m[1].toLowerCase()])
      push(m.index, [`新 schema ${m[1]} 未在 registry.schemas 登记（CONTRACT §1.1）`]);
  }
  for (const m of text.matchAll(
    new RegExp(
      `create\\s+(?:unlogged\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${ident}\\s*\\(`,
      'gi'
    )
  )) {
    const table = qualified(m[1]);
    const open = m.index + m[0].length - 1;
    const close = matchParen(text, open);
    if (table.startsWith('?.')) push(m.index, [`新表 ${table.slice(2)} 没写 schema 限定名`]);
    else if (close > open)
      push(m.index, lintCreateTable(table, text.slice(open + 1, close), registry));
  }
  for (const m of text.matchAll(
    new RegExp(`alter\\s+table\\s+(?:if\\s+exists\\s+)?(?:only\\s+)?${ident}\\s+([^;]*)`, 'gi')
  )) {
    const table = qualified(m[1]);
    const actions = m[2];
    const moved = actions.match(/^\s*(?:set\s+schema\s+"?(\w+)"?|rename\s+to\s+"?(\w+)"?)/i);
    if (moved) {
      const [schema, name] = table.split('.');
      const target = moved[1]
        ? `${moved[1].toLowerCase()}.${name}`
        : `${schema}.${moved[2].toLowerCase()}`;
      if (!registry.tables[target] && !registry.tables[followRenames(text, target)])
        push(m.index, [`${table} 移动/改名为 ${target}，目标未在 registry 登记`]);
      continue;
    }
    for (const action of splitTopLevel(actions)) {
      const add = action.match(/^\s*add\s+(?:column\s+)?(?:if\s+not\s+exists\s+)?"?(\w+)"?/i);
      if (add && !CONSTRAINT_WORDS.has(add[1].toLowerCase())) {
        push(m.index, lintAddColumn(table, add[1].toLowerCase(), registry));
      }
    }
  }
  for (const m of text.matchAll(
    /drop\s+table\s+(?:if\s+exists\s+)?([\w".,\s]+?)(?:\s+cascade|\s+restrict)?\s*;/gi
  )) {
    for (const raw of m[1].split(',')) {
      const table = qualified(raw.trim());
      const entry = registry.tables[table];
      if (entry && !INACTIVE_STATUSES.has(entry.status)) {
        push(m.index, [`删除 ${table}，但 registry 仍登记为 ${entry.status}：同 PR 更新 registry`]);
      }
    }
  }
  for (const m of text.matchAll(
    new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+${ident}`, 'gi')
  )) {
    if (/_before_/i.test(m[1]))
      push(m.index, [
        `函数 ${unquote(m[1])} 是 *_before_* 包装链：改用登记表 + 单个函数（CONTRACT §2.5）`,
      ]);
  }
  return warnings;
}

function changedMigrations(base) {
  const out = execFileSync(
    'git',
    [
      'diff',
      '--name-only',
      '--diff-filter=AMR',
      `${base}...HEAD`,
      '--',
      'packages/shared/migrations',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
    }
  );
  return out
    .split('\n')
    .filter((file) => /^packages\/shared\/migrations\/[^/]+\.sql$/.test(file))
    .map((file) => join(repoRoot, file));
}

function defaultMigrations() {
  return readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql') && file.slice(0, 8) >= CONTRACT_EFFECTIVE_PREFIX)
    .map((file) => join(migrationsDir, file));
}

function selectFiles(argv) {
  const baseIndex = argv.indexOf('--base');
  if (baseIndex >= 0) {
    const base = argv[baseIndex + 1] ?? '';
    if (!base || /^0+$/.test(base)) throw new Error('缺少可比较的 base 提交');
    return changedMigrations(base);
  }
  const explicit = argv.filter((arg) => !arg.startsWith('--'));
  return explicit.length ? explicit.map((file) => join(process.cwd(), file)) : defaultMigrations();
}

function report(file, warning) {
  const path = relative(repoRoot, file);
  const message = `${warning.message}。违反契约请在 PR 描述写理由。`;
  if (process.env.GITHUB_ACTIONS)
    console.log(`::warning file=${path},line=${warning.line},title=数据库契约::${message}`);
  else console.log(`⚠ ${path}:${warning.line} ${message}`);
}

function main() {
  const registry = loadRegistry();
  const files = selectFiles(process.argv.slice(2)).filter((file) => existsSync(file));
  let count = 0;
  for (const file of files) {
    for (const warning of lintSql(readFileSync(file, 'utf8'), registry)) {
      report(file, warning);
      count += 1;
    }
  }
  console.log(`数据库契约检查：${files.length} 个 migration，${count} 条警告（只提示，不阻断）。`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    // 契约检查只提示：registry 损坏、base 不可用等自身故障也不能阻断合并。
    console.log(`::warning title=数据库契约::契约检查未能运行：${error.message}`);
  }
}
