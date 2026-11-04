#!/usr/bin/env node
/**
 * 复杂度预算：限制运行时代码的单文件行数和单函数行数。
 *
 * 为什么需要：项目大量由 AI 读写代码，超长文件/函数会迫使每次修改都通读几百行，
 * 而 AI 又倾向于往已有大文件里追加。这里用"棘轮"方式控制：
 * - 新出现的超标文件/函数直接失败（CI 阻断）；
 * - 基线里的存量超标只提示增长，不阻断；变小后用 --update 收紧基线。
 *
 * 用法：
 *   node scripts/complexity-budget.mjs check     CI 门禁
 *   node scripts/complexity-budget.mjs report    定期复盘：最大文件/函数与近 60 天改动热点
 *   node scripts/complexity-budget.mjs update    只收紧基线（删除已达标项、调低已缩小项），不放宽
 *   node scripts/complexity-budget.mjs update --allow-new   例外放行当前全部超标项（需在 PR 中说明理由）
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
const baselinePath = join(repoRoot, 'scripts', 'complexity-baseline.json');

const LIMITS = { fileLines: 500, functionLines: 120 };

// 根 package 不直接依赖 typescript；借用 shared 包已安装的版本，避免为脚本改锁文件。
const ts = createRequire(join(repoRoot, 'packages', 'shared', 'package.json'))('typescript');

const TEST_PATTERN = /(\.test\.|\.spec\.|\/__tests__\/|\/tests?\/|\.d\.ts$)/;
// 不用 git pathspec 的 `src/**/*.ts`：它要求 src 下至少一层子目录，会漏掉 src/index.ts 这类文件。
const SOURCE_PATTERN = /^packages\/[^/]+\/src\/.+\.tsx?$/;

function runtimeSourceFiles() {
  const out = execFileSync('git', ['ls-files', '--', 'packages'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .filter((file) => SOURCE_PATTERN.test(file))
    .filter(Boolean)
    .filter((file) => !TEST_PATTERN.test(file) && !file.startsWith('packages/ui-tests/'));
}

function functionName(node) {
  if (node.name && typeof node.name.getText === 'function') return node.name.getText();
  const parent = node.parent;
  if (
    parent &&
    (ts.isVariableDeclaration(parent) ||
      ts.isPropertyAssignment(parent) ||
      ts.isPropertyDeclaration(parent))
  ) {
    return parent.name.getText();
  }
  if (parent && ts.isCallExpression(parent)) {
    // 回调尽量用稳定的名字，避免在前面插入一个 hook 就让后面的 key 全部错位：
    // const send = useCallback(...) → send；app.post('/api/x', ...) → app.post('/api/x')。
    if (ts.isVariableDeclaration(parent.parent)) return parent.parent.name.getText();
    const callee = parent.expression.getText().slice(0, 40);
    const [first] = parent.arguments;
    if (first && ts.isStringLiteralLike(first)) return `${callee}('${first.text}')`;
    return `${callee}(callback)`;
  }
  if (parent && ts.isExportAssignment(parent)) return 'default';
  return '<anonymous>';
}

function measure(files = runtimeSourceFiles()) {
  const fileSizes = {};
  const functionSizes = {};
  for (const file of files) {
    const text = readFileSync(join(repoRoot, file), 'utf8');
    fileSizes[file] = text.split('\n').length;
    const source = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    );
    const seen = new Map();
    const visit = (node) => {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node)
      ) {
        const start = source.getLineAndCharacterOfPosition(node.getStart()).line;
        const end = source.getLineAndCharacterOfPosition(node.getEnd()).line;
        const lines = end - start + 1;
        // 同名函数（多个 useEffect 回调等）按出现顺序编号，保证 key 稳定且可读。
        const base = functionName(node);
        const index = (seen.get(base) ?? 0) + 1;
        seen.set(base, index);
        const key = `${file}#${index === 1 ? base : `${base}@${index}`}`;
        functionSizes[key] = lines;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { fileSizes, functionSizes };
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(baselinePath, 'utf8'));
  } catch {
    return { limits: LIMITS, files: {}, functions: {} };
  }
}

function overLimit(sizes, limit) {
  return Object.fromEntries(Object.entries(sizes).filter(([, lines]) => lines > limit));
}

function compare(current, baseline, limit) {
  const offenders = overLimit(current, limit);
  const added = [];
  const grown = [];
  for (const [key, lines] of Object.entries(offenders)) {
    const allowed = baseline[key];
    if (allowed === undefined) added.push([key, lines]);
    else if (lines > allowed) grown.push([key, lines, allowed]);
  }
  return { offenders, added, grown };
}

function check() {
  const baseline = readBaseline();
  const { fileSizes, functionSizes } = measure();
  const files = compare(fileSizes, baseline.files, LIMITS.fileLines);
  const fns = compare(functionSizes, baseline.functions, LIMITS.functionLines);

  for (const [key, lines, allowed] of [...files.grown, ...fns.grown]) {
    console.warn(
      `warning: ${key} 已在基线中，但从 ${allowed} 行增长到 ${lines} 行，修改时请顺手拆分`
    );
  }
  const added = [
    ...files.added.map(([key, lines]) => `  文件 ${key}: ${lines} 行（上限 ${LIMITS.fileLines}）`),
    ...fns.added.map(
      ([key, lines]) => `  函数 ${key}: ${lines} 行（上限 ${LIMITS.functionLines}）`
    ),
  ];
  if (added.length) {
    console.error(
      '复杂度预算未通过：出现新的超长文件/函数。请拆分；确需例外时运行 update --allow-new 并在 PR 说明理由。'
    );
    console.error(added.join('\n'));
    process.exit(1);
  }
  console.log(
    `complexity budget ok: 存量超标文件 ${Object.keys(files.offenders).length}/${Object.keys(baseline.files).length}，函数 ${Object.keys(fns.offenders).length}/${Object.keys(baseline.functions).length}`
  );
}

function update(allowNew) {
  const baseline = readBaseline();
  const { fileSizes, functionSizes } = measure();
  const tighten = (current, previous, limit) => {
    const next = {};
    for (const [key, lines] of Object.entries(overLimit(current, limit))) {
      if (previous[key] !== undefined) next[key] = Math.min(previous[key], lines);
      else if (allowNew) next[key] = lines;
    }
    return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)));
  };
  const next = {
    limits: LIMITS,
    files: tighten(fileSizes, baseline.files, LIMITS.fileLines),
    functions: tighten(functionSizes, baseline.functions, LIMITS.functionLines),
  };
  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `baseline: 文件 ${Object.keys(next.files).length} 项，函数 ${Object.keys(next.functions).length} 项`
  );
}

function report() {
  const { fileSizes, functionSizes } = measure();
  const top = (sizes, n) =>
    Object.entries(sizes)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n);
  const totalLines = Object.values(fileSizes).reduce((sum, lines) => sum + lines, 0);
  const fnValues = Object.values(functionSizes);
  console.log(`运行时代码：${Object.keys(fileSizes).length} 个文件，${totalLines} 行`);
  console.log(
    `函数 >300 行: ${fnValues.filter((v) => v > 300).length}，>150: ${fnValues.filter((v) => v > 150).length}，>${LIMITS.functionLines}: ${fnValues.filter((v) => v > LIMITS.functionLines).length}`
  );
  console.log(
    `文件 >800 行: ${Object.values(fileSizes).filter((v) => v > 800).length}，>${LIMITS.fileLines}: ${Object.values(fileSizes).filter((v) => v > LIMITS.fileLines).length}`
  );
  console.log('\n最长函数：');
  for (const [key, lines] of top(functionSizes, 20))
    console.log(`  ${String(lines).padStart(5)}  ${key}`);

  // 大且常改的文件最值得优先拆：近 60 天提交次数 × 行数。
  const churn = {};
  const log = execFileSync(
    'git',
    ['log', '--since=60.days', '--name-only', '--format=', '--', 'packages'],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }
  );
  for (const file of log.split('\n')) if (fileSizes[file]) churn[file] = (churn[file] ?? 0) + 1;
  console.log('\n改动热点（近 60 天提交数 × 行数）：');
  for (const [file, commits] of Object.entries(churn)
    .sort((a, b) => b[1] * fileSizes[b[0]] - a[1] * fileSizes[a[0]])
    .slice(0, 15)) {
    console.log(
      `  ${String(commits).padStart(3)} 次  ${String(fileSizes[file]).padStart(5)} 行  ${file}`
    );
  }
}

const command = process.argv[2] ?? 'check';
if (command === 'check') check();
else if (command === 'update') update(process.argv.includes('--allow-new'));
else if (command === 'report') report();
else {
  console.error(`未知命令: ${command}（check | update | report）`);
  process.exit(2);
}
